"""Planner LLM: supervisor state machine (llm.py) and the pod server's /v1 proxy."""

from __future__ import annotations

import asyncio
import io
import json
import threading
import time
from pathlib import Path

import pytest
import requests
from aiohttp import web

import llm
import server
from test_server import AUTH, TOKEN, FakeClock, Running, wait_for


# ---------------------------------------------------------------------------
# fakes
# ---------------------------------------------------------------------------
class Resp:
    def __init__(self, code):
        self.status_code = code


class FakeProc:
    """subprocess.Popen stand-in: `lines` of output, exits with `exit_code`
    once `exit` is set (or at once when exit_code is given and exit is None)."""

    pid = 4242

    def __init__(self, lines=(), exit_code=None):
        self.stdout = io.StringIO("".join(f"{x}\n" for x in lines))
        self.returncode = exit_code
        self.exit = threading.Event()
        self.terminated = False

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        if self.returncode is None:
            self.exit.wait(timeout if timeout is not None else 10)
            if self.returncode is None:
                self.returncode = 0
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = -15
        self.exit.set()

    def kill(self):
        self.terminate()


class Usage:
    def __init__(self, free):
        self.free = free


def make_sup(tmp_path, *, proc=None, health=(200,), download=None, total=1000,
             gpu_mib=97887.0, free=10**15, **kw):
    """A supervisor with every outside effect faked; records what it did."""
    clock = FakeClock()
    rec = {"popen": [], "states": [], "download": 0, "health_codes": list(health)}
    procs = [proc or FakeProc(["INFO loading weights", "INFO Application startup complete."])]

    def popen(cmd, **pkw):
        rec["popen"].append((cmd, pkw))
        return procs[0]

    def fake_download(repo, dest, token):
        rec["download"] += 1
        rec["states"].append(("download", sup.state))
        rec["token"] = token
        if download is not None:
            download(repo, dest, token)
        else:
            (dest / "model.safetensors").write_bytes(b"x" * total)

    def http_get(url, timeout):
        rec["states"].append(("health", sup.state))
        rec["url"] = url
        code = rec["health_codes"].pop(0) if len(rec["health_codes"]) > 1 \
            else rec["health_codes"][0]
        if code is None:
            raise requests.ConnectionError("refused")
        return Resp(code)

    def sleep(s):
        clock.advance(s)

    sup = llm.LLMSupervisor(
        "orcarouter/Qwen3.8-27B-Uncensored-FP8", tmp_path / "llm", token="hf_secret",
        env={"PYTHONPATH": "/app/src", "HF_TOKEN": "hf_secret", "PATH": "/usr/bin"},
        popen=popen, download=fake_download, total_bytes=lambda repo, token: total,
        disk_usage=lambda p: Usage(free), gpu_mib=lambda: gpu_mib, http_get=http_get,
        sleep=sleep, clock=clock, **kw)
    return sup, rec, procs[0], clock


# ---------------------------------------------------------------------------
# gpu utilization
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("gb,total_mib,want", [
    (44, 97887, 0.46),      # RTX PRO 6000 (96 GB): 45056 / 97887 = 0.4602 -> 0.46
    (44, 81559, 0.552),     # 80 GB card
    (44, 32607, 0.9),       # 32 GB card: clamped down
    (1, 97887, 0.1),        # clamped up
    (48, 49152, 0.9),       # exactly the whole card -> 0.9
])
def test_gpu_utilization(gb, total_mib, want):
    assert llm.gpu_utilization(gb, total_mib) == want


def test_gpu_utilization_rounds_down():
    # 45056 / 97887 = 0.46028...: never ask for more than LLM_GPU_GB.
    u = llm.gpu_utilization(44, 97887)
    assert u * 97887 <= 44 * 1024


# ---------------------------------------------------------------------------
# env
# ---------------------------------------------------------------------------
def test_from_env_off_when_unset_or_empty():
    assert llm.LLMSupervisor.from_env({}) is None
    assert llm.LLMSupervisor.from_env({"LLM_MODEL": "  "}) is None


