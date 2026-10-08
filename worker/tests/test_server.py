"""Pod server (MODE=pod): HTTP API, job queue, cancel, expiry, idle watchdog."""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
import requests
from aiohttp import web

import handler
import server

TOKEN = "test-token-0123456789abcdef"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


class FakeClock:
    def __init__(self, t: float = 1000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, s: float) -> None:
        self.t += s


class Running:
    """Serves an aiohttp app on 127.0.0.1:<random> in a background loop."""

    def __init__(self, app: web.Application):
        self.loop = asyncio.new_event_loop()
        self.runner = web.AppRunner(app)
        ready = threading.Event()

        def run():
            asyncio.set_event_loop(self.loop)
            self.loop.run_until_complete(self.runner.setup())
            site = web.TCPSite(self.runner, "127.0.0.1", 0)
            self.loop.run_until_complete(site.start())
            self.port = site._server.sockets[0].getsockname()[1]
            ready.set()
            self.loop.run_forever()

        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()
        assert ready.wait(10)
        self.base = f"http://127.0.0.1:{self.port}"

    def get(self, path, auth=True, **kw):
        return requests.get(self.base + path, headers=AUTH if auth else {}, timeout=10, **kw)

    def post(self, path, auth=True, **kw):
        return requests.post(self.base + path, headers=AUTH if auth else {}, timeout=10, **kw)

    def close(self):
        asyncio.run_coroutine_threadsafe(self.runner.cleanup(), self.loop).result(10)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(10)


class Actions:
    """Fake run_job: each job blocks until released; can emit progress."""

    def __init__(self):
        self.gates: dict[str, threading.Event] = {}
        self.started: list[str] = []
        self.running: set[str] = set()
        self.max_parallel_generate = 0
        self.lock = threading.Lock()
        self.interrupts = 0

    def gate(self, tag: str) -> threading.Event:
        with self.lock:
            return self.gates.setdefault(tag, threading.Event())

    def interrupt(self):
        self.interrupts += 1
        for g in list(self.gates.values()):
            g.set()

    def __call__(self, job: dict):
        inp = job["input"]
        tag = inp.get("tag", job["id"])
        with self.lock:
            self.started.append(tag)
            self.running.add(tag)
            gen = [t for t in self.running if t.startswith("gen")]
            self.max_parallel_generate = max(self.max_parallel_generate, len(gen))
        try:
            if inp.get("progress"):
                job["_progress"](inp["progress"])
            if inp.get("raise"):
                raise RuntimeError("boom")
            self.gate(tag).wait(10)
            if inp.get("cooperative") and job["_cancel"].is_set():
                return {"error": "CANCELLED: x"}
            if "result" in inp:
                return inp["result"]
            return {"ok": tag}
        finally:
            with self.lock:
                self.running.discard(tag)


@pytest.fixture
def env():
    clock = FakeClock()
    actions = Actions()
    mgr = server.JobManager(run_job=actions, interrupt=actions.interrupt, clock=clock)
    health = server.Health(mgr, comfy_up=lambda: True, gpu=lambda: "RTX PRO 6000",
                           comfy_version=lambda: "0.39.0")
    srv = Running(server.build_app(TOKEN, mgr, health))
    yield srv, mgr, actions, clock
    for g in list(actions.gates.values()):
        g.set()
    srv.close()
    mgr.shutdown()


def wait_for(fn, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.01)
    raise AssertionError("condition not met")


def status(srv, jid):
    r = srv.get(f"/status/{jid}")
    assert r.status_code == 200, r.text
    return r.json()


def run(srv, inp, **body):
    r = srv.post("/run", json={"input": inp, **body})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["status"] == "IN_QUEUE" and b["id"]
    return b["id"]


