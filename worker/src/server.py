"""Image Studio pod server (MODE=pod, docs/spec.md "v3 change").

A small HTTP server on 0.0.0.0:8000 that is API-compatible with RunPod
serverless, so the app only swaps its base URL and token:

  POST /run              {input, policy?}  -> {id, status: "IN_QUEUE"}
  GET  /status/{id}      -> {id, status, output?, delayTime, executionTime, error?}
  POST /cancel/{id}      -> {id, status}
  GET  /health           -> {jobs, workers, ready, gpu, comfyui, watchdog, code?}
  GET  /ping             -> {status: "ok"}  (no auth; liveness)

Every route is also served under /v2/{anything}/..., the serverless URL shape.
All routes except /ping need `Authorization: Bearer $API_TOKEN`.

Execution: `generate` jobs run one at a time in FIFO order (one GPU); other
actions (status/download/delete) run on a separate executor, concurrently with
generation. Both reuse handler.handler() unchanged; progress reaches the job
record through the job's "_progress" hook, and cancellation through "_cancel".

Idle watchdog: when no authenticated request has arrived for IDLE_MINUTES
(and no job is active or recently finished), the pod terminates itself through
the RunPod API (see Terminator). It never exits the process; a failed
terminate is retried every RETRY_S while the pod stays idle.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable

import requests
from aiohttp import web

import handler as worker

log = logging.getLogger("image_studio.server")

PORT = int(os.environ.get("PORT", "8000"))
JOB_TTL_S = 30 * 60
AUX_WORKERS = 4
MAX_BODY_BYTES = 32 * 1024 * 1024  # references can make /run ~10 MB
GENERATE_ACTIONS = frozenset({"generate"})

IN_QUEUE, IN_PROGRESS = "IN_QUEUE", "IN_PROGRESS"
COMPLETED, FAILED, CANCELLED, TIMED_OUT = "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"
TERMINAL = frozenset({COMPLETED, FAILED, CANCELLED, TIMED_OUT})


def _ms(seconds: float) -> int:
    return max(0, int(round(seconds * 1000)))


def split_result(result: Any) -> tuple[Any, str | None]:
    """Same mapping as runpod-python's run_job (rp_job.py): a dict's "error"
    key becomes the job error, the rest is the output, and an empty dict
    output is dropped. So a failed job is {status: FAILED, error: "..."}
    with no `output`, exactly as on serverless."""
    if isinstance(result, dict):
        result = dict(result)
        error = result.pop("error", None)
        result.pop("refresh_worker", None)
        output = result if result != {} else None
        return output, (str(error) if error else None)
    return result, None


# ---------------------------------------------------------------------------
# jobs
# ---------------------------------------------------------------------------
@dataclass
class Job:
    id: str
    input: dict
    action: str
    created: float
    timeout_s: float | None = None
    status: str = IN_QUEUE
    output: Any = None
    error: str | None = None
    started: float | None = None
    finished: float | None = None
    cancel: threading.Event = field(default_factory=threading.Event)

    def view(self, now: float) -> dict:
        start = self.started if self.started is not None else (self.finished or now)
        end = self.finished if self.finished is not None else now
        out: dict[str, Any] = {
            "id": self.id,
            "status": self.status,
            "delayTime": _ms(start - self.created),
            "executionTime": _ms(end - self.started) if self.started is not None else 0,
        }
        if self.output is not None:
            out["output"] = self.output
        if self.error is not None:
            out["error"] = self.error
        return out


class JobManager:
    """Thread-based job queue; the HTTP layer only calls its (fast) methods.

    run_job(job_dict) -> result dict   (default: handler.handler)
    interrupt()                        (default: ComfyUI POST /interrupt)
    """

    def __init__(self, run_job: Callable[[dict], Any] | None = None,
                 interrupt: Callable[[], Any] | None = None,
                 clock: Callable[[], float] = time.monotonic,
                 ttl_s: float = JOB_TTL_S, aux_workers: int = AUX_WORKERS):
        self.run_job = run_job or worker.handler
        self.interrupt = interrupt or (lambda: worker.make_client().interrupt())
        self.clock = clock
        self.ttl_s = ttl_s
        self.jobs: dict[str, Job] = {}
        self.lock = threading.RLock()
        self.last_finished: float | None = None
        self._gen_queue: queue.Queue[Job | None] = queue.Queue()
        self._aux = ThreadPoolExecutor(max_workers=aux_workers, thread_name_prefix="aux")
        self._gen_thread = threading.Thread(target=self._generate_loop, name="generate",
                                            daemon=True)
        self._gen_thread.start()

    # ---- submission ------------------------------------------------------
    def submit(self, inp: dict, policy: dict | None = None) -> Job:
        action = inp.get("action")
        timeout_s = None
        if isinstance(policy, dict):
            t = policy.get("executionTimeout")
            if isinstance(t, (int, float)) and not isinstance(t, bool) and t > 0:
                timeout_s = t / 1000.0
        job = Job(id=f"pod-{uuid.uuid4()}", input=inp, action=str(action),
                  created=self.clock(), timeout_s=timeout_s)
        with self.lock:
            self.jobs[job.id] = job
        if action in GENERATE_ACTIONS:
            self._gen_queue.put(job)
        else:
            self._aux.submit(self._execute, job)
        log.info("job %s queued (action=%s)", job.id, job.action)
        return job

    def _generate_loop(self) -> None:
        while True:
            job = self._gen_queue.get()
            if job is None:
                return
            self._execute(job)

    def _execute(self, job: Job) -> None:
        with self.lock:
            if job.status != IN_QUEUE:  # cancelled while queued
                return
            job.status = IN_PROGRESS
            job.started = self.clock()

        def progress(payload: Any) -> None:
            snap = json.loads(json.dumps(payload))  # detach from the caller's dicts
            with self.lock:
                if job.status == IN_PROGRESS:
                    job.output = snap

        job_dict = {"id": job.id, "input": job.input,
                    worker.PROGRESS_HOOK: progress, worker.CANCEL_EVENT: job.cancel}
        try:
            result = self.run_job(job_dict)
            output, error = split_result(result)
        except Exception as exc:  # handler.handler never raises; belt and braces
            log.exception("job %s raised", job.id)
            output, error = None, f"INTERNAL_ERROR: {type(exc).__name__}: {exc}"
        with self.lock:
            now = self.clock()
            self.last_finished = now
            if job.status != IN_PROGRESS:  # cancelled / timed out meanwhile
                return
            job.finished = now
            job.output = output
            job.error = error
            job.status = FAILED if error else COMPLETED
        log.info("job %s %s in %d ms", job.id, job.status, _ms(job.finished - job.started))

    # ---- queries / control ----------------------------------------------
    def get(self, job_id: str) -> Job | None:
        with self.lock:
            return self.jobs.get(job_id)

    def view(self, job_id: str) -> dict | None:
        with self.lock:
            job = self.jobs.get(job_id)
            return job.view(self.clock()) if job else None

    def cancel(self, job_id: str, status: str = CANCELLED) -> dict | None:
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None:
                return None
            if job.status in TERMINAL:
                return {"id": job.id, "status": job.status}
            was_running = job.status == IN_PROGRESS
            job.status = status
            job.finished = self.clock()
            job.output = None
            job.cancel.set()
        log.info("job %s %s (%s)", job.id, status, "running" if was_running else "queued")
        if was_running and job.action in GENERATE_ACTIONS:
            try:
                self.interrupt()
            except Exception:
                log.exception("ComfyUI interrupt failed")
        return {"id": job.id, "status": job.status}

    def counts(self) -> dict:
        with self.lock:
            st = [j.status for j in self.jobs.values()]
        return {"inQueue": st.count(IN_QUEUE), "inProgress": st.count(IN_PROGRESS),
                "completed": st.count(COMPLETED), "failed": st.count(FAILED)}

    def active(self) -> int:
        with self.lock:
            return sum(1 for j in self.jobs.values() if j.status in (IN_QUEUE, IN_PROGRESS))

    def sweep(self) -> None:
        """Drops finished jobs older than ttl_s; times out over-long jobs."""
        now = self.clock()
        overdue = []
        with self.lock:
            for jid, job in list(self.jobs.items()):
                if job.status in TERMINAL and job.finished is not None \
                        and now - job.finished >= self.ttl_s:
                    del self.jobs[jid]
                elif job.status == IN_PROGRESS and job.timeout_s is not None \
                        and now - job.started >= job.timeout_s:
                    overdue.append(jid)
        for jid in overdue:
            self.cancel(jid, status=TIMED_OUT)

    def shutdown(self) -> None:
        self._gen_queue.put(None)
        self._aux.shutdown(wait=False, cancel_futures=True)


# ---------------------------------------------------------------------------
# idle watchdog
# ---------------------------------------------------------------------------
REST_V2 = "https://api.runpod.io/v2/pods/{id}"   # docs.runpod.io/api-reference-v2/pods/terminate-a-pod
REST_V1 = "https://rest.runpod.io/v1/pods/{id}"
KEY_ENVS = ("RUNPOD_TERMINATE_API_KEY", "RUNPOD_API_KEY")
RETRY_S = 300.0  # wait between terminate attempts while the pod stays idle


@dataclass
class ArmCheck:
    """Result of Terminator.verify(). Never holds a key value, only env names."""
    armed: bool
    key: str | None = None
    error: str | None = None


class Terminator:
    """Terminates this pod via the RunPod API.

    Keys, in order: RUNPOD_TERMINATE_API_KEY (optional, passed by the app),
    then RUNPOD_API_KEY (the pod-scoped key RunPod injects into every pod;
    its permissions are undocumented). A key that verify() found able to read
    this pod is tried first. Calls DELETE /v2/pods/{id} (204), then REST v1,
    then `runpodctl` if installed. Keys are never logged.
    """

    def __init__(self, env: dict | None = None,
                 delete: Callable[..., Any] = requests.delete,
                 which: Callable[[str], str | None] = shutil.which,
                 run: Callable[..., Any] = subprocess.run,
                 get: Callable[..., Any] = requests.get):
        self.env = os.environ if env is None else env
        self.delete = delete
        self.get = get
        self.which = which
        self.run = run
        self.preferred: str | None = None  # env name of the key verify() confirmed

    def _keys(self) -> list[tuple[str, str]]:
        keys = [(name, self.env[name]) for name in KEY_ENVS if self.env.get(name)]
        if self.preferred:
            keys.sort(key=lambda nk: nk[0] != self.preferred)  # stable: preferred first
        return keys

    def verify(self) -> ArmCheck:
        """Checks that some key can see this pod (GET /v2/pods/{id}).

        A 2xx proves the key can read the pod, not that it may DELETE it;
        callers report this as armed with check "read". The first key that
        works becomes the preferred key for terminate()."""
        pod_id = self.env.get("RUNPOD_POD_ID")
        if not pod_id:
            return ArmCheck(False, error="RUNPOD_POD_ID is not set")
        keys = self._keys()
        if not keys:
            return ArmCheck(False, error=f"no RunPod API key ({' / '.join(KEY_ENVS)}) in env")
        url = REST_V2.format(id=pod_id)
        errors = []
        for name, key in keys:
            try:
                r = self.get(url, headers={"Authorization": f"Bearer {key}"}, timeout=30)
                code = r.status_code
            except requests.RequestException as exc:
                errors.append(f"{name}: {type(exc).__name__}")
                continue
            if 200 <= code < 300:
                self.preferred = name
                return ArmCheck(True, key=name)
            errors.append(f"{name}: HTTP {code}")
        return ArmCheck(False, error=f"GET {url} failed for every key ({'; '.join(errors)})")

    def terminate(self) -> bool:
        pod_id = self.env.get("RUNPOD_POD_ID")
        if not pod_id:
            log.warning("idle shutdown: RUNPOD_POD_ID is not set; cannot terminate the pod")
            return False
        keys = self._keys()
        if not keys:
            log.warning("idle shutdown: no RunPod API key (%s) in env", " / ".join(KEY_ENVS))
        for name, key in keys:
            for tmpl in (REST_V2, REST_V1):
                url = tmpl.format(id=pod_id)
                try:
                    r = self.delete(url, headers={"Authorization": f"Bearer {key}"}, timeout=30)
                    code = r.status_code
                except requests.RequestException as exc:
                    log.warning("idle shutdown: DELETE %s with %s failed: %s",
                                url, name, type(exc).__name__)
                    continue
                if 200 <= code < 300:
                    # A 2xx DELETE is RunPod accepting the termination; the
                    # platform kills this container shortly after.
                    log.warning("idle shutdown: pod %s terminated via %s (key from %s, HTTP %d)",
                                pod_id, url, name, code)
                    return True
                log.warning("idle shutdown: DELETE %s with %s -> HTTP %d", url, name, code)
        cli = self.which("runpodctl")
        if cli:
            for args in ([cli, "pod", "delete", pod_id], [cli, "remove", "pod", pod_id]):
                try:
                    p = self.run(args, capture_output=True, timeout=60)
                    if p.returncode == 0:
                        log.warning("idle shutdown: pod %s terminated via %s", pod_id,
                                    " ".join(args[1:3]))
                        return True
                    log.warning("idle shutdown: %s exited %d", " ".join(args[1:3]), p.returncode)
                except (OSError, subprocess.SubprocessError) as exc:
                    log.warning("idle shutdown: runpodctl failed: %s", type(exc).__name__)
        return False


class IdleWatchdog:
    """Terminates the pod after idle_s without requests or jobs.

    It never exits the process: if a container exit made RunPod restart it,
    the idle timer would reset and the pod would bill forever. On a failed
    terminate it stays up, logs, and retries every retry_s while still idle.
    Any authenticated request or active job resets the attempt state."""

    def __init__(self, manager: JobManager, idle_s: float,
                 terminate: Callable[[], bool],
                 verify: Callable[[], ArmCheck] | None = None,
                 retry_s: float = RETRY_S,
                 clock: Callable[[], float] = time.monotonic):
        self.manager = manager
        self.idle_s = idle_s
        self.terminate = terminate
        self._verify = verify
        self.retry_s = retry_s
        self.clock = clock
        self.lock = threading.Lock()
        self.last_request = clock()
        self.generation = 0                    # bumped on every reset
        self.fired = False                     # a terminate call succeeded
        self.attempts = 0                      # failed attempts in this idle period
        self.next_attempt: float | None = None
        self.last_error: str | None = None
        self.armed = False
        self.armed_key: str | None = None      # env var name, never the value
        self.armed_error: str | None = None
        self.armed_check = "pending"           # pending | read | failed | disabled

    # ---- arm check -------------------------------------------------------
    def verify(self) -> None:
        """Run once at startup (background thread): can a key see this pod?"""
        if self.idle_s <= 0:
            self.armed_check = "disabled"
            return
        if self._verify is None:
            return
        try:
            res = self._verify()
        except Exception as exc:  # never let the arm check kill the server
            res = ArmCheck(False, error=f"verify raised {type(exc).__name__}")
        self.armed, self.armed_key, self.armed_error = res.armed, res.key, res.error
        self.armed_check = "read" if res.armed else "failed"
        if res.armed:
            log.info("idle watchdog armed: %s can read this pod (DELETE permission unverified)",
                     res.key)
        else:
            log.warning("idle watchdog NOT armed: %s. The pod cannot terminate itself; "
                        "it bills until the app or the user terminates it.", res.error)

    def status(self) -> dict:
        return {"armed": self.armed, "check": self.armed_check,
                "idleMinutes": self.idle_s / 60, "idleForS": int(self.idle_for()),
                "lastError": self.last_error or self.armed_error}

    # ---- idle tracking ---------------------------------------------------
    def _reset(self) -> None:
        self.generation += 1  # invalidates the outcome of an in-flight attempt
        self.fired = False
        self.attempts = 0
        self.next_attempt = None
        self.last_error = None

    def touch(self) -> None:
        # Called on the event loop: only takes the lock, which check() never
        # holds across the (slow) terminate call.
        with self.lock:
            self.last_request = self.clock()
            if self.attempts or self.fired:
                log.info("idle shutdown: request received; pod in use again, retry state reset")
            self._reset()

    def idle_for(self) -> float:
        last = self.last_request
        if self.manager.last_finished is not None:
            last = max(last, self.manager.last_finished)
        return self.clock() - last

    def check(self) -> bool:
        """Returns True if it attempted to terminate the pod on this call."""
        if self.idle_s <= 0:
            return False
        with self.lock:
            if self.manager.active() or self.idle_for() < self.idle_s:
                if self.attempts or self.fired:
                    self._reset()  # a job started: the pod is in use again
                return False
            if self.fired:
                return False
            now = self.clock()
            if self.next_attempt is not None and now < self.next_attempt:
                return False
            self.attempts += 1
            attempt, gen = self.attempts, self.generation
            # Block concurrent attempts until this one is recorded.
            self.next_attempt = now + self.retry_s
            idle_min = self.idle_for() / 60
        log.warning("idle shutdown: no requests for %.0f min and no active jobs; "
                    "terminating pod (attempt %d)", idle_min, attempt)
        ok = self.terminate()
        with self.lock:
            if gen != self.generation:  # a request arrived meanwhile; state was reset
                return True
            if ok:
                self.fired = True
                self.next_attempt = None
                self.last_error = None
            else:
                self.last_error = (f"terminate failed ({attempt} attempt(s)); "
                                   f"retrying every {self.retry_s:g} s while idle")
        if ok:
            log.warning("idle shutdown: terminate accepted by RunPod; waiting for the "
                        "platform to stop this pod")
        else:
            log.warning("idle shutdown: attempt %d could not terminate the pod through the "
                        "RunPod API. The pod is STILL BILLING. Staying up and retrying in "
                        "%g s while idle (the app-side auto-stop still applies).",
                        attempt, self.retry_s)
        return True


# ---------------------------------------------------------------------------
# health
# ---------------------------------------------------------------------------
def gpu_name() -> str:
    try:
        p = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                           capture_output=True, text=True, timeout=10)
        if p.returncode == 0 and p.stdout.strip():
            return p.stdout.strip().splitlines()[0].strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return ""


CODE_INFO_ENV = "IMAGE_STUDIO_CODE_INFO"


def code_info() -> dict | None:
    """Which worker code is running, as written by worker/boot/boot.py (runtime
    image, spec "v4"): {source: "github"|"baked", ref, commit[, error]}.
    None (no `code` in /health) on the legacy image, which has no boot.py."""
    path = os.environ.get(CODE_INFO_ENV)
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    out = {k: data.get(k) for k in ("source", "ref", "commit")}
    if data.get("error"):
        out["error"] = str(data["error"])
    return out


class Health:
    def __init__(self, manager: JobManager, comfy_up: Callable[[], bool] | None = None,
                 gpu: Callable[[], str] = gpu_name,
                 comfy_version: Callable[[], str | None] = worker.comfyui_version,
                 code: Callable[[], dict | None] = code_info):
        self.manager = manager
        self.comfy_up = comfy_up or (lambda: worker.make_client().is_up())
        self._gpu_fn = gpu
        self._gpu: str | None = None
        self.comfy_version = comfy_version
        self._code_fn = code
        self._code: dict | None = None
        self._code_read = False

    def payload(self) -> dict:
        if self._gpu is None:
            self._gpu = self._gpu_fn()
        counts = self.manager.counts()
        running = 1 if counts["inProgress"] else 0
        if not self._code_read:  # fixed for the life of the process
            self._code = self._code_fn()
            self._code_read = True
        out = {"jobs": counts, "workers": {"idle": 1 - running, "running": running},
               "ready": bool(self.comfy_up()), "gpu": self._gpu,
               "comfyui": self.comfy_version() or ""}
        if self._code is not None:
            out["code"] = self._code
        return out


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
def _json(data: Any, status: int = 200) -> web.Response:
    return web.json_response(data, status=status)


def build_app(token: str, manager: JobManager, health: Health,
              watchdog: IdleWatchdog | None = None) -> web.Application:
    if not token:
        raise ValueError("API_TOKEN is required")
    expected = f"Bearer {token}".encode()

    @web.middleware
    async def auth(request: web.Request, handler):
        if request.path == "/ping":
            return await handler(request)
        got = request.headers.get("Authorization", "").encode()
        if not hmac.compare_digest(got, expected):
            return _json({"error": "unauthorized"}, 401)
        if watchdog is not None:
            watchdog.touch()
        return await handler(request)

    async def run(request: web.Request):
        try:
            body = await request.json()
        except (ValueError, UnicodeDecodeError):
            return _json({"error": "invalid JSON body"}, 400)
        if not isinstance(body, dict) or not isinstance(body.get("input"), dict):
            return _json({"error": "body must be {\"input\": {...}}"}, 400)
        job = manager.submit(body["input"], body.get("policy"))
        return _json({"id": job.id, "status": IN_QUEUE})

    async def status(request: web.Request):
        manager.sweep()
        v = manager.view(request.match_info["id"])
        return _json(v) if v else _json({"error": "job not found"}, 404)

    async def cancel(request: web.Request):
        v = await asyncio.get_running_loop().run_in_executor(
            None, manager.cancel, request.match_info["id"])
        return _json(v) if v else _json({"error": "job not found"}, 404)

    async def health_route(request: web.Request):
        manager.sweep()
        payload = await asyncio.get_running_loop().run_in_executor(None, health.payload)
        if watchdog is not None:
            payload["watchdog"] = watchdog.status()
        return _json(payload)

    async def ping(request: web.Request):
        return _json({"status": "ok"})

    app = web.Application(middlewares=[auth], client_max_size=MAX_BODY_BYTES)
    for prefix in ("", "/v2/{endpoint}"):
        app.router.add_post(prefix + "/run", run)
        app.router.add_get(prefix + "/status/{id}", status)
        app.router.add_post(prefix + "/cancel/{id}", cancel)
        app.router.add_get(prefix + "/health", health_route)
    app.router.add_get("/ping", ping)
    return app


def _background(manager: JobManager, watchdog: IdleWatchdog, interval_s: float = 30.0) -> None:
    while True:
        time.sleep(interval_s)
        try:
            manager.sweep()
            watchdog.check()
        except Exception:
            log.exception("background check failed")


def main() -> None:
    logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    token = os.environ.get("API_TOKEN", "")
    if not token.strip():
        log.error("API_TOKEN is not set; refusing to start the pod server")
        sys.exit(2)
    try:
        idle_minutes = float(os.environ.get("IDLE_MINUTES", "30"))
    except ValueError:
        idle_minutes = 30.0
    manager = JobManager()
    terminator = Terminator()
    watchdog = IdleWatchdog(manager, idle_minutes * 60, terminator.terminate,
                            verify=terminator.verify)
    app = build_app(token, manager, Health(manager), watchdog)
    threading.Thread(target=watchdog.verify, name="watchdog-verify", daemon=True).start()
    threading.Thread(target=_background, args=(manager, watchdog), name="watchdog",
                     daemon=True).start()
    log.info("pod server on 0.0.0.0:%d (idle shutdown after %g min; pod %s; keys: %s)",
             PORT, idle_minutes, os.environ.get("RUNPOD_POD_ID", "?"),
             ", ".join(n for n in KEY_ENVS if os.environ.get(n)) or "none")
    web.run_app(app, host="0.0.0.0", port=PORT, access_log=None, print=None)


if __name__ == "__main__":
    main()
