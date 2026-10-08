"""worker/boot/boot.py: code download, tarball checks, fallback, launch."""

from __future__ import annotations

import ast
import io
import json
import sys
import tarfile
import urllib.error
from pathlib import Path

import pytest

import boot

SHA = "738963e8d81ed5fbdb20ed1f2f22eb4482a0a09b"
OTHER_SHA = "b0b743566f65daafc423b4fea8a2fbda94b3384a"
REPO_ROOT = Path(__file__).resolve().parents[2]

GOOD_FILES = {
    "worker/src/handler.py": "X = 1\n",
    "worker/src/server.py": "import handler\n",
    "worker/src/registry.py": "R = 2\n",
    "worker/src/extra_model_paths.yaml": "image_studio:\n  base_path: /runpod-volume/models\n",
    "shared/models.json": '{"models": []}',
    "README.md": "not extracted",
    "app/src/main.tsx": "not extracted",
    "worker/tests/test_x.py": "not extracted",
}


def make_tarball(files: dict[str, str | bytes] | None = None, *, top: str = "image-studio-main",
                 commit: str | None = SHA, links: dict[str, str] | None = None,
                 raw_names: list[str] | None = None) -> bytes:
    """A .tar.gz shaped like GitHub's codeload archives (git archive): a pax
    global header whose `comment` is the commit, one top-level dir."""
    buf = io.BytesIO()
    pax = {"comment": commit} if commit else {}
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.PAX_FORMAT,
                      pax_headers=pax) as tf:
        d = tarfile.TarInfo(top)
        d.type = tarfile.DIRTYPE
        tf.addfile(d)
        for name, body in (GOOD_FILES if files is None else files).items():
            data = body.encode() if isinstance(body, str) else body
            ti = tarfile.TarInfo(f"{top}/{name}")
            ti.size = len(data)
            tf.addfile(ti, io.BytesIO(data))
        for name, target in (links or {}).items():
            ti = tarfile.TarInfo(f"{top}/{name}")
            ti.type = tarfile.SYMTYPE
            ti.linkname = target
            tf.addfile(ti)
        for name in raw_names or []:
            ti = tarfile.TarInfo(name)
            ti.size = 1
            tf.addfile(ti, io.BytesIO(b"x"))
    return buf.getvalue()


def make_baked(root: Path, commit: str | None = "baked1234") -> Path:
    (root / "src").mkdir(parents=True)
    (root / "src" / "handler.py").write_text("BAKED = True\n")
    (root / "src" / "server.py").write_text("")
    (root / "src" / "extra_model_paths.yaml").write_text("x: 1\n")
    (root / "models.json").write_text("{}")
    if commit:
        (root / "BUILD_INFO.json").write_text(json.dumps({"commit": commit}))
    return root


@pytest.fixture
def dirs(tmp_path):
    return tmp_path / "app", make_baked(tmp_path / "app-baked")


def no_import_check(root: Path) -> None:
    pass


# ---------------------------------------------------------------------------
# extraction
# ---------------------------------------------------------------------------
def test_extracts_only_worker_src_and_registry(tmp_path):
    dest = tmp_path / "out"
    dest.mkdir()
    top, commit = boot.extract_code(make_tarball(), dest)
    assert top == "image-studio-main" and commit == SHA
    got = sorted(str(p.relative_to(dest)) for p in dest.rglob("*") if p.is_file())
    assert got == ["models.json", "src/extra_model_paths.yaml", "src/handler.py",
                   "src/registry.py", "src/server.py"]
    assert (dest / "src" / "handler.py").read_text() == "X = 1\n"


def test_extracts_nested_src_dirs_and_skips_pycache(tmp_path):
    files = dict(GOOD_FILES)
    files["worker/src/pkg/mod.py"] = "Y = 1\n"
    files["worker/src/__pycache__/handler.cpython-312.pyc"] = b"\x00junk"
    dest = tmp_path / "out"
    dest.mkdir()
    boot.extract_code(make_tarball(files), dest)
    assert (dest / "src" / "pkg" / "mod.py").is_file()
    assert not (dest / "src" / "__pycache__").exists()


def test_extract_from_real_layout_of_this_repo(tmp_path):
    """The real worker/src + shared/models.json pass validation."""
    files: dict[str, str | bytes] = {"shared/models.json": (REPO_ROOT / "shared" / "models.json").read_bytes()}
    for p in (REPO_ROOT / "worker" / "src").iterdir():
        if p.is_file() and not p.name.endswith(".pyc"):
            files[f"worker/src/{p.name}"] = p.read_bytes()
    dest = tmp_path / "out"
    dest.mkdir()
    boot.extract_code(make_tarball(files), dest)
    assert {"handler.py", "server.py", "workflows.py", "extra_model_paths.yaml"} <= {
        p.name for p in (dest / "src").iterdir()}