# ---------------------------------------------------------------------------
# auth
# ---------------------------------------------------------------------------
def test_auth_required_everywhere_except_ping(env):
    srv, *_ = env
    assert srv.get("/ping", auth=False).status_code == 200
    for method, path in [("get", "/health"), ("get", "/status/x"), ("post", "/run"),
                         ("post", "/cancel/x"), ("get", "/v2/abc/health")]:
        r = getattr(srv, method)(path, auth=False)
        assert r.status_code == 401, path
        r = requests.request(method.upper(), srv.base + path, timeout=5,
                             headers={"Authorization": "Bearer wrong"})
        assert r.status_code == 401, path
        r = requests.request(method.upper(), srv.base + path, timeout=5,
                             headers={"Authorization": TOKEN})  # no "Bearer "
        assert r.status_code == 401, path
    assert srv.get("/health").status_code == 200


def test_build_app_refuses_empty_token():
    mgr = server.JobManager(run_job=lambda j: {})
    with pytest.raises(ValueError):
        server.build_app("", mgr, server.Health(mgr))
    mgr.shutdown()


def test_server_refuses_to_start_without_api_token(tmp_path):
    src = Path(__file__).resolve().parents[1] / "src"
    env = {k: v for k, v in os.environ.items() if k != "API_TOKEN"}
    env.update(MODE="pod", PYTHONPATH=str(src), PORT="0")
    p = subprocess.run([sys.executable, str(src / "handler.py")], env=env, cwd=tmp_path,
                       capture_output=True, text=True, timeout=60)
    assert p.returncode == 2
    assert "API_TOKEN is not set" in p.stdout + p.stderr


def test_v2_prefixed_routes(env):
    srv, mgr, actions, clock = env
    r = srv.post("/v2/endpoint/run", json={"input": {"action": "status", "tag": "s"}})
    jid = r.json()["id"]
    actions.gate("s").set()
    wait_for(lambda: srv.get(f"/v2/endpoint/status/{jid}").json()["status"] == "COMPLETED")


def test_bad_bodies(env):
    srv, *_ = env
    assert srv.post("/run", data="nope").status_code == 400
    assert srv.post("/run", json={"x": 1}).status_code == 400
    assert srv.get("/status/unknown").status_code == 404
    assert srv.post("/cancel/unknown").status_code == 404


# ---------------------------------------------------------------------------
# lifecycle
# ---------------------------------------------------------------------------
def test_run_status_lifecycle_with_progress_and_timings(env):
    srv, mgr, actions, clock = env
    # Block the generate lane so the job under test waits in the queue.
    blocker = run(srv, {"action": "generate", "tag": "gen0"})
    wait_for(lambda: "gen0" in actions.started)
    jid = run(srv, {"action": "generate", "tag": "gen1",
                    "progress": {"phase": "sampling", "step": 3, "totalSteps": 8}})
    s = status(srv, jid)
    assert s["status"] == "IN_QUEUE" and "output" not in s and s["executionTime"] == 0

    clock.advance(2.0)  # 2 s queued
    actions.gate("gen0").set()
    wait_for(lambda: status(srv, jid)["status"] == "IN_PROGRESS")
    s = wait_for(lambda: (lambda v: v if v.get("output") else None)(status(srv, jid)))
    assert s["output"] == {"phase": "sampling", "step": 3, "totalSteps": 8}
    assert s["delayTime"] == 2000

    clock.advance(1.5)  # 1.5 s running
    actions.gate("gen1").set()
    s = wait_for(lambda: (lambda v: v if v["status"] == "COMPLETED" else None)(status(srv, jid)))
    assert s == {"id": jid, "status": "COMPLETED", "delayTime": 2000,
                 "executionTime": 1500, "output": {"ok": "gen1"}}
    assert status(srv, blocker)["status"] == "COMPLETED"


def test_generate_jobs_run_fifo_one_at_a_time(env):
    srv, mgr, actions, clock = env
    ids = [run(srv, {"action": "generate", "tag": f"gen{i}"}) for i in range(4)]
    for i in range(4):
        wait_for(lambda: f"gen{i}" in actions.started)
        time.sleep(0.05)
        assert actions.started == [f"gen{k}" for k in range(i + 1)]  # strictly in order
        actions.gate(f"gen{i}").set()
    for jid in ids:
        wait_for(lambda: status(srv, jid)["status"] == "COMPLETED")
    assert actions.max_parallel_generate == 1