def test_from_env_defaults_and_overrides():
    s = llm.LLMSupervisor.from_env({"LLM_MODEL": "org/Some-Model", "HF_TOKEN": "t"})
    assert s.served_name == "qwen3.8-27b-uncensored" and s.gpu_gb == 44
    assert s.max_len == 32768 and s.token == "t"
    assert s.dir == Path("/models-local/llm/Some-Model")
    s = llm.LLMSupervisor.from_env({"LLM_MODEL": "org/M", "LLM_SERVED_NAME": "planner",
                                    "LLM_GPU_GB": "30.5", "LLM_MAX_LEN": "8192",
                                    "LOCAL_MODELS_ROOT": "/x"})
    assert (s.served_name, s.gpu_gb, s.max_len, s.dir) == ("planner", 30.5, 8192,
                                                            Path("/x/llm/M"))
    s = llm.LLMSupervisor.from_env({"LLM_MODEL": "org/M", "LLM_GPU_GB": "lots",
                                    "LLM_MAX_LEN": "-1"})
    assert s.gpu_gb == 44 and s.max_len == 32768


def test_from_env_volume_store(tmp_path):
    s = llm.LLMSupervisor.from_env({"LLM_MODEL": "org/M", "VOLUME_ROOT": str(tmp_path)})
    assert s.store is None                         # no models/ on the volume: no store
    (tmp_path / "models").mkdir()
    s = llm.LLMSupervisor.from_env({"LLM_MODEL": "org/M", "VOLUME_ROOT": str(tmp_path)})
    assert s.store == tmp_path / "models" / "llm" / "M" and s.serve_dir == s.dir


def test_off_status_shape():
    assert llm.off_status() == {"state": "off", "model": None, "downloadedBytes": 0,
                                "totalBytes": 0, "error": None}


# ---------------------------------------------------------------------------
# state machine
# ---------------------------------------------------------------------------
def vllm_dir(rec):
    cmd, _ = rec["popen"][0]
    return Path(cmd[2])


def volume_copy(tmp_path, size=600):
    """A complete volume copy of the repo (with HF cache junk that must not be copied)."""
    vol = tmp_path / "vol" / "Qwen3.8-27B-Uncensored-FP8"
    (vol / "sub").mkdir(parents=True)
    (vol / "model.safetensors").write_bytes(b"y" * size)
    (vol / "sub" / "tokenizer.json").write_bytes(b"t" * 40)
    (vol / ".cache" / "huggingface").mkdir(parents=True)
    (vol / ".cache" / "huggingface" / "junk").write_bytes(b"j" * 99)
    (vol / llm.COMPLETE_MARKER).write_text(json.dumps(
        {"repo": "orcarouter/Qwen3.8-27B-Uncensored-FP8", "totalBytes": size + 40}))
    return vol


def hub_down(repo, dest, token):
    raise ConnectionError("hub unreachable")


def test_hub_first_even_with_a_volume_copy(tmp_path):
    # 27 s from the Hub vs 1362 s from the volume on the first real boot.
    vol = volume_copy(tmp_path)
    sup, rec, proc, clock = make_sup(tmp_path, store=tmp_path / "vol")
    threading.Thread(target=sup.run, daemon=True).start()
    wait_for(lambda: sup.ready())
    assert rec["download"] == 1
    assert (sup.dir / "model.safetensors").read_bytes() == b"x" * 1000
    assert json.loads((sup.dir / llm.COMPLETE_MARKER).read_text())["repo"] == sup.repo
    assert (vol / "model.safetensors").read_bytes() == b"y" * 600, "the volume copy is left alone"
    assert vllm_dir(rec) == sup.dir
    sup.stop()


def test_nothing_is_written_to_the_volume(tmp_path):
    sup, rec, proc, clock = make_sup(tmp_path, store=tmp_path / "vol")
    threading.Thread(target=sup.run, daemon=True).start()
    wait_for(lambda: sup.ready())
    assert rec["download"] == 1 and vllm_dir(rec) == sup.dir
    assert not (sup.store / "model.safetensors").exists()
    sup.stop()


