#!/usr/bin/env python3
"""THROWAWAY spike (Stories Task 14): does `h3ref` honour a continuing shot's first frame?

Not imported by anything. Standard library + ffmpeg only. Run with `python3 -I`.
Talks straight to the running video GPU pod's worker server (it never starts or
stops pods). Protocol, all runs model h3ref, 864x480, 5 s, no audio, seed 1234:

  Run 1  (cut):        refs [character]                       -> run1.mp4, last.png
  Run 2A (continues):  refs [character, last.png] + initImage=last.png (frame-0 guide)
  Run 2B (continues):  refs [character, last.png], picture anchor only

For 2A/2B, frame 0 is compared with last.png (mean absolute difference, 0-255,
216x120 grayscale) and against a control (run 1 frame 0 vs last.png). Prompts are
hand-copied from app/src-tauri/src/stories/compile.rs (six-section format).

  python3 -I scripts/spike_h3ref_first_frame.py [--pod <id>] [--out <dir>] [--dry-run]
"""
import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

CHAR_URL = ("https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/"
            "input/portrait_model_denim.png")
TOKEN_PATH = os.path.expanduser("~/Library/Application Support/com.naren.imagestudio/pod_token")
LOG_PATH = os.path.expanduser("~/Library/Logs/Image Studio/app.log")
DEFAULT_OUT = ("/private/tmp/claude-501/-Users-narendhupati-Documents-testim/"
               "fb8d5ef7-3a79-462e-9046-dffe4d645beb/scratchpad/spike/")
SEED = 1234
CMP_W, CMP_H = 216, 120

# ---------------------------------------------------------------------------
# Prompts (mirror compile_shot: one subject, no dialogue, empty style/sound)

STYLE = "The target video is in a live-action, cinematic style."
CAMERA = "Static shot."
SETTING = "A sunny street."
PLACE = "a sunny street"


def compile_prompt(action: str, has_first_frame: bool) -> str:
    defs = ["subject_definitions:",
            "<Subject 1> is Ava, the person in <Picture 1>: woman in her 20s in a denim shirt."]
    keep = ["retention_analysis:",
            "<Subject 1> (appears in [Shot 1]): fully_preserved - Ava's face, hair, body and "
            "clothing from <Picture 1> are retained."]
    body = []
    if has_first_frame:
        defs.append("<Picture 2> is the first frame of [Shot 1], the last frame of the previous shot.")
        keep.append("<Picture 2> ([Shot 1] first frame): fully_preserved - the shot starts "
                    "exactly from this frame.")
        body.append("The shot begins from <Picture 2>.")
    task = ("[keyframe completion + reference generation]" if has_first_frame
            else "[reference generation]")
    summary = (f"summary:\n{task} The target video is a single continuous shot of "
               f"<Subject 1> in {PLACE}.")
    body += [CAMERA, SETTING, action, "Only <Subject 1> appears in the shot."]
    detail = f"detailed_description:\n{STYLE}\n[Shot 1] " + " ".join(body)
    sound = (f"overall_soundscape:\nNatural ambient sound of {PLACE}, with soft footsteps "
             "and clothing movement.")
    return "\n\n".join(["\n".join(defs), summary, "\n".join(keep), detail, sound,
                        "non_diegetic_music:\nN/A"])


ACTION_1 = "<Subject 1> walks slowly toward the camera along the sunny street."
ACTION_2 = "<Subject 1> stops and looks up at a sign."

# ---------------------------------------------------------------------------
# helpers


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def ffmpeg(*args: str) -> bytes:
    p = subprocess.run(["ffmpeg", "-v", "error", "-y", *args], capture_output=True)
    if p.returncode != 0:
        die("ffmpeg " + " ".join(args) + "\n" + p.stderr.decode(errors="replace"))
    return p.stdout


def png_size(data: bytes) -> tuple[int, int] | None:
    if data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
        return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    return None