def test_download_runs_while_generate_is_running(env):
    srv, mgr, actions, clock = env
    g = run(srv, {"action": "generate", "tag": "gen"})
    wait_for(lambda: "gen" in actions.started)
    d = run(srv, {"action": "download", "tag": "dl",
                  "progress": {"phase": "downloading", "bytes": 5, "totalBytes": 10}})
    s = run(srv, {"action": "status", "tag": "st"})
    wait_for(lambda: {"dl", "st"} <= set(actions.started))
    assert status(srv, g)["status"] == "IN_PROGRESS"
    assert status(srv, d)["output"]["phase"] == "downloading"
    h = srv.get("/health").json()
    assert h["jobs"]["inProgress"] == 3 and h["workers"] == {"idle": 0, "running": 1}
    actions.gate("dl").set()
    actions.gate("st").set()
    wait_for(lambda: status(srv, d)["status"] == "COMPLETED")
    wait_for(lambda: status(srv, s)["status"] == "COMPLETED")
    assert status(srv, g)["status"] == "IN_PROGRESS"  # generate still busy
    actions.gate("gen").set()
    wait_for(lambda: status(srv, g)["status"] == "COMPLETED")


def test_health_payload(env):
    srv, mgr, actions, clock = env
    h = srv.get("/health").json()
    assert h == {"jobs": {"inQueue": 0, "inProgress": 0, "completed": 0, "failed": 0},
                 "workers": {"idle": 1, "running": 0}, "ready": True,
                 "gpu": "RTX PRO 6000", "comfyui": "0.39.0"}


# ---------------------------------------------------------------------------
# cancel
# ---------------------------------------------------------------------------
def test_cancel_queued_job(env):
    srv, mgr, actions, clock = env
    run(srv, {"action": "generate", "tag": "gen0"})
    wait_for(lambda: "gen0" in actions.started)
    q = run(srv, {"action": "generate", "tag": "gen1"})
    clock.advance(3)
    r = srv.post(f"/cancel/{q}")
    assert r.json() == {"id": q, "status": "CANCELLED"}
    actions.gate("gen0").set()
    time.sleep(0.2)
    assert "gen1" not in actions.started  # never ran
    s = status(srv, q)
    assert s["status"] == "CANCELLED" and s["delayTime"] == 3000 and s["executionTime"] == 0
    assert actions.interrupts == 0


def test_cancel_running_generate_interrupts_comfyui(env):
    srv, mgr, actions, clock = env
    g = run(srv, {"action": "generate", "tag": "gen0",
                  "progress": {"phase": "sampling", "step": 1, "totalSteps": 8}})
    nxt = run(srv, {"action": "generate", "tag": "gen1"})
    wait_for(lambda: status(srv, g)["status"] == "IN_PROGRESS")
    assert srv.post(f"/cancel/{g}").json()["status"] == "CANCELLED"
    assert actions.interrupts == 1
    s = status(srv, g)
    assert s["status"] == "CANCELLED" and "output" not in s
    wait_for(lambda: "gen1" in actions.started)  # queue moves on after the interrupt
    actions.gate("gen1").set()
    wait_for(lambda: status(srv, nxt)["status"] == "COMPLETED")
    assert status(srv, g)["status"] == "CANCELLED"  # late result ignored
    # cancelling a finished job is a no-op that reports its status
    assert srv.post(f"/cancel/{nxt}").json() == {"id": nxt, "status": "COMPLETED"}


def test_cancel_running_download_sets_cancel_event(env):
    srv, mgr, actions, clock = env
    d = run(srv, {"action": "download", "tag": "dl", "cooperative": True})
    wait_for(lambda: "dl" in actions.started)
    srv.post(f"/cancel/{d}")
    assert mgr.get(d).cancel.is_set()
    assert actions.interrupts == 0  # downloads don't touch ComfyUI
    actions.gate("dl").set()
    wait_for(lambda: not actions.running)
    assert status(srv, d)["status"] == "CANCELLED"


