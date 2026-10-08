"""Loads the shared model registry (shared/models.json).

In the image the registry is copied to /image_studio/models.json. Locally (tests)
it is read from the repo's shared/models.json. REGISTRY_PATH overrides both.
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

_CANDIDATES = (
    Path("/image_studio/models.json"),
    Path(__file__).resolve().parent.parent.parent / "shared" / "models.json",
)


def registry_path() -> Path:
    env = os.environ.get("REGISTRY_PATH")
    if env:
        return Path(env)
    for p in _CANDIDATES:
        if p.is_file():
            return p
    raise FileNotFoundError("models.json not found; set REGISTRY_PATH")


@lru_cache(maxsize=4)
def _load(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def load_registry(path: str | os.PathLike | None = None) -> dict:
    return _load(str(path or registry_path()))


def model_ids(registry: dict) -> list[str]:
    return [m["id"] for m in registry["models"]]


def get_model(registry: dict, model_id: str) -> dict:
    for m in registry["models"]:
        if m["id"] == model_id:
            return m
    raise KeyError(model_id)


def model_file(model: dict, folder: str) -> dict:
    """The single registry file of a model in `folder` (unet, clip or vae)."""
    for f in model["files"]:
        if f["folder"] == folder:
            return f
    raise KeyError(f"{model['id']} has no {folder} file")