@pytest.mark.parametrize("bad_name", [
    "image-studio-main/../evil.py",
    "image-studio-main/worker/src/../../../etc/passwd",
    "/etc/passwd",
    "image-studio-main/worker/src/..\\x.py",
])
def test_rejects_path_traversal(tmp_path, bad_name):
    dest = tmp_path / "out"
    dest.mkdir()
    with pytest.raises(boot.BootError, match="unsafe path"):
        boot.extract_code(make_tarball(raw_names=[bad_name]), dest)
    assert not (tmp_path / "evil.py").exists()


def test_rejects_symlink_in_extracted_paths(tmp_path):
    dest = tmp_path / "out"
    dest.mkdir()
    with pytest.raises(boot.BootError, match="not a regular file"):
        boot.extract_code(make_tarball(links={"worker/src/link.py": "/etc/passwd"}), dest)


def test_symlink_outside_extracted_paths_is_ignored(tmp_path):
    dest = tmp_path / "out"
    dest.mkdir()
    boot.extract_code(make_tarball(links={"docs/link": "../README.md"}), dest)
    assert not (dest / "docs").exists()


def test_rejects_second_top_level_dir(tmp_path):
    dest = tmp_path / "out"
    dest.mkdir()
    with pytest.raises(boot.BootError, match="top-level"):
        boot.extract_code(make_tarball(raw_names=["other-dir/worker/src/x.py"]), dest)


@pytest.mark.parametrize("drop", ["worker/src/handler.py", "worker/src/server.py",
                                  "worker/src/extra_model_paths.yaml", "shared/models.json"])
def test_rejects_missing_required_file(tmp_path, drop):
    files = {k: v for k, v in GOOD_FILES.items() if k != drop}
    dest = tmp_path / "out"
    dest.mkdir()
    with pytest.raises(boot.BootError, match="missing in code"):
        boot.extract_code(make_tarball(files), dest)


def test_rejects_syntax_error_and_bad_json(tmp_path):
    for key, body, match in [("worker/src/handler.py", "def (:\n", "does not compile"),
                             ("shared/models.json", "{nope", "not valid JSON")]:
        files = dict(GOOD_FILES)
        files[key] = body
        dest = tmp_path / key.replace("/", "_")
        dest.mkdir()
        with pytest.raises(boot.BootError, match=match):
            boot.extract_code(make_tarball(files), dest)


@pytest.mark.parametrize("data", [b"", b"not a tarball", make_tarball()[:200]])
def test_rejects_garbage(tmp_path, data):
    dest = tmp_path / "out"
    dest.mkdir()
    with pytest.raises(boot.BootError):
        boot.extract_code(data, dest)


# ---------------------------------------------------------------------------
# commit parsing
# ---------------------------------------------------------------------------
def _tf(data: bytes) -> tarfile.TarFile:
    tf = tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")
    tf.getmembers()
    return tf


def test_commit_from_pax_comment():
    assert boot.commit_from_tarball(_tf(make_tarball(commit=SHA)), "image-studio-main") == SHA


def test_commit_from_top_dir_when_no_pax_header():
    tf = _tf(make_tarball(commit=None, top=f"image-studio-{OTHER_SHA}"))
    assert boot.commit_from_tarball(tf, f"image-studio-{OTHER_SHA}") == OTHER_SHA


def test_commit_unknown():
    assert boot.commit_from_tarball(_tf(make_tarball(commit=None)), "image-studio-main") is None
    assert boot.commit_from_tarball(_tf(make_tarball(commit="not-a-sha")), "x-main") is None


# ---------------------------------------------------------------------------
# url / fetch
# ---------------------------------------------------------------------------
def test_tarball_url():
    assert boot.tarball_url(boot.DEFAULT_REPO, "main") == \
        "https://codeload.github.com/algotradingfervid/image-studio/tar.gz/main"
    assert boot.tarball_url(boot.DEFAULT_REPO, SHA).endswith("/tar.gz/" + SHA)
    assert boot.tarball_url(boot.DEFAULT_REPO, "feature/x").endswith("/tar.gz/feature/x")


@pytest.mark.parametrize("ref", ["", "../main", "a/../b", "main?x=1", "-rf", "a b", "a//b", "x/"])
def test_tarball_url_rejects_bad_ref(ref):
    with pytest.raises(boot.BootError):
        boot.tarball_url(boot.DEFAULT_REPO, ref)