def test_download_cancel_is_cooperative_in_handler(tmp_path, monkeypatch, file_server):
    """The real handler stops a download at the next chunk when _cancel is set."""
    monkeypatch.setattr(handler, "MODELS_ROOT", tmp_path)
    monkeypatch.setenv("IMAGE_STUDIO_ALLOW_HTTP", "1")
    url = file_server.url("/big.safetensors")
    file_server.add("/big.safetensors", b"x" * (4 * 65536), chunk_delay=0.2)
    ev = threading.Event()
    got = []

    def progress(p):
        got.append(p)
        if p.get("bytes"):
            ev.set()

    cancel = threading.Event()
    job = {"id": "j", "_progress": progress, "_cancel": cancel,
           "input": {"action": "download",
                     "files": [{"folder": "vae", "filename": "big.safetensors", "url": url}]}}
    monkeypatch.setattr(handler, "PROGRESS_MIN_INTERVAL_S", 0)
    t = threading.Thread(target=lambda: got.append(("result", handler.handler(job))))
    threading.Timer(0.3, cancel.set).start()
    t.start()
    t.join(10)
    result = [g for g in got if isinstance(g, tuple)][0][1]
    assert result["error"].startswith("DOWNLOAD_FAILED: CANCELLED: big.safetensors")
    assert not (tmp_path / "vae" / "big.safetensors").exists()


def test_generate_watch_interrupts_when_cancelled():
    """A cancel that races queue_prompt is caught inside _watch."""
    class Client:
        interrupted = 0

        def iter_messages(self, ws):
            yield None
            yield {"type": "execution_interrupted",
                   "data": {"prompt_id": "p", "node_id": "3", "node_type": "KSampler"}}

        def interrupt(self):
            Client.interrupted += 1

        def history(self, pid):
            return {}

    ev = threading.Event()
    ev.set()
    prog = handler.Throttle({"id": "j", "_cancel": ev, "_progress": lambda p: None})
    res = handler._watch(Client(), None, "p", {"3"}, 4, prog, handler.clock())
    assert Client.interrupted == 1
    assert res["error"].startswith("COMFYUI_INTERRUPTED")


def test_policy_execution_timeout(env):
    srv, mgr, actions, clock = env
    g = run(srv, {"action": "generate", "tag": "gen0"}, policy={"executionTimeout": 5000})
    wait_for(lambda: status(srv, g)["status"] == "IN_PROGRESS")
    clock.advance(4)
    assert status(srv, g)["status"] == "IN_PROGRESS"
    clock.advance(1)
    assert status(srv, g)["status"] == "TIMED_OUT"
    assert actions.interrupts == 1


# ---------------------------------------------------------------------------
# failure shape
# ---------------------------------------------------------------------------
def test_failure_shape_matches_serverless(env):
    srv, mgr, actions, clock = env
    jid = run(srv, {"action": "status", "tag": "f",
                    "result": {"error": "MODEL_NOT_INSTALLED: unet/x.safetensors"}})
    actions.gate("f").set()
    s = wait_for(lambda: (lambda v: v if v["status"] == "FAILED" else None)(status(srv, jid)))
    # runpod-python run_job: error popped from the dict, empty output dropped.
    assert s == {"id": jid, "status": "FAILED", "delayTime": 0, "executionTime": 0,
                 "error": "MODEL_NOT_INSTALLED: unet/x.safetensors"}
    h = srv.get("/health").json()
    assert h["jobs"]["failed"] == 1


def test_failure_shape_from_real_handler(env):
    """End to end through handler.handler: unknown action -> FAILED + error."""
    srv, *_ = env
    mgr = server.JobManager(clock=FakeClock())
    job = mgr.submit({"action": "nope"})
    wait_for(lambda: mgr.view(job.id)["status"] == "FAILED")
    v = mgr.view(job.id)
    assert v["error"].startswith("UNKNOWN_ACTION: 'nope'") and "output" not in v
    mgr.shutdown()


def test_split_result_mirrors_runpod_run_job():
    assert server.split_result({"error": "X: y"}) == (None, "X: y")
    assert server.split_result({"a": 1, "error": "E"}) == ({"a": 1}, "E")
    assert server.split_result({"a": 1}) == ({"a": 1}, None)
    assert server.split_result({}) == (None, None)


