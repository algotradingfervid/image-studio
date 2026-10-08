import os

import pytest

from safe_paths import PathError, resolve, validate_filename, validate_folder

IDS = ["chroma", "zimage", "flux2", "qwen"]


@pytest.mark.parametrize("folder", ["unet", "clip", "vae", "loras/chroma", "loras/qwen"])
def test_valid_folders(folder):
    assert validate_folder(folder, IDS) == folder


@pytest.mark.parametrize("folder", [
    "", "loras", "loras/", "loras/unknown", "loras/chroma/x", "unet/", "/unet", "../unet",
    "checkpoints", "diffusion_models", "text_encoders", "loras/../unet", "loras/..",
    "loras/Chroma", "UNET", None, 3, ["unet"],
])
def test_invalid_folders(folder):
    with pytest.raises(PathError):
        validate_folder(folder, IDS)


def test_unknown_lora_model_allowed_without_registry():
    assert validate_folder("loras/newmodel") == "loras/newmodel"


@pytest.mark.parametrize("name", [
    "model.safetensors", "Chroma1-HD-fp8mixed.safetensors", "qwen_image_2.1_vae_bf16.safetensors",
    "my lora (v2).safetensors", "Ünïcode_Lora.safetensors",
])
def test_valid_filenames(name):
    assert validate_filename(name) == name


@pytest.mark.parametrize("name", [
    "", ".safetensors", "a.ckpt", "a.safetensors.part", "a.SAFETENSORS", "../a.safetensors",
    "a/../../b.safetensors", "dir/a.safetensors", "a\\b.safetensors", "..a.safetensors",
    "a..safetensors", ".hidden.safetensors", "-rf.safetensors", " a.safetensors",
    "a\x00.safetensors", "a\n.safetensors", "a:b.safetensors", "a*.safetensors",
    "x" * 300 + ".safetensors", None, 5,
])
def test_invalid_filenames(name):
    with pytest.raises(PathError):
        validate_filename(name)


def test_resolve_inside_root(tmp_path):
    p = resolve(tmp_path, "loras/flux2", "a.safetensors", IDS)
    assert p == (tmp_path / "loras" / "flux2" / "a.safetensors").resolve()


def test_resolve_rejects_symlink_escape(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "models"
    root.mkdir()
    os.symlink(outside, root / "vae")
    with pytest.raises(PathError, match="escapes"):
        resolve(root, "vae", "ae.safetensors", IDS)
