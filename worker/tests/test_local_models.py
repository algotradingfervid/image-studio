"""Local model copies (local_models.py), the on-demand wait in the handler
(stage "copying_models"), the boot prefetch + warm-up (server.py) and the
/health fields."""

from __future__ import annotations

import base64
import json
import os
import threading
import time
from pathlib import Path

import pytest

import handler
import local_models
import server
from local_models import LocalModels, copy_file
from test_handler import env, gen_input  # noqa: F401  (env is a fixture)
from test_server import TOKEN, FakeClock, Running, make_watchdog, wait_for
from test_video_handler import venv, vid_input  # noqa: F401  (venv is a fixture)
from workflows import POSTER_PREFIX, STAGE_PHASE, STAGES, VIDEO_PREFIX

KB = 1024


def data(n: int, seed: int = 1) -> bytes:
    return bytes((i * 31 + seed) % 251 for i in range(n))


def fake_registry(*files_per_model):
    """{"models": [{"id": "m<i>", "files": [...]}]} with (folder, name, size)."""
    models = []
    for i, files in enumerate(files_per_model):
        models.append({"id": f"m{i}", "files": [
            {"folder": f, "filename": n, "sizeBytes": s} for f, n, s in files]})
    return {"models": models, "videoModels": []}


@pytest.fixture
def roots(tmp_path):
    src, dst = tmp_path / "vol" / "models", tmp_path / "local"
    for d in ("unet", "clip", "vae"):
        (src / d).mkdir(parents=True)
    dst.mkdir()
    return src, dst


def put(src: Path, folder: str, name: str, content: bytes) -> None:
    (src / folder / name).write_bytes(content)


def make(roots, reg, **kw) -> LocalModels:
    src, dst = roots
    kw.setdefault("threads", 4)
    kw.setdefault("chunk", 4 * KB)
    kw.setdefault("reserve", 0)
    return LocalModels(lambda: reg, src, dst, **kw)


def finished(m: LocalModels, entries, timeout=10.0) -> dict:
    return m.wait(entries, timeout=timeout)


# ---------------------------------------------------------------------------
# copy_file
# ---------------------------------------------------------------------------
def test_copy_file_parallel_ranges_part_then_rename(tmp_path, monkeypatch):
    src, dst = tmp_path / "a.bin", tmp_path / "out" / "a.safetensors"
    content = data(100 * KB + 123)
    src.write_bytes(content)
    real = os.pread
    lock = threading.Lock()
    seen = {"offsets": [], "active": 0, "max": 0}

    def pread(fd, n, off):
        with lock:
            seen["offsets"].append(off)
            seen["active"] += 1
            seen["max"] = max(seen["max"], seen["active"])
        time.sleep(0.01)
        try:
            return real(fd, n, off)
        finally:
            with lock:
                seen["active"] -= 1

    monkeypatch.setattr(local_models.os, "pread", pread)
    during = []

    def on_bytes(n):
        during.append((dst.exists(), sorted(p.name for p in dst.parent.iterdir())))

    n = copy_file(src, dst, threads=8, chunk=8 * KB, on_bytes=on_bytes)
    assert n == len(content) and dst.read_bytes() == content
    assert sorted(set(seen["offsets"])) == list(range(0, len(content), 8 * KB))  # 64 KB ranges, scaled
    assert seen["max"] > 1, "ranges are read in parallel"
    # never visible under the final name before the copy is complete
    assert during and not any(exists for exists, _ in during)
    assert all(any(f.endswith(".part") for f in names) for _, names in during)
    assert [p.name for p in dst.parent.iterdir()] == ["a.safetensors"]


def test_copy_file_short_source_fails_and_removes_part(tmp_path, monkeypatch):
    src, dst = tmp_path / "a.bin", tmp_path / "out" / "a.safetensors"
    src.write_bytes(data(40 * KB))
    real = os.pread
    monkeypatch.setattr(local_models.os, "pread",
                        lambda fd, n, off: b"" if off >= 16 * KB else real(fd, n, off))
    with pytest.raises(local_models.CopyError, match="source ended early"):
        copy_file(src, dst, threads=4, chunk=8 * KB)
    assert not dst.exists() and list(dst.parent.iterdir()) == []