def test_handler_exception_marks_failed(env):
    srv, mgr, actions, clock = env
    jid = run(srv, {"action": "status", "raise": True})
    s = wait_for(lambda: (lambda v: v if v["status"] == "FAILED" else None)(status(srv, jid)))
    assert s["error"] == "INTERNAL_ERROR: RuntimeError: boom"


# ---------------------------------------------------------------------------
# expiry
# ---------------------------------------------------------------------------
def test_finished_jobs_expire_after_30_minutes(env):
    srv, mgr, actions, clock = env
    jid = run(srv, {"action": "status", "tag": "s"})
    actions.gate("s").set()
    wait_for(lambda: status(srv, jid)["status"] == "COMPLETED")
    clock.advance(29 * 60)
    assert srv.get(f"/status/{jid}").status_code == 200
    clock.advance(60)
    assert srv.get(f"/status/{jid}").status_code == 404


def test_running_jobs_never_expire(env):
    srv, mgr, actions, clock = env
    jid = run(srv, {"action": "download", "tag": "dl"})
    wait_for(lambda: "dl" in actions.started)
    clock.advance(3 * 3600)
    assert status(srv, jid)["status"] == "IN_PROGRESS"


# ---------------------------------------------------------------------------
# progress hook
# ---------------------------------------------------------------------------
def test_progress_hook_replaces_progress_update(monkeypatch):
    calls = []
    monkeypatch.setattr(handler.runpod.serverless, "progress_update",
                        lambda job, p: calls.append(("runpod", p)))
    handler._send_progress({"id": "a"}, {"phase": "x"})
    handler._send_progress({"id": "b", "_progress": lambda p: calls.append(("hook", p))},
                           {"phase": "y"})
    assert calls == [("runpod", {"phase": "x"}), ("hook", {"phase": "y"})]


# ---------------------------------------------------------------------------
# idle watchdog
# ---------------------------------------------------------------------------
class Resp:
    def __init__(self, code):
        self.status_code = code


def make_watchdog(clock, mgr, idle_s=1800, terminate=None, **kw):
    calls = []

    def term():
        calls.append(clock())
        return True

    wd = server.IdleWatchdog(mgr, idle_s, terminate or term, clock=clock, **kw)
    return wd, calls


@pytest.fixture
def no_exit(monkeypatch):
    """Records any attempt to exit the process; the watchdog must never exit."""
    exits = []

    def fake_exit(code=0):
        exits.append(code)
        raise AssertionError(f"process exit({code}) called")

    monkeypatch.setattr(server.os, "_exit", fake_exit)
    monkeypatch.setattr(server.sys, "exit", fake_exit)
    return exits


def test_watchdog_fires_after_idle_minutes():
    clock = FakeClock()
    mgr = server.JobManager(run_job=lambda j: {}, clock=clock)
    wd, calls = make_watchdog(clock, mgr)
    clock.advance(1799)
    assert not wd.check() and calls == []
    clock.advance(1)
    assert wd.check() and len(calls) == 1
    assert not wd.check() and len(calls) == 1  # fires once
    mgr.shutdown()


def test_watchdog_reset_by_authenticated_requests_only(env):
    srv, mgr, actions, clock = env
    wd, calls = make_watchdog(clock, mgr)
    app_srv = Running(server.build_app(TOKEN, mgr, server.Health(
        mgr, comfy_up=lambda: True, gpu=lambda: "", comfy_version=lambda: ""), wd))
    try:
        clock.advance(1700)
        app_srv.get("/ping", auth=False)          # liveness doesn't count
        app_srv.get("/health", auth=False)        # 401 doesn't count
        clock.advance(100)
        assert wd.check() is True
        calls.clear()
        app_srv.get("/health")                    # authenticated: resets the timer
        assert wd.fired is False
        clock.advance(1799)
        assert wd.check() is False and calls == []
    finally:
        app_srv.close()


def test_watchdog_not_while_job_active(env):
    srv, mgr, actions, clock = env
    wd, calls = make_watchdog(clock, mgr)
    jid = run(srv, {"action": "download", "tag": "dl"})
    wait_for(lambda: "dl" in actions.started)
    clock.advance(3 * 3600)
    assert wd.check() is False and calls == []
    actions.gate("dl").set()
    wait_for(lambda: status(srv, jid)["status"] == "COMPLETED")
    # Idle time counts from the job's end, not from the last request.
    assert wd.check() is False
    clock.advance(1800)
    assert wd.check() is True and len(calls) == 1


