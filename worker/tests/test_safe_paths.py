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


# v5 video: the LTX-2.5 spatial upscaler lives in latent_upscale_models (the
# folder name ComfyUI's LatentUpscaleModelLoader reads); nothing else was added.
def test_latent_upscale_models_folder_allowed(tmp_path):
    assert validate_folder("latent_upscale_models", IDS) == "latent_upscale_models"
    p = resolve(tmp_path, "latent_upscale_models", "up.safetensors", IDS)
    assert p == (tmp_path / "latent_upscale_models" / "up.safetensors").resolve()


@pytest.mark.parametrize("folder", ["model_patches", "latent_upscale_models/x",
                                    "latent_upscale_models/", "upscale_models", "embeddings"])
def test_other_video_folders_still_rejected(folder):
    with pytest.raises(PathError):
        validate_folder(folder, IDS)


def test_extra_model_paths_maps_every_whitelisted_folder():
    """extra_model_paths.yaml points each folder at /runpod-volume/models/<folder>."""
    from pathlib import Path

    from safe_paths import BASE_FOLDERS

    sections = _yaml_sections()
    entries = sections["image_studio"]
    assert entries["base_path"] == "/runpod-volume/models"
    assert "is_default" not in entries
    for folder in BASE_FOLDERS:
        assert entries[folder] == f"{folder}/", folder
    assert entries["loras"] == "loras/"
    assert entries["latent_upscale_models"] == "latent_upscale_models/"


def _yaml_sections() -> dict[str, dict[str, str]]:
    from pathlib import Path

    text = (Path(__file__).resolve().parents[1] / "src" / "extra_model_paths.yaml").read_text()
    sections: dict[str, dict[str, str]] = {}
    current = None
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line.startswith(" ") and line.rstrip().endswith(":"):
            current = sections.setdefault(line.rstrip()[:-1], {})
        elif current is not None and ":" in line:
            k, v = line.strip().split(":", 1)
            current[k] = v.strip()
    return sections


def test_extra_model_paths_lists_local_copies_first():
    """/models-local (local_models.py) is a default (searched-first) base path
    for the folders the copier fills; LoRAs stay on the volume only."""
    local = _yaml_sections()["image_studio_local"]
    assert local["base_path"] == "/models-local"
    assert local["is_default"] == "true"
    for folder in ("unet", "clip", "vae", "latent_upscale_models"):
        assert local[folder] == f"{folder}/", folder
    assert local["diffusion_models"] == "unet/" and local["text_encoders"] == "clip/"
    assert "loras" not in local


def test_extra_model_paths_parses_with_comfyui_semantics():
    """Same parsing as ComfyUI's utils/extra_config.py (yaml.safe_load, pop
    base_path / is_default): local folders end up first in the search list."""
    yaml = pytest.importorskip("yaml")
    from pathlib import Path

    text = (Path(__file__).resolve().parents[1] / "src" / "extra_model_paths.yaml").read_text()
    paths: dict[str, list[str]] = {}
    legacy = {"unet": "diffusion_models", "clip": "text_encoders"}
    for conf in yaml.safe_load(text).values():
        conf = dict(conf)
        base = conf.pop("base_path")
        default = conf.pop("is_default", False)
        for folder, rel in conf.items():
            lst = paths.setdefault(legacy.get(folder, folder), [])
            full = f"{base}/{rel.rstrip('/')}"
            if full in lst:
                if default and lst[0] != full:
                    lst.remove(full)
                    lst.insert(0, full)
            elif default:
                lst.insert(0, full)
            else:
                lst.append(full)
    assert paths["diffusion_models"] == ["/models-local/unet", "/runpod-volume/models/unet"]
    assert paths["text_encoders"] == ["/models-local/clip", "/runpod-volume/models/clip"]
    assert paths["vae"] == ["/models-local/vae", "/runpod-volume/models/vae"]
    assert paths["loras"] == ["/runpod-volume/models/loras"]