def test_tarball_url_rejects_bad_repo():
    with pytest.raises(boot.BootError):
        boot.tarball_url("evil.com/x/y", "main")


class FakeResp:
    def __init__(self, data: bytes, status: int = 200):
        self.data, self.status, self.pos = data, status, 0

    def read(self, n: int) -> bytes:
        chunk = self.data[self.pos:self.pos + n]
        self.pos += n
        return chunk

    def getcode(self):
        return self.status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeOpener:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = []

    def __call__(self, req, timeout):
        self.calls.append((req.full_url, timeout, req.get_header("User-agent")))
        o = self.outcomes.pop(0)
        if isinstance(o, BaseException):
            raise o
        return o


def http_error(code):
    return urllib.error.HTTPError("https://x", code, "err", {}, None)


def test_fetch_retries_then_succeeds():
    sleeps = []
    op = FakeOpener([urllib.error.URLError("dns"), http_error(502), FakeResp(b"ok" * 10)])
    assert boot.fetch("https://x", opener=op, sleep=sleeps.append, timeout_s=5) == b"ok" * 10
    assert len(op.calls) == 3 and sleeps == [1.0, 2.0]
    assert op.calls[0][1] == 5 and op.calls[0][2] == "image-studio-boot"


def test_fetch_gives_up_after_three_attempts():
    op = FakeOpener([TimeoutError("t1"), http_error(500), urllib.error.URLError("refused")])
    with pytest.raises(boot.BootError, match="after 3 attempts"):
        boot.fetch("https://x", opener=op, sleep=lambda s: None)
    assert len(op.calls) == 3


def test_fetch_404_is_final():
    op = FakeOpener([http_error(404), FakeResp(b"never")])
    with pytest.raises(boot.BootError, match="404"):
        boot.fetch("https://x", opener=op, sleep=lambda s: None)
    assert len(op.calls) == 1


def test_fetch_total_deadline_per_attempt():
    t = [0.0]

    def clock():
        t[0] += 10.0  # every read "takes" 10 s
        return t[0]
    op = FakeOpener([FakeResp(b"x" * 600_000) for _ in range(3)])
    with pytest.raises(boot.BootError, match="after 3 attempts.*longer than"):
        boot.fetch("https://x", opener=op, sleep=lambda s: None, clock=clock, timeout_s=15)


def test_fetch_size_cap_not_retried():
    op = FakeOpener([FakeResp(b"x" * 1000), FakeResp(b"x")])
    with pytest.raises(boot.TooLarge):
        boot.fetch("https://x", opener=op, sleep=lambda s: None, max_bytes=100)
    assert len(op.calls) == 1


# ---------------------------------------------------------------------------
# prepare_code: GitHub vs baked
# ---------------------------------------------------------------------------
def test_prepare_uses_github_code(dirs):
    app, baked = dirs
    urls = []

    def fetch_fn(url):
        urls.append(url)
        return make_tarball()
    info = boot.prepare_code({"WORKER_REF": "main"}, app, baked, fetch_fn=fetch_fn,
                             import_check_fn=no_import_check)
    assert urls == ["https://codeload.github.com/algotradingfervid/image-studio/tar.gz/main"]
    assert (info.source, info.ref, info.commit, info.root) == ("github", "main", SHA, app)
    assert info.public() == {"source": "github", "ref": "main", "commit": SHA}
    assert (app / "src" / "handler.py").read_text() == "X = 1\n"
    assert not app.with_name("app.new").exists()


def test_prepare_default_ref_is_main_and_replaces_old_app(dirs):
    app, baked = dirs
    (app / "src").mkdir(parents=True)
    (app / "src" / "stale.py").write_text("old")
    urls = []
    info = boot.prepare_code({"WORKER_REF": "  "}, app, baked,
                             fetch_fn=lambda u: urls.append(u) or make_tarball(),
                             import_check_fn=no_import_check)
    assert info.ref == "main" and urls[0].endswith("/tar.gz/main")
    assert not (app / "src" / "stale.py").exists()


def test_prepare_pinned_sha(dirs):
    app, baked = dirs
    info = boot.prepare_code({"WORKER_REF": OTHER_SHA}, app, baked,
                             fetch_fn=lambda u: make_tarball(commit=OTHER_SHA,
                                                             top=f"image-studio-{OTHER_SHA}"),
                             import_check_fn=no_import_check)
    assert (info.source, info.commit) == ("github", OTHER_SHA)