class FlakyTerminate:
    """terminate() that fails `fails` times, then succeeds."""

    def __init__(self, clock, fails):
        self.clock, self.fails, self.calls = clock, fails, []

    def __call__(self):
        self.calls.append(self.clock())
        return len(self.calls) > self.fails


def test_watchdog_never_exits_and_retries_after_retry_s(no_exit, caplog):
    clock = FakeClock()
    mgr = server.JobManager(run_job=lambda j: {}, clock=clock)
    term = FlakyTerminate(clock, fails=10**9)
    wd, _ = make_watchdog(clock, mgr, terminate=term, retry_s=300)
    clock.advance(1800)
    with caplog.at_level("WARNING"):
        assert wd.check() is True               # attempt 1 fails, no exit
    assert len(term.calls) == 1 and wd.fired is False
    assert "STILL BILLING" in caplog.text and "retrying in 300 s" in caplog.text
    assert wd.status()["lastError"].startswith("terminate failed (1 attempt(s))")
    clock.advance(299)
    assert wd.check() is False and len(term.calls) == 1   # waits RETRY_S
    clock.advance(1)
    assert wd.check() is True and len(term.calls) == 2    # retried
    for _ in range(5):
        clock.advance(300)
        assert wd.check() is True
    assert len(term.calls) == 7 and wd.attempts == 7
    assert no_exit == []
    mgr.shutdown()


def test_watchdog_default_retry_is_300s():
    assert server.RETRY_S == 300
    mgr = server.JobManager(run_job=lambda j: {})
    assert server.IdleWatchdog(mgr, 60, lambda: False).retry_s == 300
    mgr.shutdown()


def test_watchdog_succeeds_on_a_later_retry(no_exit, caplog):
    clock = FakeClock()
    mgr = server.JobManager(run_job=lambda j: {}, clock=clock)
    term = FlakyTerminate(clock, fails=2)
    wd, _ = make_watchdog(clock, mgr, terminate=term, retry_s=300)
    clock.advance(1800)
    assert wd.check() and not wd.fired
    clock.advance(300)
    assert wd.check() and not wd.fired
    clock.advance(300)
    with caplog.at_level("WARNING"):
        assert wd.check() and wd.fired
    assert "terminate accepted" in caplog.text
    assert wd.status()["lastError"] is None
    clock.advance(3600)
    assert wd.check() is False and len(term.calls) == 3  # no more calls once accepted
    assert no_exit == []
    mgr.shutdown()


def test_watchdog_touch_resets_retry_state(no_exit):
    clock = FakeClock()
    mgr = server.JobManager(run_job=lambda j: {}, clock=clock)
    term = FlakyTerminate(clock, fails=10**9)
    wd, _ = make_watchdog(clock, mgr, terminate=term, retry_s=300)
    clock.advance(1800)
    assert wd.check() and wd.attempts == 1 and wd.next_attempt is not None
    wd.touch()                                   # pod in use again
    assert wd.attempts == 0 and wd.next_attempt is None and wd.status()["lastError"] is None
    clock.advance(300)
    assert wd.check() is False and len(term.calls) == 1  # idle timer restarted
    clock.advance(1500)
    assert wd.check() is True and len(term.calls) == 2 and wd.attempts == 1
    assert no_exit == []
    mgr.shutdown()


def test_watchdog_job_start_resets_retry_state(env, no_exit):
    srv, mgr, actions, clock = env
    term = FlakyTerminate(clock, fails=10**9)
    wd, _ = make_watchdog(clock, mgr, terminate=term, retry_s=300)
    clock.advance(1800)
    assert wd.check() and wd.attempts == 1
    mgr.submit({"action": "download", "tag": "dl"})  # direct submit: no touch()
    wait_for(lambda: "dl" in actions.started)
    clock.advance(600)
    assert wd.check() is False and wd.attempts == 0 and len(term.calls) == 1
    assert no_exit == []