def test_hub_failure_copies_the_volume_copy(tmp_path):
    volume_copy(tmp_path)
    sup, rec, proc, clock = make_sup(tmp_path, store=tmp_path / "vol", download=hub_down)
    threading.Thread(target=sup.run, daemon=True).start()
    wait_for(lambda: sup.ready())
    assert rec["download"] == 1
    assert (sup.dir / "sub" / "tokenizer.json").read_bytes() == b"t" * 40
    assert not (sup.dir / ".cache").exists()
    assert vllm_dir(rec) == sup.dir
    st = sup.status()
    assert st["error"] is None and st["downloadedBytes"] == 640 == st["totalBytes"]
    sup.stop()


def test_volume_full_downloads_to_local_disk(tmp_path):
    def usage(p):
        return Usage(10 if (tmp_path / "vol") in Path(p).parents else 10**15)

    sup, rec, proc, clock = make_sup(tmp_path, store=tmp_path / "vol")
    sup.disk_usage = usage
    threading.Thread(target=sup.run, daemon=True).start()
    wait_for(lambda: sup.ready())
    assert rec["download"] == 1
    assert (sup.dir / "model.safetensors").exists()
    assert not (sup.store / "model.safetensors").exists()
    assert vllm_dir(rec) == sup.dir
    sup.stop()


def test_local_disk_full_serves_from_the_volume_copy(tmp_path):
    volume_copy(tmp_path)

    def usage(p):
        return Usage(10 if (tmp_path / "vol") not in Path(p).parents else 10**15)

    sup, rec, proc, clock = make_sup(tmp_path, store=tmp_path / "vol")
    sup.disk_usage = usage
    threading.Thread(target=sup.run, daemon=True).start()
    wait_for(lambda: sup.ready())
    assert rec["download"] == 0
    assert vllm_dir(rec) == sup.store
    assert not (sup.dir / llm.COMPLETE_MARKER).exists()
    sup.stop()


def test_hub_and_copy_failure_serve_from_the_volume_copy(tmp_path):
    def broken(src, dst, **kw):
        raise OSError("disk went away")

    volume_copy(tmp_path)
    sup, rec, proc, clock = make_sup(tmp_path, store=tmp_path / "vol", download=hub_down, copy=broken)
    threading.Thread(target=sup.run, daemon=True).start()
    wait_for(lambda: sup.ready())
    assert vllm_dir(rec) == sup.store and sup.status()["error"] is None
    sup.stop()


def test_download_then_starting_then_ready(tmp_path):
    sup, rec, proc, clock = make_sup(tmp_path, health=(None, 503, 200))
    assert sup.status()["state"] == "downloading" and sup.busy()
    t = threading.Thread(target=sup.run)
    t.start()
    wait_for(lambda: sup.ready())
    assert rec["states"][0] == ("download", "downloading")
    assert [s for k, s in rec["states"] if k == "health"] == ["starting"] * 3
    assert rec["token"] == "hf_secret"
    st = sup.status()
    assert st == {"state": "ready", "model": "qwen3.8-27b-uncensored",
                  "downloadedBytes": 1000, "totalBytes": 1000, "error": None}
    assert not sup.busy()
    assert rec["url"] == "http://127.0.0.1:8001/health"
    # the exact vLLM command line
    cmd, pkw = rec["popen"][0]
    assert cmd == [
        "/opt/vllm/bin/vllm", "serve", str(tmp_path / "llm" / "Qwen3.8-27B-Uncensored-FP8"),
        "--served-model-name", "qwen3.8-27b-uncensored",
        "--host", "127.0.0.1", "--port", "8001",
        "--language-model-only",
        "--speculative-config", '{"method":"mtp","num_speculative_tokens":3,"attention_backend":"TRITON_ATTN"}',
        "--kv-cache-dtype", "fp8",
        "--gpu-memory-utilization", "0.46",
        "--max-model-len", "32768",
        "--max-num-seqs", "4",
        "--trust-remote-code",
        "--reasoning-parser", "qwen3",
        "--gdn-prefill-backend", "triton",
        "--attention-backend", "TRITON_ATTN",
        "--disable-uvicorn-access-log"]
    assert "--quantization" not in cmd
    assert "PYTHONPATH" not in pkw["env"] and pkw["env"]["HF_TOKEN"] == "hf_secret"
    assert pkw["env"]["VLLM_USE_FLASHINFER_SAMPLER"] == "0"
    # marker written: a later boot skips the download
    marker = json.loads((sup.dir / llm.COMPLETE_MARKER).read_text())
    assert marker == {"repo": "orcarouter/Qwen3.8-27B-Uncensored-FP8", "totalBytes": 1000}
    # vLLM exiting after ready -> failed with its last lines
    proc.returncode = 1
    proc.exit.set()
    t.join(5)
    st = sup.status()
    assert st["state"] == "failed" and "exited with code 1" in st["error"]
    assert "Application startup complete." in st["error"]


