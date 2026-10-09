"""The worker never logs prompts (spec v6, "Remote side").

Runs `generate` and `generate_video` through the handler and through the pod
server's JobManager (which logs job lifecycle lines) with every logger at
DEBUG and stdout/stderr captured, and checks that the prompt text appears
nowhere - in the happy path, on a ComfyUI execution error, and on a
validation error.
"""

from __future__ import annotations

import logging

import handler
import server
from test_handler import env, gen_input  # noqa: F401  (fixture re-exported for pytest)
from test_video_handler import venv, vid_input  # noqa: F401
from workflows import POSTER_PREFIX, VIDEO_PREFIX

PROMPT = "PRIVATE PROMPT MARKER 7f3a a fox in the snow at dusk"
NEGATIVE = "PRIVATE NEGATIVE MARKER 9c1b"


def _wait(mgr, job_id, timeout=10.0):
    import time

    end = time.time() + timeout
    while time.time() < end:
        j = mgr.get(job_id)
        if j.status in (server.COMPLETED, server.FAILED):
            return j
        time.sleep(0.01)
    raise AssertionError("job did not finish")


def _assert_private(caplog, capfd):
    out, err = capfd.readouterr()
    for text, where in ((caplog.text, "log records"), (out, "stdout"), (err, "stderr")):
        assert PROMPT not in text, f"prompt leaked into {where}:\n{text}"
        assert NEGATIVE not in text, f"negative prompt leaked into {where}:\n{text}"
        assert "MARKER" not in text, f"prompt fragment leaked into {where}:\n{text}"


def test_generate_logs_never_contain_the_prompt(env, caplog, capfd):  # noqa: F811
    env.install("flux2")
    env.fake(steps=4)
    (env.comfy / "output" / "image_studio_00001_.png").write_bytes(b"x")
    caplog.set_level(logging.DEBUG)
    with caplog.at_level(logging.DEBUG):
        # direct (serverless) handler call
        out = handler.handler(gen_input(prompt=PROMPT, negativePrompt=NEGATIVE))
        assert "error" not in out, out
        # pod server queue: logs "job ... queued (action=generate)" etc.
        mgr = server.JobManager(run_job=handler.handler, interrupt=lambda: None)
        try:
            ok = mgr.submit(gen_input(prompt=PROMPT, negativePrompt=NEGATIVE)["input"])
            assert _wait(mgr, ok.id).status == server.COMPLETED
            # execution error path
            env.fake(scenario="error", steps=4)
            bad = mgr.submit(gen_input(prompt=PROMPT, negativePrompt=NEGATIVE)["input"])
            assert _wait(mgr, bad.id).status == server.FAILED
            # validation error path (bad steps) still gets the prompt in the input
            inv = mgr.submit(gen_input(prompt=PROMPT, negativePrompt=NEGATIVE, steps=0)["input"])
            assert _wait(mgr, inv.id).status == server.FAILED
        finally:
            mgr.shutdown()
    assert "queued (action=generate)" in caplog.text, "the lifecycle lines are logged"
    _assert_private(caplog, capfd)


def test_generate_video_logs_never_contain_the_prompt(venv, monkeypatch, caplog, capfd):  # noqa: F811
    venv.install("h3")
    venv.fake(steps=4)
    for name in (f"{VIDEO_PREFIX}_00001_.mp4", f"{POSTER_PREFIX}_00001_.png"):
        (venv.comfy / "output" / name).write_bytes(b"x")
    monkeypatch.setattr(handler, "poster_jpeg", lambda png: (b"\xff\xd8\xffJPEG", "image/jpeg"))
    caplog.set_level(logging.DEBUG)
    with caplog.at_level(logging.DEBUG):
        out = handler.handler(vid_input(prompt=PROMPT, negativePrompt=NEGATIVE, steps=4))
        assert "error" not in out, out
        mgr = server.JobManager(run_job=handler.handler, interrupt=lambda: None)
        try:
            ok = mgr.submit(vid_input(prompt=PROMPT, negativePrompt=NEGATIVE, steps=4)["input"])
            assert _wait(mgr, ok.id).status == server.COMPLETED
            venv.fake(scenario="error", steps=4)
            bad = mgr.submit(vid_input(prompt=PROMPT, negativePrompt=NEGATIVE, steps=4)["input"])
            assert _wait(mgr, bad.id).status == server.FAILED
            inv = mgr.submit(vid_input(prompt=PROMPT, negativePrompt=NEGATIVE, durationS=0)["input"])
            assert _wait(mgr, inv.id).status == server.FAILED
        finally:
            mgr.shutdown()
    assert "queued (action=generate_video)" in caplog.text
    _assert_private(caplog, capfd)
