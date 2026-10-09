"""cuda_info: the comfy-kitchen CUDA backend probe behind /health cudaKernels."""

import subprocess
import sys
import textwrap

import pytest

import cuda_info
import server


@pytest.fixture(autouse=True)
def reset():
    cuda_info._reset_for_tests()
    yield
    cuda_info._reset_for_tests()


def fake_tree(tmp_path, torch_cuda, ck_registered):
    """Stub torch, comfy_kitchen and comfy/quant_ops.py with the same gate as
    ComfyUI v0.39.0 (cuda < 13 -> registry.disable("cuda"))."""
    (tmp_path / "torch").mkdir()
    (tmp_path / "torch" / "__init__.py").write_text(
        f"class version:\n    cuda = {torch_cuda!r}\n")
    (tmp_path / "comfy_kitchen").mkdir()
    (tmp_path / "comfy_kitchen" / "__init__.py").write_text(textwrap.dedent(f"""
        class _R:
            def __init__(self):
                self.backends = {{"cuda"}} if {ck_registered!r} else set()
                self.off = set()
            def disable(self, n): self.off.add(n)
            def is_available(self, n): return n in self.backends and n not in self.off
        registry = _R()
        def list_backends():
            return {{"cuda": {{"available": "cuda" in registry.backends,
                              "disabled": "cuda" in registry.off,
                              "unavailable_reason": None if {ck_registered!r}
                                  else "CUDA not available on this system"}}}}
    """))
    (tmp_path / "comfy").mkdir()
    (tmp_path / "comfy" / "quant_ops.py").write_text(textwrap.dedent(f"""
        import torch, comfy_kitchen as ck
        _CK_AVAILABLE = True
        if tuple(map(int, str(torch.version.cuda).split("."))) < (13,):
            ck.registry.disable("cuda")
    """))
    return str(tmp_path)


@pytest.mark.parametrize("torch_cuda,registered,enabled,reason", [
    ("13.0", True, True, None),
    ("12.8", True, False, "disabled by ComfyUI (torch CUDA 12.8; needs >= 13)"),
    ("13.0", False, False, "CUDA not available on this system"),
])
def test_probe_script_runs_comfy_gate(tmp_path, torch_cuda, registered, enabled, reason):
    comfy = fake_tree(tmp_path, torch_cuda, registered)
    r = cuda_info.probe(comfy, python=sys.executable)
    assert r["enabled"] is enabled
    assert r["torchCuda"] == torch_cuda
    assert r["reason"] == reason


def test_probe_reports_crash_without_raising():
    def run(*a, **k):
        return subprocess.CompletedProcess(a, 1, stdout="", stderr="boom\nImportError: x")
    r = cuda_info.probe("/nonexistent", run=run)
    assert r["enabled"] is None and "probe exited 1" in r["reason"] and "ImportError" in r["reason"]


def test_probe_timeout():
    def run(*a, **k):
        raise subprocess.TimeoutExpired("python", 1)
    assert cuda_info.probe("/nonexistent", run=run)["enabled"] is None


def test_status_none_until_started_then_logged(caplog):
    assert cuda_info.status() is None
    caplog.set_level("INFO")
    result = {"enabled": True, "torchCuda": "13.0", "comfyKitchen": "0.2.37", "reason": None}
    cuda_info.start(lambda: result, background=False)
    assert cuda_info.status() == result
    assert "comfy-kitchen CUDA backend ENABLED (torch CUDA 13.0" in caplog.text
    cuda_info.start(lambda: pytest.fail("probed twice"), background=False)


def test_disabled_is_a_warning(caplog):
    cuda_info.start(lambda: {"enabled": False, "torchCuda": "12.8", "comfyKitchen": "0.2.37",
                             "reason": "disabled by ComfyUI"}, background=False)
    assert "NOT enabled" in caplog.text and "disabled by ComfyUI" in caplog.text


def test_health_field_only_after_start():
    mgr = server.JobManager(run_job=lambda j: {}, interrupt=lambda: None)
    health = server.Health(mgr, comfy_up=lambda: True, gpu=lambda: "G",
                           comfy_version=lambda: "0.39.0", code=lambda: None)
    try:
        assert "cudaKernels" not in health.payload()
        cuda_info.start(lambda: {"enabled": True, "torchCuda": "13.0",
                                 "comfyKitchen": "0.2.37", "reason": None}, background=False)
        assert health.payload()["cudaKernels"]["enabled"] is True
    finally:
        mgr.shutdown()