def test_prepare_sha_mismatch_falls_back(dirs):
    app, baked = dirs
    info = boot.prepare_code({"WORKER_REF": OTHER_SHA}, app, baked,
                             fetch_fn=lambda u: make_tarball(commit=SHA),
                             import_check_fn=no_import_check)
    assert info.source == "baked" and "does not match" in info.error


def test_prepare_falls_back_on_http_failure(dirs, capsys):
    app, baked = dirs
    op = FakeOpener([http_error(503), urllib.error.URLError("x"), TimeoutError("y")])

    def fetch_fn(url):
        return boot.fetch(url, opener=op, sleep=lambda s: None)
    info = boot.prepare_code({}, app, baked, fetch_fn=fetch_fn, import_check_fn=no_import_check)
    assert (info.source, info.ref, info.commit, info.root) == ("baked", "main", "baked1234", baked)
    assert "after 3 attempts" in info.error
    assert info.public()["error"] == info.error
    out = capsys.readouterr().out
    assert "FALLBACK" in out and "BAKED copy" in out and "baked1234" in out
    assert not app.exists() and not app.with_name("app.new").exists()


@pytest.mark.parametrize("bad", ["traversal", "missing", "garbage", "import"])
def test_prepare_falls_back_on_bad_tarball(dirs, bad):
    app, baked = dirs
    data = {
        "traversal": make_tarball(raw_names=["image-studio-main/../../x"]),
        "missing": make_tarball({"worker/src/handler.py": "X=1"}),
        "garbage": b"\x1f\x8b garbage",
        "import": make_tarball(),
    }[bad]

    def failing_import(root):
        raise boot.BootError("import handler/server failed: ModuleNotFoundError")
    info = boot.prepare_code({}, app, baked, fetch_fn=lambda u: data,
                             import_check_fn=failing_import if bad == "import" else no_import_check)
    assert info.source == "baked" and info.root == baked
    assert not app.exists() and not app.with_name("app.new").exists()


def test_prepare_baked_on_request_and_on_bad_ref(dirs):
    app, baked = dirs
    called = []
    for env in ({"WORKER_CODE_SOURCE": "baked"}, {"WORKER_REF": "../x"}):
        info = boot.prepare_code(env, app, baked, fetch_fn=lambda u: called.append(u),
                                 import_check_fn=no_import_check)
        assert info.source == "baked"
    assert called == []


def test_prepare_fatal_when_baked_copy_is_broken(tmp_path):
    baked = tmp_path / "baked"
    baked.mkdir()
    with pytest.raises(SystemExit, match="FATAL"):
        boot.prepare_code({}, tmp_path / "app", baked, fetch_fn=lambda u: b"",
                          import_check_fn=no_import_check)


def test_baked_commit_unknown(tmp_path):
    root = make_baked(tmp_path / "b", commit=None)
    assert boot.baked_commit(root) is None
    (root / "BUILD_INFO.json").write_text('{"commit": "unknown"}')
    assert boot.baked_commit(root) is None


# ---------------------------------------------------------------------------
# import check (real subprocess)
# ---------------------------------------------------------------------------
def test_import_check_passes_and_fails(tmp_path):
    root = make_baked(tmp_path / "ok")
    boot.import_check(root)
    (root / "src" / "server.py").write_text("import does_not_exist_xyz\n")
    with pytest.raises(boot.BootError, match="does_not_exist_xyz"):
        boot.import_check(root)


def test_check_command(tmp_path, capsys):
    assert boot.check(make_baked(tmp_path / "ok")) == 0
    assert boot.check(tmp_path / "missing") == 1


# ---------------------------------------------------------------------------
# launch
# ---------------------------------------------------------------------------
class FakeProc:
    pid = 4242