def test_completed_download_is_skipped(tmp_path):
    sup, rec, proc, clock = make_sup(tmp_path)
    sup.dir.mkdir(parents=True)
    (sup.dir / llm.COMPLETE_MARKER).write_text(json.dumps(
        {"repo": sup.repo, "totalBytes": 777}))
    threading.Thread(target=sup.run, daemon=True).start()
    wait_for(lambda: sup.ready())
    assert rec["download"] == 0
    assert sup.status()["downloadedBytes"] == 777 == sup.status()["totalBytes"]
    sup.stop()


def test_download_progress_from_disk(tmp_path):
    gate, release = threading.Event(), threading.Event()

    def slow_download(repo, dest, token):
        inc = dest / ".cache" / "huggingface" / "download"
        inc.mkdir(parents=True)
        (inc / "model.safetensors.incomplete").write_bytes(b"x" * 400)
        gate.set()
        release.wait(5)
        (inc / "model.safetensors.incomplete").rename(dest / "model.safetensors")

    sup, rec, proc, clock = make_sup(tmp_path, download=slow_download, total=1000)
    t = threading.Thread(target=sup.run, daemon=True)
    t.start()
    assert gate.wait(5)
    st = sup.status()
    assert st["state"] == "downloading" and st["totalBytes"] == 1000
    assert st["downloadedBytes"] == 400
    release.set()
    wait_for(lambda: sup.ready())
    assert sup.status()["downloadedBytes"] == 1000
    sup.stop()


def test_download_failure(tmp_path):
    def boom(repo, dest, token):
        raise OSError("401 Client Error: Unauthorized for url: https://huggingface.co/x\nmore")

    sup, rec, proc, clock = make_sup(tmp_path, download=boom)
    sup.run()
    st = sup.status()
    assert st["state"] == "failed" and not sup.busy()
    assert st["error"] == ("download of orcarouter/Qwen3.8-27B-Uncensored-FP8 failed: "
                           "OSError: 401 Client Error: Unauthorized for url: "
                           "https://huggingface.co/x")
    assert "hf_secret" not in st["error"]
    assert rec["popen"] == []


def test_metadata_failure_and_no_space(tmp_path):
    sup, rec, *_ = make_sup(tmp_path)
    sup.total_bytes = lambda repo, token: 1 / 0
    sup.run()
    assert sup.status()["state"] == "failed" and "ZeroDivisionError" in sup.status()["error"]

    sup, rec, *_ = make_sup(tmp_path / "b", total=30 * 10**9, free=20 * 10**9)
    sup.run()
    st = sup.status()
    assert st["state"] == "failed" and st["error"].startswith("not enough disk space")
    assert rec["download"] == 0


def test_vllm_exits_while_starting(tmp_path):
    proc = FakeProc(["INFO start", "ValueError: Free memory on device cuda:0 (20/95 GiB) "
                     "on startup is less than desired GPU memory utilization"], exit_code=1)
    sup, rec, _, clock = make_sup(tmp_path, proc=proc, health=(None,))
    sup.run()
    st = sup.status()
    assert st["state"] == "failed"
    # The root-cause line, not the last lines of output.
    assert st["error"].startswith("vLLM exited with code 1 while starting: ValueError: Free memory")


def test_vllm_start_timeout_kills_it(tmp_path):
    sup, rec, proc, clock = make_sup(tmp_path, health=(503,), start_timeout_s=60, poll_s=2)
    sup.run()
    st = sup.status()
    assert st["state"] == "failed" and "did not become healthy within 60 s" in st["error"]
    assert proc.terminated