def test_copy_file_size_check_catches_a_source_that_changes(tmp_path):
    src, dst = tmp_path / "a.bin", tmp_path / "out" / "a.safetensors"
    src.write_bytes(data(32 * KB))
    grown = []

    def on_bytes(n):
        if not grown:
            grown.append(1)
            with open(src, "ab") as fh:
                fh.write(b"more")

    with pytest.raises(local_models.CopyError, match="changed size"):
        copy_file(src, dst, threads=2, chunk=8 * KB, on_bytes=on_bytes)
    assert not dst.exists() and list(dst.parent.iterdir()) == []


def test_copy_file_empty_and_cancel(tmp_path):
    src, dst = tmp_path / "e.bin", tmp_path / "out" / "e.safetensors"
    src.write_bytes(b"")
    assert copy_file(src, dst) == 0 and dst.read_bytes() == b""
    src.write_bytes(data(64 * KB))
    dst2 = tmp_path / "out" / "c.safetensors"
    ev = threading.Event()
    ev.set()
    with pytest.raises(local_models.CopyCancelled):
        copy_file(src, dst2, threads=2, chunk=8 * KB, cancel=ev)
    assert not dst2.exists()
    assert sorted(p.name for p in dst.parent.iterdir()) == ["e.safetensors"]


def test_two_concurrent_copies_of_one_file_are_safe(tmp_path):
    src, dst = tmp_path / "a.bin", tmp_path / "out" / "a.safetensors"
    content = data(200 * KB)
    src.write_bytes(content)
    errors = []

    def go():
        try:
            copy_file(src, dst, threads=4, chunk=4 * KB)
        except Exception as e:  # pragma: no cover - reported below
            errors.append(e)

    ts = [threading.Thread(target=go) for _ in range(3)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(10)
    assert errors == [] and dst.read_bytes() == content
    assert [p.name for p in dst.parent.iterdir()] == ["a.safetensors"]


def test_remove_stale_parts(tmp_path):
    (tmp_path / "unet").mkdir()
    (tmp_path / "unet" / "x.safetensors.ab12cd34.part").write_bytes(b"x")
    (tmp_path / "unet" / "y.safetensors").write_bytes(b"y")
    assert local_models.remove_stale_parts(tmp_path) == 1
    assert [p.name for p in (tmp_path / "unet").iterdir()] == ["y.safetensors"]


# ---------------------------------------------------------------------------
# manager
# ---------------------------------------------------------------------------
def test_copies_text_encoder_then_unet_then_vae(roots):
    src, dst = roots
    reg = fake_registry([("vae", "v.safetensors", 0), ("unet", "u.safetensors", 0),
                         ("clip", "c.safetensors", 0)])
    for f, n in (("vae", "v"), ("unet", "u"), ("clip", "c")):
        put(src, f, f"{n}.safetensors", data(10 * KB, seed=ord(n)))
    order = []

    def copy(s, d, **kw):
        order.append(d.parent.name)
        return copy_file(s, d, **kw)

    m = make(roots, reg, copy=copy)
    entries = m.request("m0")
    res = finished(m, entries)
    assert order == ["clip", "unet", "vae"]
    assert res["local"] == ["c.safetensors", "u.safetensors", "v.safetensors"]
    assert res["fallback"] == [] and not res["timedOut"]
    for f, n in (("vae", "v"), ("unet", "u"), ("clip", "c")):
        assert (dst / f / f"{n}.safetensors").read_bytes() == data(10 * KB, seed=ord(n))


def test_idempotent_requests_copy_each_file_once(roots):
    src, dst = roots
    reg = fake_registry([("unet", "u.safetensors", 0), ("vae", "shared.safetensors", 0)],
                        [("unet", "u2.safetensors", 0), ("vae", "shared.safetensors", 0)])
    put(src, "unet", "u.safetensors", data(20 * KB))
    put(src, "unet", "u2.safetensors", data(20 * KB, 2))
    put(src, "vae", "shared.safetensors", data(5 * KB, 3))
    calls = []

    def copy(s, d, **kw):
        calls.append(d.name)
        return copy_file(s, d, **kw)

    m = make(roots, reg, copy=copy)
    finished(m, m.request("m0"))
    finished(m, m.request("m0"))
    finished(m, m.request("m1"))  # shares the VAE
    assert sorted(calls) == ["shared.safetensors", "u.safetensors", "u2.safetensors"]
    # A fresh process (e.g. container restart) finds complete copies by size.
    m2 = make(roots, reg, copy=copy)
    res = finished(m2, m2.request("m0"))
    assert res["local"] == ["u.safetensors", "shared.safetensors"]
    assert len(calls) == 3
    # A local file with the wrong size is replaced.
    (dst / "unet" / "u.safetensors").write_bytes(b"truncated")
    m3 = make(roots, reg, copy=copy)
    finished(m3, m3.request("m0"))
    assert (dst / "unet" / "u.safetensors").read_bytes() == data(20 * KB)
    assert calls.count("u.safetensors") == 2


def test_concurrent_requests_share_one_copy(roots):
    src, _ = roots
    reg = fake_registry([("unet", "u.safetensors", 0), ("clip", "c.safetensors", 0)])
    put(src, "unet", "u.safetensors", data(64 * KB))
    put(src, "clip", "c.safetensors", data(64 * KB, 2))
    gate = threading.Event()
    calls = []

    def copy(s, d, **kw):
        calls.append(d.name)
        gate.wait(5)
        return copy_file(s, d, **kw)

    m = make(roots, reg, copy=copy)
    results = []

    def requester():
        e = m.request("m0", front=True)
        results.append(m.wait(e, timeout=10))

    ts = [threading.Thread(target=requester) for _ in range(4)]
    for t in ts:
        t.start()
    time.sleep(0.1)
    gate.set()
    for t in ts:
        t.join(10)
    assert sorted(calls) == ["c.safetensors", "u.safetensors"]
    assert len(results) == 4
    assert all(r["local"] == ["c.safetensors", "u.safetensors"] for r in results)


def test_not_enough_space_skips_and_falls_back(roots, caplog):
    src, dst = roots
    reg = fake_registry([("clip", "c.safetensors", 0), ("unet", "u.safetensors", 0)])
    put(src, "clip", "c.safetensors", data(10 * KB))
    put(src, "unet", "u.safetensors", data(50 * KB))

    class Usage:
        free = 30 * KB

    calls = []

    def copy(s, d, **kw):
        calls.append(d.name)
        return copy_file(s, d, **kw)

    m = make(roots, reg, disk_usage=lambda p: Usage, copy=copy)
    with caplog.at_level("INFO", logger="image_studio.local_models"):
        res = finished(m, m.request("m0"))
    assert res["local"] == ["c.safetensors"] and res["fallback"] == ["u.safetensors"]
    assert calls == ["c.safetensors"]  # the unet was never started
    assert not (dst / "unet" / "u.safetensors").exists()
    assert "skipping unet/u.safetensors: not enough space" in caplog.text
    h = m.health()["m0"]
    assert h["state"] == "skipped"
    assert [f["state"] for f in h["files"]] == ["done", "skipped"]


def test_reserve_counts_against_free_space(roots):
    src, _ = roots
    reg = fake_registry([("clip", "c.safetensors", 0)])
    put(src, "clip", "c.safetensors", data(10 * KB))

    class Usage:
        free = 20 * KB

    m = make(roots, reg, disk_usage=lambda p: Usage, reserve=15 * KB)
    assert finished(m, m.request("m0"))["fallback"] == ["c.safetensors"]


def test_failure_falls_back_and_is_retried_once(roots, caplog):
    src, dst = roots
    reg = fake_registry([("unet", "u.safetensors", 0)])
    put(src, "unet", "u.safetensors", data(10 * KB))
    calls = []

    def copy(s, d, **kw):
        calls.append(1)
        raise OSError(5, "Input/output error")

    m = make(roots, reg, copy=copy)
    with caplog.at_level("WARNING", logger="image_studio.local_models"):
        res = finished(m, m.request("m0"))
    assert res["fallback"] == ["u.safetensors"] and res["local"] == []
    assert "it loads from the volume" in caplog.text
    assert m.health()["m0"]["state"] == "failed"
    finished(m, m.request("m0"))         # second attempt
    finished(m, m.request("m0"))         # no third
    assert len(calls) == local_models.MAX_ATTEMPTS
    assert local_models.begin_for_job("m0") is None  # no manager installed: nothing to wait for


def test_missing_source_and_unknown_model(roots):
    reg = fake_registry([("unet", "nope.safetensors", 0)])
    m = make(roots, reg)
    res = finished(m, m.request("m0"))
    assert res["fallback"] == ["nope.safetensors"]
    assert m.health()["m0"]["state"] == "missing"
    assert m.request("does-not-exist") is None


def test_job_request_preempts_a_prefetch_of_another_model(roots):
    src, dst = roots
    reg = fake_registry([("unet", "big.safetensors", 0)], [("unet", "small.safetensors", 0)])
    put(src, "unet", "big.safetensors", data(256 * KB))
    put(src, "unet", "small.safetensors", data(8 * KB, 2))
    started = threading.Event()
    calls = []

    def copy(s, d, *, cancel=None, **kw):
        calls.append(d.name)
        if d.name == "big.safetensors" and calls.count("big.safetensors") == 1:
            started.set()
            assert cancel.wait(5), "preempted"
            raise local_models.CopyCancelled("cancelled")
        return copy_file(s, d, cancel=cancel, **kw)

    m = make(roots, reg, copy=copy)
    prefetch = m.request("m0")
    assert started.wait(5)
    job = m.request("m1", front=True)
    assert finished(m, job)["local"] == ["small.safetensors"]
    # the prefetch resumes afterwards (from scratch) and completes
    assert finished(m, prefetch)["local"] == ["big.safetensors"]
    assert calls == ["big.safetensors", "small.safetensors", "big.safetensors"]
    assert (dst / "unet" / "big.safetensors").read_bytes() == data(256 * KB)


def test_invalidate_drops_the_local_copy(roots):
    src, dst = roots
    reg = fake_registry([("unet", "u.safetensors", 0)])
    put(src, "unet", "u.safetensors", data(10 * KB))
    m = make(roots, reg)
    finished(m, m.request("m0"))
    assert (dst / "unet" / "u.safetensors").exists()
    m.invalidate("unet", "u.safetensors")
    assert not (dst / "unet" / "u.safetensors").exists()
    assert m.health()["m0"]["state"] == "idle"
    put(src, "unet", "u.safetensors", data(10 * KB, 9))   # new content on the volume
    finished(m, m.request("m0"))
    assert (dst / "unet" / "u.safetensors").read_bytes() == data(10 * KB, 9)


def test_wait_timeout_and_cancel(roots):
    src, _ = roots
    reg = fake_registry([("unet", "u.safetensors", 0)])
    put(src, "unet", "u.safetensors", data(10 * KB))
    gate = threading.Event()

    def copy(s, d, **kw):
        gate.wait(10)
        return copy_file(s, d, **kw)

    m = make(roots, reg, copy=copy)
    entries = m.request("m0")
    res = m.wait(entries, timeout=0.2, poll_s=0.05)
    assert res["timedOut"] and res["fallback"] == ["u.safetensors"]
    ev = threading.Event()
    ev.set()
    assert m.wait(entries, cancel=ev, poll_s=0.05)["cancelled"]
    gate.set()
    assert finished(m, entries)["local"] == ["u.safetensors"]


def test_health_fields_while_copying_and_done(roots):
    src, _ = roots
    reg = fake_registry([("unet", "u.safetensors", 64 * KB)])
    put(src, "unet", "u.safetensors", data(64 * KB))
    half, gate = threading.Event(), threading.Event()

    def copy(s, d, *, on_bytes=None, **kw):
        on_bytes(32 * KB)
        time.sleep(0.02)
        half.set()
        gate.wait(5)
        on_bytes(32 * KB)
        return copy_file(s, d, **kw)

    m = make(roots, reg, copy=copy)
    entries = m.request("m0")
    assert half.wait(5)
    h = m.health()["m0"]
    assert h["state"] == "copying"
    assert (h["doneBytes"], h["totalBytes"]) == (32 * KB, 64 * KB)
    assert h["MBps"] > 0
    assert h["files"][0]["state"] == "copying"
    gate.set()
    finished(m, entries)
    h = m.health()["m0"]
    assert h["state"] == "done" and h["doneBytes"] == h["totalBytes"] == 64 * KB
    assert set(h) == {"state", "doneBytes", "totalBytes", "MBps", "files"}


# ---------------------------------------------------------------------------
# env / process-wide manager
# ---------------------------------------------------------------------------
def test_init_from_env(tmp_path, registry):
    assert local_models.init_from_env({"MODE": ""}) is None
    assert local_models.init_from_env({"MODE": "pod", "LOCAL_MODELS": "0"}) is None
    root = tmp_path / "ml"
    (root / "unet").mkdir(parents=True)
    (root / "unet" / "x.safetensors.1234.part").write_bytes(b"x")
    try:
        m = local_models.init_from_env({"MODE": "pod", "LOCAL_MODELS_ROOT": str(root),
                                        "MODELS_ROOT": str(tmp_path / "vol"),
                                        "LOCAL_COPY_THREADS": "32"},
                                       registry=lambda: registry)
        assert m is not None and local_models.get() is m
        assert m.threads == 32 and m.chunk == 64 * local_models.MiB
        assert m.dst_root == root and m.src_root == tmp_path / "vol"
        assert list((root / "unet").iterdir()) == []   # stale .part removed
    finally:
        local_models.set_manager(None)


def test_prefetch_ids(registry):
    env = {"PREFETCH_MODELS": " h3, flux2,,h3 ,bogus"}
    assert local_models.prefetch_ids(env, registry) == ["h3", "flux2"]
    assert local_models.prefetch_ids({}, registry) == []


# ---------------------------------------------------------------------------
# handler: on-demand wait + "copying_models" stage
# ---------------------------------------------------------------------------
@pytest.fixture
def local_mgr(tmp_path):
    made = []

    def build(models: Path, **kw):
        kw.setdefault("threads", 2)
        kw.setdefault("chunk", KB)
        kw.setdefault("reserve", 0)
        m = LocalModels(handler.load_registry, models, tmp_path / "models-local", **kw)
        local_models.set_manager(m)
        made.append(m)
        return m

    yield build
    local_models.set_manager(None)
    for m in made:
        m.close()


def test_copying_models_stage_in_a_generate_job(env, local_mgr):  # noqa: F811
    env.install("flux2")
    env.fake(steps=4)
    (env.comfy / "output" / "image_studio_00001_.png").write_bytes(b"x")
    gate, half = threading.Event(), threading.Event()

    def copy(s, d, *, on_bytes=None, **kw):
        if d.parent.name == "clip":  # first file: hold it half done
            on_bytes(0)
            env.clock.advance(1)       # let the throttled progress through
            half.set()
            gate.wait(5)
        return copy_file(s, d, on_bytes=on_bytes, **kw)

    m = local_mgr(env.models, copy=copy)
    out = {}
    t = threading.Thread(target=lambda: out.update(handler.handler(gen_input())))
    t.start()
    assert half.wait(5)
    wait_for(lambda: any("copyPercent" in p for p in env.sent))
    gate.set()
    t.join(10)
    assert "error" not in out, out
    first = env.sent[0]
    assert first["stage"] == "copying_models" and first["phase"] == "loading"
    assert first["stages"][0] == "copying_models"
    assert first["stages"][1:] == ["loading_text_encoder", "encoding_prompt", "loading_model",
                                   "sampling", "decoding", "saving"]
    copying = [p for p in env.sent if p["stage"] == "copying_models" and "copyPercent" in p]
    assert copying and copying[-1]["copyPercent"] == 100
    assert copying[-1]["copyBytes"] == copying[-1]["copyTotalBytes"] == 3  # three 1-byte files
    assert "copying_models" in env.sent[-1]["stageTimes"]
    assert env.sent[-1]["stage"] == "saving"
    # the files are now local, under the same folder/name layout
    for f in next(x for x in env.registry["models"] if x["id"] == "flux2")["files"]:
        assert (m.dst_root / f["folder"] / f["filename"]).read_bytes() == b"w"
    # a second job finds everything local: no copy stage at all
    env.sent.clear()
    (env.comfy / "output" / "image_studio_00001_.png").write_bytes(b"x")
    env.fake(steps=4)
    assert "error" not in handler.handler(gen_input())
    assert env.sent[0]["stage"] == "loading_text_encoder"
    assert all("copying_models" not in p["stages"] and "copyPercent" not in p for p in env.sent)


def test_copier_failure_never_fails_the_job(env, local_mgr, monkeypatch):  # noqa: F811
    env.install("flux2")
    env.fake(steps=4)
    (env.comfy / "output" / "image_studio_00001_.png").write_bytes(b"x")

    def broken(*a, **kw):
        raise OSError(28, "No space left on device")

    local_mgr(env.models, copy=broken)
    out = handler.handler(gen_input())
    assert "error" not in out, out
    assert env.sent[0]["stage"] == "copying_models"
    # and a copier whose wait itself blows up is ignored too
    env.sent.clear()
    m = local_mgr(env.models)
    monkeypatch.setattr(m, "wait", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    env.fake(steps=4)
    (env.comfy / "output" / "image_studio_00001_.png").write_bytes(b"x")
    assert "error" not in handler.handler(gen_input())


def test_job_waits_at_most_local_copy_wait_s(env, local_mgr, monkeypatch):  # noqa: F811
    env.install("flux2")
    env.fake(steps=4)
    (env.comfy / "output" / "image_studio_00001_.png").write_bytes(b"x")
    gate = threading.Event()

    def stuck(s, d, **kw):
        gate.wait(10)
        return copy_file(s, d, **kw)

    local_mgr(env.models, copy=stuck)
    monkeypatch.setattr(handler, "LOCAL_COPY_WAIT_S", 0.2)
    t0 = time.monotonic()
    out = handler.handler(gen_input())
    gate.set()
    assert "error" not in out, out
    assert time.monotonic() - t0 < 3


def test_cancel_while_copying(env, local_mgr):  # noqa: F811
    env.install("flux2")
    env.fake(steps=4)
    gate = threading.Event()

    def stuck(s, d, **kw):
        gate.wait(10)
        return copy_file(s, d, **kw)

    local_mgr(env.models, copy=stuck)
    ev = threading.Event()
    job = gen_input()
    job[handler.CANCEL_EVENT] = ev
    out = {}
    t = threading.Thread(target=lambda: out.update(handler.handler(job)))
    t.start()
    wait_for(lambda: env.sent)
    ev.set()
    t.join(10)
    gate.set()
    assert out["error"].startswith("CANCELLED")


def test_copying_models_stage_in_a_video_job(venv, local_mgr, monkeypatch):  # noqa: F811
    venv.install("h3")
    venv.fake(steps=20)
    for name in (f"{VIDEO_PREFIX}_00001_.mp4", f"{POSTER_PREFIX}_00001_.png"):
        (venv.comfy / "output" / name).write_bytes(b"x")
    monkeypatch.setattr(handler, "poster_jpeg", lambda png: (b"\xff\xd8\xffJPEG", "image/jpeg"))
    m = local_mgr(venv.models)
    out = handler.handler(vid_input(steps=20))
    assert "error" not in out, out
    assert venv.sent[0]["stages"][0] == "copying_models"
    assert m.health()["h3"]["state"] == "done"
    assert [f["folder"] for f in m.health()["h3"]["files"]] == ["clip", "unet", "vae", "vae"]


def test_delete_and_download_invalidate_local_copies(env, local_mgr, monkeypatch):  # noqa: F811
    env.install("flux2")
    m = local_mgr(env.models)
    m.wait(m.request("flux2"), timeout=10)
    unet = next(f for f in env.registry["models"] if f["id"] == "flux2")["files"]
    name = next(f["filename"] for f in unet if f["folder"] == "unet")
    assert (m.dst_root / "unet" / name).exists()
    monkeypatch.setattr(handler, "make_client", lambda: type("C", (), {"is_up": lambda s: False})())
    out = handler.handler({"id": "d", "input": {"action": "delete",
                                                "files": [{"folder": "unet", "filename": name}]}})
    assert out["deleted"] == [name]
    assert not (m.dst_root / "unet" / name).exists()


def test_copy_stage_is_known():
    assert STAGES[0] == "copying_models" and STAGE_PHASE["copying_models"] == "loading"


# ---------------------------------------------------------------------------
# warm-up
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("mid", ["chroma", "zimage", "flux2", "qwen", "h3", "ltx25"])
def test_warmup_input_is_the_cheapest_valid_job(mid, registry):
    inp = server.warmup_input(registry, mid)
    if inp["action"] == "generate":
        p = handler.validate_generate(inp, registry)
        assert (p["width"], p["height"], p["steps"]) == (256, 256, 1)
        handler.build_workflow({**p, "references": []}, registry)
    else:
        p = handler.validate_generate_video(inp, registry)
        model = next(m for m in registry["videoModels"] if m["id"] == mid)
        sizes = [tuple(map(int, r.split("x"))) for r in model["limits"]["resolutions"]]
        w, h = map(int, p["resolution"].split("x"))
        assert w * h == min(a * b for a, b in sizes)
        assert p["durationS"] == model["limits"]["minDurationS"] and p["steps"] == 1
        handler.build_video_workflow(p, registry)
    assert server.warmup_input(registry, "nope") is None


class GatedRun:
    def __init__(self):
        self.calls = []
        self.gate = threading.Event()
        self.entered = threading.Event()

    def __call__(self, job):
        self.calls.append(job["input"].get("tag") or job["id"])
        self.entered.set()
        self.gate.wait(10)
        return {"ok": 1}


def test_warmup_runs_when_idle_and_is_not_watchdog_activity():
    clock = FakeClock()
    run = GatedRun()
    mgr = server.JobManager(run_job=run, interrupt=lambda: None, clock=clock)
    wd, calls = make_watchdog(clock, mgr, idle_s=1800)
    try:
        warm = server.WarmUp(mgr, "flux2", {"action": "generate", "model": "flux2"},
                             comfy_up=lambda: True)
        t = threading.Thread(target=warm.run)
        t.start()
        assert run.entered.wait(5)
        assert warm.status()["state"] == "running"
        assert run.calls[0].startswith("warmup-")
        # Not a job: nothing listed or active, and the idle clock keeps running.
        assert mgr.counts() == {"inQueue": 0, "inProgress": 0, "completed": 0, "failed": 0}
        assert mgr.active() == 0
        clock.advance(1800)
        assert wd.check() is True and len(calls) == 1   # idle: the pod may stop
        run.gate.set()
        t.join(5)
        assert warm.status()["state"] == "done"
        assert mgr.last_finished is None                  # never counted as activity
    finally:
        run.gate.set()
        mgr.shutdown()


def test_warmup_skipped_after_a_real_job():
    run = GatedRun()
    run.gate.set()
    mgr = server.JobManager(run_job=run, interrupt=lambda: None)
    try:
        mgr.submit({"action": "generate", "tag": "real"})
        wait_for(lambda: "real" in run.calls)
        warm = server.WarmUp(mgr, "flux2", {"action": "generate"}, comfy_up=lambda: True)
        warm.run()
        assert warm.status()["state"] == "skipped"
        assert run.calls == ["real"]
    finally:
        mgr.shutdown()


def test_warmup_skipped_while_waiting_for_comfyui_if_a_job_arrives():
    run = GatedRun()
    mgr = server.JobManager(run_job=run, interrupt=lambda: None)
    try:
        polls = []

        def comfy_up():
            polls.append(1)
            if len(polls) == 2:
                mgr.submit({"action": "generate", "tag": "real"})
            return False

        warm = server.WarmUp(mgr, "flux2", {"action": "generate"}, comfy_up=comfy_up,
                             sleep=lambda s: None)
        warm.run()
        assert warm.status() == {"model": "flux2", "state": "skipped",
                                 "detail": "a real job arrived first"}
    finally:
        run.gate.set()
        mgr.shutdown()


def test_real_job_waits_only_for_the_warmup_in_flight():
    run = GatedRun()
    mgr = server.JobManager(run_job=run, interrupt=lambda: None)
    try:
        warm = server.WarmUp(mgr, "flux2", {"action": "generate"}, comfy_up=lambda: True)
        t = threading.Thread(target=warm.run)
        t.start()
        assert run.entered.wait(5)
        job = mgr.submit({"action": "generate", "tag": "real"})
        time.sleep(0.1)
        assert mgr.view(job.id)["status"] == "IN_QUEUE"  # behind the warm-up in flight
        assert len(run.calls) == 1
        run.gate.set()
        wait_for(lambda: mgr.view(job.id)["status"] == "COMPLETED")
        assert run.calls[1] == "real"
        t.join(5)
        # no second warm-up once a real job exists
        assert mgr.run_idle(lambda: run.calls.append("again")) is False
    finally:
        run.gate.set()
        mgr.shutdown()


def test_warmup_waits_for_the_prefetch_copy(roots):
    src, _ = roots
    reg = fake_registry([("unet", "u.safetensors", 0)])
    put(src, "unet", "u.safetensors", data(10 * KB))
    gate = threading.Event()

    def copy(s, d, **kw):
        gate.wait(10)
        return copy_file(s, d, **kw)

    local = make(roots, reg, copy=copy)
    run = GatedRun()
    run.gate.set()
    mgr = server.JobManager(run_job=run, interrupt=lambda: None)
    try:
        warm = server.WarmUp(mgr, "m0", {"action": "generate"}, local=local,
                             comfy_up=lambda: True)
        t = threading.Thread(target=warm.run)
        t.start()
        wait_for(lambda: warm.status()["state"] == "waiting_copy")
        time.sleep(0.1)
        assert run.calls == []
        gate.set()
        t.join(5)
        assert warm.status()["state"] == "done" and len(run.calls) == 1
    finally:
        mgr.shutdown()


def test_warmup_failure_is_reported_not_raised():
    mgr = server.JobManager(run_job=lambda j: {"error": "COMFYUI_EXECUTION_ERROR: x"},
                            interrupt=lambda: None)
    try:
        warm = server.WarmUp(mgr, "flux2", {"action": "generate"}, comfy_up=lambda: True)
        warm.run()
        assert warm.status()["state"] == "failed"
        assert "COMFYUI_EXECUTION_ERROR" in warm.status()["detail"]
    finally:
        mgr.shutdown()


def test_start_prefetch_queues_models(tmp_path, monkeypatch, registry):
    vol = tmp_path / "vol" / "models"
    (vol / "unet").mkdir(parents=True)
    env = {"MODE": "pod", "LOCAL_MODELS_ROOT": str(tmp_path / "ml"), "MODELS_ROOT": str(vol),
           "PREFETCH_MODELS": "flux2", "WARMUP": "0"}
    mgr = server.JobManager(run_job=lambda j: {}, interrupt=lambda: None)
    try:
        local, warm = server.start_prefetch(mgr, env)
        assert local is not None and warm is None
        local.wait(local.request("flux2"), timeout=10)
        assert local.health()["flux2"]["state"] == "missing"  # nothing on this fake volume
        local_models.set_manager(None)
        local2, warm2 = server.start_prefetch(mgr, {**env, "MODE": "", "WARMUP": "1"})
        assert local2 is None and warm2 is not None   # warm-up still useful without copies
        assert warm2.inp["model"] == "flux2"
    finally:
        local_models.set_manager(None)
        mgr.shutdown()


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------
def test_health_exposes_local_models_and_warmup(roots):
    src, _ = roots
    reg = fake_registry([("unet", "u.safetensors", 0)])
    put(src, "unet", "u.safetensors", data(10 * KB))
    local = make(roots, reg)
    local.wait(local.request("m0"), timeout=10)
    mgr = server.JobManager(run_job=lambda j: {}, interrupt=lambda: None)
    warm = server.WarmUp(mgr, "m0", {})
    health = server.Health(mgr, comfy_up=lambda: True, gpu=lambda: "G",
                           comfy_version=lambda: "0.39.0", code=lambda: None,
                           local_models=local.health, warmup=warm.status)
    srv = Running(server.build_app(TOKEN, mgr, health))
    try:
        h = srv.get("/health").json()
        lm = h["localModels"]["m0"]
        assert {k: lm[k] for k in ("state", "doneBytes", "totalBytes")} == \
            {"state": "done", "doneBytes": 10 * KB, "totalBytes": 10 * KB}
        assert isinstance(lm["MBps"], (int, float))
        assert lm["files"][0]["filename"] == "u.safetensors"
        assert h["warmup"] == {"model": "m0", "state": "pending"}
        json.dumps(h)
    finally:
        srv.close()
        mgr.shutdown()