def gray(path: str) -> bytes:
    raw = ffmpeg("-i", path, "-vf", f"scale={CMP_W}:{CMP_H},format=gray",
                 "-frames:v", "1", "-f", "rawvideo", "-")
    if len(raw) != CMP_W * CMP_H:
        die(f"unexpected raw size {len(raw)} for {path}")
    return raw


def mad(a: str, b: str) -> float:
    x, y = gray(a), gray(b)
    return sum(abs(p - q) for p, q in zip(x, y)) / len(x)


def pod_id_from_log() -> str | None:
    try:
        with open(LOG_PATH, encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return None
    for line in reversed(lines):
        m = re.search(r"\[gpu\] video \S*→Running .*pod=(\S+)", line)
        if m and m.group(1) != "-":
            return m.group(1)
    return None


def ref(name: str, data: bytes) -> dict:
    return {"name": name, "base64": base64.b64encode(data).decode("ascii")}


def payload(prompt: str, refs: list[tuple[str, bytes]], init: tuple[str, bytes] | None) -> dict:
    inp = {"action": "generate_video", "model": "h3ref", "prompt": prompt,
           "references": [ref(n, d) for n, d in refs], "durationS": 5,
           "resolution": "864x480", "audio": False, "seed": SEED}
    if init is not None:
        inp["initImage"] = ref(*init)
    return {"input": inp}


class Pod:
    def __init__(self, pod: str, token: str):
        self.base = f"https://{pod}-8000.proxy.runpod.net"
        self.token = token

    def call(self, method: str, path: str, body: dict | None = None) -> dict:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            die(f"{method} {path} -> HTTP {e.code}: {e.read()[:500]!r}")

    def run(self, label: str, body: dict) -> tuple[str, dict, dict]:
        job = self.call("POST", "/run", body)["id"]
        print(f"[{label}] job {job} queued", flush=True)
        last = None
        while True:
            st = self.call("GET", f"/status/{job}")
            s = st.get("status")
            if s != last:
                print(f"[{label}] {s}", flush=True)
                last = s
            if s == "COMPLETED":
                return job, st, st.get("output") or {}
            if s in ("FAILED", "CANCELLED", "TIMED_OUT"):
                die(f"[{label}] job {job} {s}: {st.get('error')}")
            time.sleep(5)


def save_video(out: dict, path: str) -> None:
    v = out.get("video") or {}
    if not v.get("base64"):
        die(f"no video in output: {list(out)}")
    with open(path, "wb") as f:
        f.write(base64.b64decode(v["base64"]))


def gpu_seconds(st: dict, out: dict) -> str:
    t = out.get("timings") or {}
    return (f"exec {st.get('executionTime', 0) / 1000:.1f}s, total {t.get('totalMs', 0) / 1000:.1f}s "
            f"(load {t.get('loadMs', 0) / 1000:.1f}s, sample {t.get('sampleMs', 0) / 1000:.1f}s)")


def describe(label: str, body: dict) -> None:
    inp = body["input"]
    refs = ", ".join(f"{r['name']} ({len(base64.b64decode(r['base64']))} B)"
                     for r in inp["references"])
    init = inp.get("initImage")
    init_s = f"{init['name']} ({len(base64.b64decode(init['base64']))} B)" if init else "none"
    print(f"=== {label}: refs [{refs}]; initImage {init_s}; prompt {len(inp['prompt'])} chars; "
          f"payload {len(json.dumps(body))} B")
    print(inp["prompt"])
    print()


# ---------------------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--pod")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    out = a.out
    os.makedirs(out, exist_ok=True)
    P = lambda n: os.path.join(out, n)  # noqa: E731

    char_path = P("portrait_model_denim.png")
    if not os.path.exists(char_path):
        with urllib.request.urlopen(CHAR_URL, timeout=60) as r:
            data = r.read()
        if png_size(data) is None:
            die("character download is not a PNG")
        with open(char_path, "wb") as f:
            f.write(data)
    with open(char_path, "rb") as f:
        char = f.read()
    print(f"character: {char_path} {png_size(char)}")

    p1 = compile_prompt(ACTION_1, False)
    p2 = compile_prompt(ACTION_2, True)
    body1 = payload(p1, [("ava.png", char)], None)

    if a.dry_run:
        # last.png does not exist yet: a 1x1 placeholder stands in for its size.
        ph = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgAB"
                              "SK+kcQAAAABJRU5ErkJggg==")
        describe("Run 1 (cut)", body1)
        describe("Run 2A (continues + initImage)",
                 payload(p2, [("ava.png", char), ("last.png", ph)], ("last.png", ph)))
        describe("Run 2B (continues, anchor only)",
                 payload(p2, [("ava.png", char), ("last.png", ph)], None))
        print("dry-run summary:")
        print(f"  Run 1 : h3ref 864x480 5s seed {SEED}, refs [ava.png], no initImage, prompt {len(p1)} chars")
        print(f"  Run 2A: h3ref 864x480 5s seed {SEED}, refs [ava.png, last.png], initImage last.png, prompt {len(p2)} chars")
        print(f"  Run 2B: h3ref 864x480 5s seed {SEED}, refs [ava.png, last.png], no initImage, prompt {len(p2)} chars")
        return

    pod_id = a.pod or pod_id_from_log()
    if not pod_id:
        die("no pod id: pass --pod <id> (no Running video pod found in the app log)")
    try:
        with open(TOKEN_PATH) as f:
            token = f.read().strip()
    except OSError as e:
        die(f"cannot read pod token: {e}")
    pod = Pod(pod_id, token)
    print(f"pod {pod_id}; out {out}")

    job1, st1, o1 = pod.run("run1", body1)
    save_video(o1, P("run1.mp4"))
    ffmpeg("-sseof", "-0.1", "-i", P("run1.mp4"), "-frames:v", "1", "-update", "1", P("last.png"))
    ffmpeg("-i", P("run1.mp4"), "-frames:v", "1", P("run1_first.png"))
    with open(P("last.png"), "rb") as f:
        last = f.read()
    control = mad(P("run1_first.png"), P("last.png"))
    print(f"run1: job {job1}; {gpu_seconds(st1, o1)}; control MAD(run1 frame0, last) = {control:.2f}")

    results = []
    for tag, init in (("2A", ("last.png", last)), ("2B", None)):
        body = payload(p2, [("ava.png", char), ("last.png", last)], init)
        job, st, o = pod.run(f"run{tag}", body)
        mp4, first = P(f"run{tag}.mp4"), P(f"run{tag}_first.png")
        save_video(o, mp4)
        ffmpeg("-i", mp4, "-frames:v", "1", first)
        m = mad(first, P("last.png"))
        verdict = "ANCHORS WELL" if m < 0.5 * control else "does NOT anchor"
        results.append((tag, job, gpu_seconds(st, o), m, verdict))

    sheet = P("sheet_last__2A-first__2B-first.png")
    sc = "scale=864:480,setsar=1"
    ffmpeg("-i", P("last.png"), "-i", P("run2A_first.png"), "-i", P("run2B_first.png"),
           "-filter_complex", f"[0]{sc}[a];[1]{sc}[b];[2]{sc}[c];[a][b][c]hstack=inputs=3",
           "-frames:v", "1", sheet)

    print("\n=== results (MAD 0-255, 216x120 gray; anchors well if < 0.5 x control) ===")
    print(f"run1 : job {job1}; {gpu_seconds(st1, o1)}; control MAD = {control:.2f}")
    for tag, job, secs, m, verdict in results:
        print(f"run{tag}: job {job}; {secs}; MAD(first, last) = {m:.2f} "
              f"({m / control if control else float('nan'):.2f} x control) -> {verdict}")
    print(f"contact sheet: {sheet}")


if __name__ == "__main__":
    main()