def test_run_starts_comfyui_then_execs_handler(tmp_path, dirs):
    app, baked = dirs
    popens, execs = [], []
    env = {
        "BOOT_APP_DIR": str(app), "BOOT_BAKED_DIR": str(baked), "COMFYUI_PATH": "/comfyui",
        "IMAGE_STUDIO_CODE_INFO": str(tmp_path / "code.json"),
        "BOOT_COMFY_PID_FILE": str(tmp_path / "comfyui.pid"),
        "MODE": "pod", "API_TOKEN": "secret", "WORKER_REF": "main", "PYTHONPATH": "/extra",
        "COMFY_EXTRA_ARGS": "--cpu --foo 'a b'",
    }

    def prepare(e, a, b):
        return boot.prepare_code(e, a, b, fetch_fn=lambda u: make_tarball(),
                                 import_check_fn=no_import_check)

    def popen(cmd, **kw):
        popens.append((cmd, kw))
        return FakeProc()
    boot.run(env, python="/py", prepare=prepare, popen=popen,
             execve=lambda p, a, e: execs.append((p, a, e)))

    assert json.loads((tmp_path / "code.json").read_text()) == {
        "source": "github", "ref": "main", "commit": SHA}
    assert (tmp_path / "comfyui.pid").read_text() == "4242\n"

    comfy_cmd, comfy_kw = popens[0]
    assert comfy_cmd == ["/py", "-u", "/comfyui/main.py", "--disable-auto-launch",
                         "--disable-metadata", "--listen", "127.0.0.1", "--port", "8188",
                         "--extra-model-paths-config", f"{app}/src/extra_model_paths.yaml",
                         "--verbose", "DEBUG", "--log-stdout", "--cpu", "--foo", "a b"]
    assert comfy_kw["cwd"] == "/comfyui"
    assert comfy_kw["env"]["PYTHONPATH"] == "/extra"  # our server.py must not shadow ComfyUI's
    assert popens[1][0][:2] == ["/py", "-c"]  # GPU diagnostic

    (py, args, henv), = execs
    assert py == "/py" and args == ["/py", "-u", f"{app}/src/handler.py"]
    assert henv["PYTHONPATH"] == f"{app}/src:/extra"
    assert henv["REGISTRY_PATH"] == f"{app}/models.json"
    assert henv["IMAGE_STUDIO_CODE_INFO"] == str(tmp_path / "code.json")
    assert henv["MODE"] == "pod" and henv["API_TOKEN"] == "secret"
    assert henv["VOLUME_ROOT"] == "/runpod-volume" and henv["COMFYUI_PATH"] == "/comfyui"


def test_run_baked_serverless_no_gpu_check(tmp_path, dirs):
    app, baked = dirs
    popens, execs = [], []
    env = {"BOOT_APP_DIR": str(app), "BOOT_BAKED_DIR": str(baked),
           "IMAGE_STUDIO_CODE_INFO": str(tmp_path / "c.json"),
           "BOOT_COMFY_PID_FILE": str(tmp_path / "pid"), "GPU_CHECK": "0",
           "WORKER_CODE_SOURCE": "baked", "COMFY_LOG_LEVEL": "INFO"}
    boot.run(env, python="/py", popen=lambda c, **k: popens.append(c) or FakeProc(),
             execve=lambda p, a, e: execs.append((a, e)))
    assert len(popens) == 1 and popens[0][popens[0].index("--verbose") + 1] == "INFO"
    assert f"{baked}/src/extra_model_paths.yaml" in popens[0]
    args, henv = execs[0]
    assert args[-1] == f"{baked}/src/handler.py" and henv["PYTHONPATH"] == f"{baked}/src"
    info = json.loads((tmp_path / "c.json").read_text())
    assert info["source"] == "baked" and info["commit"] == "baked1234"
    assert info["error"] == "WORKER_CODE_SOURCE=baked"


def test_tcmalloc(tmp_path):
    lib = tmp_path / "libtcmalloc_minimal.so.4"
    lib.write_text("")
    assert boot.tcmalloc_env({}, (str(tmp_path / "nope"), str(lib)))["LD_PRELOAD"] == str(lib)
    assert boot.tcmalloc_env({"LD_PRELOAD": "/mine"}, (str(lib),))["LD_PRELOAD"] == "/mine"
    assert "LD_PRELOAD" not in boot.tcmalloc_env({}, (str(tmp_path / "nope"),))


def test_main_check_flag(tmp_path):
    with pytest.raises(SystemExit) as e:
        boot.main(["--check", str(make_baked(tmp_path / "b"))])
    assert e.value.code == 0
    with pytest.raises(SystemExit) as e:
        boot.main(["--check", str(tmp_path / "none")])
    assert e.value.code == 1


def test_boot_is_stdlib_only():
    """boot.py must run before any third-party package is trusted."""
    tree = ast.parse((REPO_ROOT / "worker" / "boot" / "boot.py").read_text())
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module != "__future__":
            imported.add((node.module or "").split(".")[0])
    assert imported and imported <= set(sys.stdlib_module_names), imported - set(sys.stdlib_module_names)


def test_check_comfy_nodes_reads_classes_from_workflows():
    import check_comfy_nodes
    need = check_comfy_nodes.required_classes(REPO_ROOT / "worker" / "src" / "workflows.py")
    assert {"UNETLoader", "LoraLoaderModelOnly", "SaveImage", "QwenImage21Cache",
            "Flux2Scheduler"} <= set(need)