def test_no_gpu_memory_reading_fails(tmp_path):
    sup, rec, *_ = make_sup(tmp_path, gpu_mib=None)
    sup.run()
    assert sup.status()["state"] == "failed" and "nvidia-smi" in sup.status()["error"]
    assert rec["popen"] == []


def test_launch_waits_for_gate(tmp_path):
    calls = []

    def gate():
        calls.append(sup.state)
        return len(calls) >= 3

    sup, rec, proc, clock = make_sup(tmp_path, gate=gate)
    threading.Thread(target=sup.run, daemon=True).start()
    wait_for(lambda: sup.ready())
    assert calls == ["starting"] * 3
    sup.stop()


def test_gate_wait_is_bounded(tmp_path):
    sup, rec, proc, clock = make_sup(tmp_path, gate=lambda: False, gate_timeout_s=10)
    threading.Thread(target=sup.run, daemon=True).start()
    wait_for(lambda: sup.ready())
    sup.stop()


def test_vllm_output_prefixed_in_log(tmp_path, capsys):
    sup, rec, proc, clock = make_sup(tmp_path)
    threading.Thread(target=sup.run, daemon=True).start()
    wait_for(lambda: sup.ready())
    wait_for(lambda: len(sup.tail) == 2)
    out = capsys.readouterr().out
    assert "vllm | INFO loading weights\n" in out
    sup.stop()


# ---------------------------------------------------------------------------
# warm-up waits for vLLM
# ---------------------------------------------------------------------------
def test_warmup_waits_while_llm_busy(caplog):
    mgr = server.JobManager(run_job=lambda j: {})
    busy = {"v": True}
    ran = []
    clock = FakeClock()

    def sleep(s):
        clock.advance(s)
        if clock() >= 1030:
            busy["v"] = False

    warm = server.WarmUp(mgr, "h3", {"action": "generate_video"}, comfy_up=lambda: True,
                         run_job=lambda j: ran.append(clock()) or {}, llm_busy=lambda: busy["v"],
                         sleep=sleep, clock=clock)
    with caplog.at_level("INFO"):
        warm.run()
    assert warm.state == "done" and ran == [1030]
    assert "waits for the planner LLM" in caplog.text
    mgr.shutdown()


def test_warmup_skips_when_real_job_arrives_while_llm_busy():
    mgr = server.JobManager(run_job=lambda j: {})
    states = []

    def sleep(s):
        states.append(warm.state)
        mgr.generate_submitted = True

    warm = server.WarmUp(mgr, "h3", {}, comfy_up=lambda: True, run_job=lambda j: {},
                         llm_busy=lambda: True, sleep=sleep)
    warm.run()
    assert states == ["waiting_llm"] and warm.state == "skipped"
    mgr.shutdown()


# ---------------------------------------------------------------------------
# /health and the /v1 proxy
# ---------------------------------------------------------------------------
class FakeLLM:
    def __init__(self, base_url="http://127.0.0.1:1", state="ready"):
        self.base_url = base_url
        self.state = state

    def status(self):
        return {"state": self.state, "model": "qwen3.8-27b-uncensored",
                "downloadedBytes": 5, "totalBytes": 10, "error": None}

    def ready(self):
        return self.state == "ready"


class Upstream:
    """A fake vLLM: /v1/chat/completions streams SSE in two chunks with a
    pause between them that the test controls; /v1/models answers JSON."""

    def __init__(self):
        self.release = threading.Event()
        self.seen: list[dict] = []
        app = web.Application()
        app.router.add_post("/v1/chat/completions", self.chat)
        app.router.add_get("/v1/models", self.models)
        app.router.add_post("/v1/bad", self.bad)
        self.running = Running(app)
        self.base = self.running.base

    async def chat(self, request):
        body = await request.json()
        self.seen.append({"body": body, "query": request.query_string,
                          "auth": request.headers.get("Authorization"),
                          "ct": request.headers.get("Content-Type")})
        resp = web.StreamResponse(status=200)
        resp.headers["Content-Type"] = "text/event-stream; charset=utf-8"
        await resp.prepare(request)
        await resp.write(b'data: {"delta": "first"}\n\n')
        await asyncio.get_running_loop().run_in_executor(None, self.release.wait, 10)
        await resp.write(b'data: {"delta": "second"}\n\ndata: [DONE]\n\n')
        await resp.write_eof()
        return resp

    async def models(self, request):
        self.seen.append({"query": request.query_string})
        return web.json_response({"data": [{"id": "qwen3.8-27b-uncensored"}]})

    async def bad(self, request):
        return web.json_response({"error": {"message": "max_tokens too large"}}, status=400)

    def close(self):
        self.release.set()
        self.running.close()


