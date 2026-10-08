"""Minimal client for the local ComfyUI server (HTTP + websocket).

ComfyUI is started by worker/boot/boot.py (legacy image: the base image's
/start.sh) in the background, PID written to /tmp/comfyui.pid, before our
handler starts. We only wait
for it to answer.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any, Callable, Iterator

import requests
import websocket  # websocket-client

COMFY_HOST = os.environ.get("COMFY_HOST", "127.0.0.1:8188")
COMFY_PID_FILE = "/tmp/comfyui.pid"


class ComfyError(RuntimeError):
    pass


class ComfyUnavailable(ComfyError):
    pass


class ComfyPromptRejected(ComfyError):
    """POST /prompt returned 400 (graph failed validation)."""

    def __init__(self, body: Any):
        self.body = body
        super().__init__(format_prompt_error(body))


def format_prompt_error(body: Any) -> str:
    if not isinstance(body, dict):
        return f"COMFYUI_INVALID_PROMPT: {body}"
    err = body.get("error") or {}
    parts = [err.get("message", "invalid prompt") if isinstance(err, dict) else str(err)]
    for node_id, ne in (body.get("node_errors") or {}).items():
        for e in ne.get("errors", []):
            parts.append(f"node {node_id} ({ne.get('class_type')}): {e.get('details') or e.get('message')}")
    return "COMFYUI_INVALID_PROMPT: " + "; ".join(parts)


def _pid_alive() -> bool | None:
    """True/False when a PID file exists, None when we can't tell."""
    try:
        with open(COMFY_PID_FILE) as fh:
            pid = int(fh.read().strip())
    except (OSError, ValueError):
        return None
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class ComfyClient:
    def __init__(self, host: str = COMFY_HOST,
                 ws_factory: Callable[[], Any] | None = None,
                 session: requests.Session | None = None):
        self.host = host
        self.base = f"http://{host}"
        self.http = session or requests.Session()
        self.ws_factory = ws_factory or websocket.WebSocket
        self.client_id = str(uuid.uuid4())

    # ---- lifecycle -------------------------------------------------------
    def is_up(self) -> bool:
        try:
            return self.http.get(f"{self.base}/", timeout=3).status_code == 200
        except requests.RequestException:
            return False

    def wait_ready(self, timeout_s: float = 300.0, interval_s: float = 0.5,
                   sleep: Callable[[float], None] = time.sleep) -> None:
        deadline = time.monotonic() + timeout_s
        while True:
            if self.is_up():
                return
            if _pid_alive() is False:
                raise ComfyUnavailable(
                    "COMFYUI_NOT_RUNNING: the ComfyUI process exited; see worker logs")
            if time.monotonic() >= deadline:
                raise ComfyUnavailable(f"COMFYUI_NOT_REACHABLE: {self.base} after {timeout_s:.0f}s")
            sleep(interval_s)

    # ---- HTTP API --------------------------------------------------------
    def system_stats(self) -> dict:
        r = self.http.get(f"{self.base}/system_stats", timeout=5)
        r.raise_for_status()
        return r.json()

    def upload_image(self, name: str, data: bytes, mime: str = "image/png") -> str:
        r = self.http.post(
            f"{self.base}/upload/image",
            files={"image": (name, data, mime)},
            data={"overwrite": "true", "type": "input"},
            timeout=60,
        )
        if r.status_code != 200:
            raise ComfyError(f"COMFYUI_UPLOAD_FAILED: {name}: HTTP {r.status_code} {r.text[:200]}")
        body = r.json()
        sub = body.get("subfolder") or ""
        return f"{sub}/{body['name']}" if sub else body["name"]

    def queue_prompt(self, graph: dict) -> str:
        r = self.http.post(f"{self.base}/prompt",
                           json={"prompt": graph, "client_id": self.client_id}, timeout=30)
        try:
            body = r.json()
        except ValueError:
            body = r.text
        if r.status_code == 400:
            raise ComfyPromptRejected(body)
        if r.status_code != 200:
            raise ComfyError(f"COMFYUI_QUEUE_FAILED: HTTP {r.status_code} {str(body)[:300]}")
        if body.get("node_errors"):
            raise ComfyPromptRejected(body)
        return body["prompt_id"]

    def history(self, prompt_id: str) -> dict:
        r = self.http.get(f"{self.base}/history/{prompt_id}", timeout=30)
        r.raise_for_status()
        return r.json().get(prompt_id, {})

    def view(self, filename: str, subfolder: str, folder_type: str) -> bytes:
        r = self.http.get(f"{self.base}/view",
                          params={"filename": filename, "subfolder": subfolder, "type": folder_type},
                          timeout=60)
        if r.status_code != 200:
            raise ComfyError(f"COMFYUI_VIEW_FAILED: {filename}: HTTP {r.status_code}")
        return r.content

    def interrupt(self) -> bool:
        """Interrupts the running prompt (POST /interrupt). Best effort."""
        try:
            r = self.http.post(f"{self.base}/interrupt", json={}, timeout=10)
            return r.status_code == 200
        except requests.RequestException:
            return False

    def free(self) -> bool:
        try:
            r = self.http.post(f"{self.base}/free",
                               json={"unload_models": True, "free_memory": True}, timeout=10)
            return r.status_code == 200
        except requests.RequestException:
            return False

    # ---- websocket -------------------------------------------------------
    def connect_ws(self, recv_timeout_s: float = 5.0):
        ws = self.ws_factory()
        ws.connect(f"ws://{self.host}/ws?clientId={self.client_id}", timeout=10)
        ws.settimeout(recv_timeout_s)
        return ws

    @staticmethod
    def iter_messages(ws) -> Iterator[dict | None]:
        """Yields decoded JSON messages; yields None on a receive timeout.

        Binary frames (latent previews) are skipped.
        """
        while True:
            try:
                raw = ws.recv()
            except websocket.WebSocketTimeoutException:
                yield None
                continue
            if isinstance(raw, (bytes, bytearray)):
                continue
            try:
                yield json.loads(raw)
            except ValueError:
                continue