def test_watchdog_request_during_attempt_discards_its_failure(no_exit):
    clock = FakeClock()
    mgr = server.JobManager(run_job=lambda j: {}, clock=clock)
    holder = {}

    def term():
        holder["wd"].touch()  # a request lands while DELETE is in flight
        return False

    wd, _ = make_watchdog(clock, mgr, terminate=term)
    holder["wd"] = wd
    clock.advance(1800)
    assert wd.check() is True
    assert wd.attempts == 0 and wd.next_attempt is None and wd.status()["lastError"] is None
    mgr.shutdown()


def test_watchdog_has_no_exit_parameter():
    import inspect
    assert "exit_fn" not in inspect.signature(server.IdleWatchdog).parameters


# ---- arm check -----------------------------------------------------------
def test_verify_armed_with_second_key_and_preferred_for_terminate(caplog):
    seen = []

    def get(url, headers, timeout):
        seen.append((url, headers["Authorization"]))
        return Resp(401 if headers["Authorization"] == "Bearer app-key" else 200)

    deletes = []

    def delete(url, headers, timeout):
        deletes.append(headers["Authorization"])
        return Resp(204)

    env = {"RUNPOD_POD_ID": "p1", "RUNPOD_TERMINATE_API_KEY": "app-key",
           "RUNPOD_API_KEY": "pod-key"}
    t = server.Terminator(env=env, get=get, delete=delete, which=lambda n: None)
    clock = FakeClock()
    mgr = server.JobManager(run_job=lambda j: {}, clock=clock)
    wd = server.IdleWatchdog(mgr, 1800, t.terminate, verify=t.verify, clock=clock)
    assert wd.status()["check"] == "pending" and wd.status()["armed"] is False
    with caplog.at_level("INFO"):
        wd.verify()
    assert seen == [("https://api.runpod.io/v2/pods/p1", "Bearer app-key"),
                    ("https://api.runpod.io/v2/pods/p1", "Bearer pod-key")]
    assert wd.armed is True and wd.armed_key == "RUNPOD_API_KEY" and wd.armed_error is None
    assert wd.status()["check"] == "read"
    assert t.terminate() and deletes == ["Bearer pod-key"]  # verified key tried first
    assert "app-key" not in caplog.text and "pod-key" not in caplog.text
    mgr.shutdown()


def test_verify_not_armed(caplog):
    def get(url, headers, timeout):
        if headers["Authorization"] == "Bearer app-key":
            raise requests.ConnectionError("Bearer app-key leaked?")
        return Resp(403)

    env = {"RUNPOD_POD_ID": "p1", "RUNPOD_TERMINATE_API_KEY": "app-key",
           "RUNPOD_API_KEY": "pod-key"}
    t = server.Terminator(env=env, get=get, which=lambda n: None)
    mgr = server.JobManager(run_job=lambda j: {})
    wd = server.IdleWatchdog(mgr, 1800, t.terminate, verify=t.verify)
    with caplog.at_level("INFO"):
        wd.verify()
    assert wd.armed is False and wd.armed_key is None and t.preferred is None
    assert wd.status()["check"] == "failed"
    err = wd.status()["lastError"]
    assert "RUNPOD_TERMINATE_API_KEY: ConnectionError" in err
    assert "RUNPOD_API_KEY: HTTP 403" in err
    assert "NOT armed" in caplog.text
    for secret in ("app-key", "pod-key"):
        assert secret not in caplog.text and secret not in err
    mgr.shutdown()


def test_verify_without_pod_id_or_keys():
    assert server.Terminator(env={"RUNPOD_API_KEY": "k"}).verify() == \
        server.ArmCheck(False, error="RUNPOD_POD_ID is not set")
    r = server.Terminator(env={"RUNPOD_POD_ID": "p"}, get=lambda *a, **k: 1 / 0).verify()
    assert r.armed is False and "no RunPod API key" in r.error