@pytest.fixture
def proxy_env():
    clock = FakeClock()
    mgr = server.JobManager(run_job=lambda j: {}, clock=clock)
    up = Upstream()
    fake = FakeLLM(up.base)
    wd = server.IdleWatchdog(mgr, 1800, lambda: True, clock=clock)
    health = server.Health(mgr, comfy_up=lambda: True, gpu=lambda: "G",
                           comfy_version=lambda: "0.39.0", llm=fake.status)
    srv = Running(server.build_app(TOKEN, mgr, health, wd, fake))
    yield srv, up, fake, wd, clock
    up.close()
    srv.close()
    mgr.shutdown()


def test_health_llm_field(proxy_env):
    srv, up, fake, wd, clock = proxy_env
    assert srv.get("/health").json()["llm"] == fake.status()
    assert srv.get("/v2/x/health").json()["llm"]["state"] == "ready"


def test_health_llm_field_off():
    mgr = server.JobManager(run_job=lambda j: {})
    health = server.Health(mgr, comfy_up=lambda: True, gpu=lambda: "G",
                           comfy_version=lambda: "0.39.0", llm=llm.off_status)
    srv = Running(server.build_app(TOKEN, mgr, health))
    try:
        assert srv.get("/health").json()["llm"] == llm.off_status()
        r = srv.post("/v1/chat/completions", json={})
        assert r.status_code == 503 and r.json() == {"error": "The planner model is off"}
    finally:
        srv.close()
        mgr.shutdown()


@pytest.mark.parametrize("state", ["downloading", "starting", "failed"])
def test_proxy_503_when_not_ready(proxy_env, state):
    srv, up, fake, wd, clock = proxy_env
    fake.state = state
    r = srv.post("/v1/chat/completions", json={"model": "x"})
    assert r.status_code == 503
    assert r.json() == {"error": f"The planner model is {state}"}
    assert up.seen == []


def test_proxy_requires_auth(proxy_env):
    srv, up, fake, wd, clock = proxy_env
    for path in ("/v1/models", "/v2/abc/v1/models"):
        assert srv.get(path, auth=False).status_code == 401
        r = requests.get(srv.base + path, headers={"Authorization": "Bearer wrong"}, timeout=5)
        assert r.status_code == 401
    assert srv.post("/v1/chat/completions", auth=False, json={}).status_code == 401
    assert up.seen == []


def test_proxy_get_with_query_and_v2_prefix(proxy_env):
    srv, up, fake, wd, clock = proxy_env
    for path in ("/v1/models?a=1&b=two", "/v2/endpoint/v1/models?a=1&b=two"):
        r = srv.get(path)
        assert r.status_code == 200
        assert r.headers["Content-Type"].startswith("application/json")
        assert r.json() == {"data": [{"id": "qwen3.8-27b-uncensored"}]}
    assert [s["query"] for s in up.seen] == ["a=1&b=two"] * 2


def test_proxy_passes_error_status_and_body(proxy_env):
    srv, up, fake, wd, clock = proxy_env
    r = srv.post("/v1/bad", json={"max_tokens": 10**9})
    assert r.status_code == 400
    assert r.json() == {"error": {"message": "max_tokens too large"}}


