"""Path sanitising for every file the worker touches on the network volume.

Spec: `folder` must be one of `unet`, `clip`, `vae`, `loras/<modelId>`, plus
`latent_upscale_models` (v5 video: the LTX-2.5 spatial upscaler, loaded by
ComfyUI's LatentUpscaleModelLoader from that folder name).
Filenames: no `/`, no `..`, extension `.safetensors`. Anything else is rejected.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

BASE_FOLDERS = ("unet", "clip", "vae", "latent_upscale_models")
EXTENSION = ".safetensors"
MAX_FILENAME = 200

# Rejects path separators, control characters (incl. NUL) and characters that
# are invalid on common filesystems; a name may not start with "." or "-" or a
# space (no hidden files, no option-like names). Unicode letters are allowed
# because Civitai filenames often contain them.
_FILENAME_RE = re.compile(r'^[^.\- \x00-\x1f\x7f/\\:*?"<>|][^\x00-\x1f\x7f/\\:*?"<>|]*$')
_MODEL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


class PathError(ValueError):
    """Raised for any folder/filename that fails sanitising."""


def validate_folder(folder: object, model_ids: list[str] | None = None) -> str:
    if not isinstance(folder, str):
        raise PathError(f"INVALID_FOLDER: {folder!r}")
    if folder in BASE_FOLDERS:
        return folder
    parts = folder.split("/")
    if len(parts) == 2 and parts[0] == "loras" and _MODEL_ID_RE.match(parts[1]):
        if model_ids is not None and parts[1] not in model_ids:
            raise PathError(f"INVALID_FOLDER: unknown model id in {folder!r}")
        return folder
    raise PathError(f"INVALID_FOLDER: {folder!r}")


def validate_filename(filename: object) -> str:
    if not isinstance(filename, str) or not filename:
        raise PathError(f"INVALID_FILENAME: {filename!r}")
    if (
        "/" in filename
        or "\\" in filename
        or ".." in filename
        or "\x00" in filename
        or len(filename) > MAX_FILENAME
        or not filename.endswith(EXTENSION)
        or len(filename) == len(EXTENSION)
        or not _FILENAME_RE.match(filename)
    ):
        raise PathError(f"INVALID_FILENAME: {filename!r}")
    return filename


def resolve(models_root: str | os.PathLike, folder: str, filename: str,
            model_ids: list[str] | None = None) -> Path:
    """Validated absolute path of `<models_root>/<folder>/<filename>`.

    Also checks the resolved path stays inside models_root (defence in depth
    against symlinks planted on the volume).
    """
    folder = validate_folder(folder, model_ids)
    filename = validate_filename(filename)
    root = Path(models_root).resolve()
    path = (root / folder / filename).resolve()
    if root not in path.parents:
        raise PathError(f"INVALID_PATH: {folder}/{filename} escapes the models root")
    return path