def test_verify_exception_does_not_propagate_and_disabled_skips():
    mgr = server.JobManager(run_job=lambda j: {})
    wd = server.IdleWatchdog(mgr, 1800, lambda: True, verify=lambda: 1 / 0)
    wd.verify()
    assert wd.armed is False and wd.status()["check"] == "failed"
    off = server.IdleWatchdog(mgr, 0, lambda: True, verify=lambda: 1 / 0)
    off.verify()
    assert off.status()["check"] == "disabled"
    mgr.shutdown()


def test_health_exposes_watchdog(env):
    srv, mgr, actions, clock = env
    t = server.Terminator(env={"RUNPOD_POD_ID": "p1", "RUNPOD_API_KEY": "pod-key"},
                          get=lambda *a, **k: Resp(200), which=lambda n: None)
    wd = server.IdleWatchdog(mgr, 1800, t.terminate, verify=t.verify, clock=clock)
    app_srv = Running(server.build_app(TOKEN, mgr, server.Health(
        mgr, comfy_up=lambda: True, gpu=lambda: "", comfy_version=lambda: ""), wd))
    try:
        assert app_srv.get("/health").json()["watchdog"] == {
            "armed": False, "check": "pending", "idleMinutes": 30, "idleForS": 0,
            "lastError": None}
        wd.verify()
        clock.advance(42)
        h = app_srv.get("/v2/x/health").json()["watchdog"]
        # the request itself touched the watchdog, so idle time is 0 again
        assert h == {"armed": True, "check": "read", "idleMinutes": 30, "idleForS": 0,
                     "lastError": None}
        assert "pod-key" not in app_srv.get("/health").text
    finally:
        app_srv.close()


def test_terminator_calls_runpod_delete_with_bearer_key():
    seen = []

    def delete(url, headers, timeout):
        seen.append((url, headers))
        return Resp(204)

    t = server.Terminator(env={"RUNPOD_POD_ID": "abc123", "RUNPOD_API_KEY": "pod-key"},
                          delete=delete, which=lambda n: None)
    assert t.terminate() is True
    assert seen == [("https://api.runpod.io/v2/pods/abc123",
                     {"Authorization": "Bearer pod-key"})]


def test_terminator_prefers_app_key_then_falls_back(caplog):
    seen = []

    def delete(url, headers, timeout):
        seen.append((url, headers["Authorization"]))
        return Resp(403 if headers["Authorization"] == "Bearer app-key" else 204)

    env = {"RUNPOD_POD_ID": "p1", "RUNPOD_TERMINATE_API_KEY": "app-key",
           "RUNPOD_API_KEY": "pod-key"}
    with caplog.at_level("WARNING"):
        assert server.Terminator(env=env, delete=delete, which=lambda n: None).terminate()
    assert seen == [("https://api.runpod.io/v2/pods/p1", "Bearer app-key"),
                    ("https://rest.runpod.io/v1/pods/p1", "Bearer app-key"),
                    ("https://api.runpod.io/v2/pods/p1", "Bearer pod-key")]
    assert "app-key" not in caplog.text and "pod-key" not in caplog.text  # never log secrets


def test_terminator_without_key_or_pod_id(caplog):
    called = []
    t = server.Terminator(env={"RUNPOD_POD_ID": "p1"}, delete=lambda *a, **k: called.append(1),
                          which=lambda n: None)
    with caplog.at_level("WARNING"):
        assert t.terminate() is False
    assert called == [] and "no RunPod API key" in caplog.text
    assert server.Terminator(env={"RUNPOD_API_KEY": "k"}, delete=lambda *a, **k: 1 / 0,
                             which=lambda n: None).terminate() is False


def test_terminator_falls_back_to_runpodctl():
    ran = []

    class P:
        def __init__(self, rc):
            self.returncode = rc

    def run(args, capture_output, timeout):
        ran.append(args[1:])
        return P(1 if args[1] == "pod" else 0)

    t = server.Terminator(env={"RUNPOD_POD_ID": "p1", "RUNPOD_API_KEY": "k"},
                          delete=lambda *a, **k: Resp(401), which=lambda n: "/usr/bin/runpodctl",
                          run=run)
    assert t.terminate() is True
    assert ran == [["pod", "delete", "p1"], ["remove", "pod", "p1"]]