def test_proxy_streams_incrementally_and_watchdog_stays_busy(proxy_env):
    srv, up, fake, wd, clock = proxy_env
    body = {"model": "qwen3.8-27b-uncensored", "stream": True,
            "messages": [{"role": "user", "content": "plan"}]}
    r = requests.post(srv.base + "/v1/chat/completions?x=1", json=body, headers=AUTH,
                      stream=True, timeout=10)
    try:
        assert r.status_code == 200
        assert r.headers["Content-Type"] == "text/event-stream; charset=utf-8"
        chunks = r.iter_content(chunk_size=None)
        first = next(chunks)
        # The first event arrived while the upstream is still holding the rest.
        assert first == b'data: {"delta": "first"}\n\n' and not up.release.is_set()
        assert up.seen[0]["body"] == body and up.seen[0]["query"] == "x=1"
        assert up.seen[0]["ct"] == "application/json"
        assert up.seen[0]["auth"] is None  # our Bearer token never reaches vLLM
        # Long stream: far past IDLE_MINUTES, the pod is still busy.
        assert wd.in_flight == 1
        clock.advance(3 * 3600)
        assert wd.check() is False
        up.release.set()
        rest = b"".join(chunks)
        assert rest == b'data: {"delta": "second"}\n\ndata: [DONE]\n\n'
    finally:
        r.close()
    wait_for(lambda: wd.in_flight == 0)
    # Idle time counts from the end of the stream.
    assert wd.check() is False
    clock.advance(1799)
    assert wd.check() is False
    clock.advance(1)
    assert wd.check() is True


def test_proxy_upstream_down_is_502(proxy_env):
    srv, up, fake, wd, clock = proxy_env
    fake.base_url = "http://127.0.0.1:9"  # nothing listens on the discard port
    r = srv.post("/v1/chat/completions", json={})
    assert r.status_code == 502 and "unreachable" in r.json()["error"]
    assert wd.in_flight == 0


def test_proxy_client_disconnect_releases_watchdog(proxy_env):
    srv, up, fake, wd, clock = proxy_env
    r = requests.post(srv.base + "/v1/chat/completions", json={"stream": True}, headers=AUTH,
                      stream=True, timeout=10)
    next(r.iter_content(chunk_size=None))
    assert wd.in_flight == 1
    r.close()  # the app gives up mid-stream
    up.release.set()
    wait_for(lambda: wd.in_flight == 0)


# ---------------------------------------------------------------------------
# wiring in main
# ---------------------------------------------------------------------------
def test_start_llm_off_and_on(monkeypatch):
    assert server.start_llm({}) is None
    started = []
    monkeypatch.setattr(llm.LLMSupervisor, "start", lambda self: started.append(self))
    assert server.start_llm({"LLM_MODEL": "org/M"}, start=False).busy() and started == []
    sup = server.start_llm({"LLM_MODEL": "org/M"})
    assert started == [sup] and sup.busy()
    server.cuda_info._reset_for_tests()
    assert sup.gate() is True                      # no CUDA probe on this box
    server.cuda_info.start(probe_fn=lambda: {"enabled": True}, background=False)
    assert sup.gate() is True
    server.cuda_info._reset_for_tests()
    server.cuda_info.start(probe_fn=lambda: time.sleep(0.3) or {"enabled": True})
    assert sup.gate() is False                     # probe still running
    wait_for(sup.gate)
    server.cuda_info._reset_for_tests()


def test_root_cause_finds_the_real_error_line():
    from llm import root_cause
    line = ("(EngineCore pid=1796) ERROR 10-13 17:17:29 [core.py:1231] torch._inductor.exc.InductorError: "
            "RuntimeError: Failed to find C compiler. Please specify via CC environment variable")
    assert root_cause(line).startswith("torch._inductor.exc.InductorError: RuntimeError: Failed to find C compiler")
    assert root_cause("(EngineCore pid=1796) torch._inductor.exc.InductorError: RuntimeError: x") == \
        "torch._inductor.exc.InductorError: RuntimeError: x"
    assert root_cause("(APIServer pid=971) RuntimeError: Engine core initialization failed. See root cause above.") is None
    assert root_cause("(EngineCore pid=1) WARNING 10-13 17:16:47 [import_utils.py:408] AssertionError") is None
    assert root_cause("(EngineCore pid=1) INFO 10-13 17:17:07 [gpu_model_runner.py:5255] Model loading took 28 GiB") is None
    assert root_cause("(EngineCore pid=1) ERROR 10-13 [core.py:1] Traceback (most recent call last):") is None
