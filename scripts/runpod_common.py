"""Shared helpers for runpod_setup.py and runpod_teardown.py (stdlib only).

- .env reading/writing that keeps comments, order and file permissions
- a tiny client for the Runpod REST API v2 (https://api.runpod.io/v2)
- redaction so secret values never reach stdout

Runpod REST API v1 (https://rest.runpod.io/v1) is deprecated and retires on
2026-11-15 (https://docs.runpod.io/api-reference-v2/migrate-from-v1), so these
scripts use v2. OpenAPI: https://api.runpod.io/v2/openapi.json
"""

from __future__ import annotations

import json
import os
import re
import stat
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ENV_PATH = REPO_ROOT / ".env"
API_BASE = "https://api.runpod.io"

# Every resource these scripts own starts with this prefix.
PREFIX = "image-studio-"

_ENV_LINE = re.compile(r"^(?P<lead>\s*(?:export\s+)?)(?P<key>[A-Za-z_][A-Za-z0-9_]*)\s*=(?P<value>.*)$")


# --------------------------------------------------------------------------- .env


def _unquote(raw: str) -> str:
    value = raw.strip()
    if value[:1] in ("'", '"'):
        end = value.find(value[0], 1)
        if end != -1:
            return value[1:end]  # anything after the closing quote is a comment
    # Strip an inline comment only when it is separated by whitespace.
    hash_at = re.search(r"\s+#", value)
    if hash_at:
        value = value[: hash_at.start()]
    return value.strip()


def parse_env_text(text: str) -> dict[str, str]:
    """Parse KEY=value lines. Comments, blank lines and junk are ignored."""
    values: dict[str, str] = {}
    for line in text.splitlines():
        if line.lstrip().startswith("#"):
            continue
        m = _ENV_LINE.match(line)
        if m:
            values[m.group("key")] = _unquote(m.group("value"))
    return values


def read_env(path: Path = DEFAULT_ENV_PATH) -> dict[str, str]:
    """Read .env; process environment variables win over file values."""
    values = parse_env_text(path.read_text()) if path.exists() else {}
    for key in list(values) + ["RUNPOD_API_KEY", "RUNPOD_ENDPOINT_ID", "HF_TOKEN", "CIVITAI_API_KEY",
                               "GHCR_USERNAME", "GHCR_TOKEN"]:
        if os.environ.get(key):
            values[key] = os.environ[key]
    return values


def set_env_text(text: str, key: str, value: str) -> str:
    """Return `text` with `key` set to `value`.

    The first existing assignment (with or without `export`) is rewritten in
    place, any later duplicates are left alone, every other line and comment is
    kept byte for byte. A missing key is appended at the end.
    """
    lines = text.splitlines(keepends=True)
    for i, line in enumerate(lines):
        if line.lstrip().startswith("#"):
            continue
        m = _ENV_LINE.match(line.rstrip("\r\n"))
        if m and m.group("key") == key:
            ending = line[len(line.rstrip("\r\n")):]
            lines[i] = f"{m.group('lead')}{key}={value}{ending or ''}"
            return "".join(lines)
    out = "".join(lines)
    if out and not out.endswith("\n"):
        out += "\n"
    return out + f"{key}={value}\n"


def write_env_value(path: Path, key: str, value: str) -> None:
    """Set one key in .env atomically, keeping the file mode (0600 when new)."""
    if path.exists():
        mode = stat.S_IMODE(path.stat().st_mode)
        text = path.read_text()
    else:
        mode = 0o600
        text = ""
    new_text = set_env_text(text, key, value)
    fd, tmp = tempfile.mkstemp(prefix=".env.", dir=str(path.parent))
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w") as fh:
            fh.write(new_text)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    os.chmod(path, mode)


# --------------------------------------------------------------------------- redaction


class Redactor:
    """Replaces known secret values with *** in any string shown to the user."""

    def __init__(self, secrets: list[str] | None = None):
        self._secrets = [s for s in (secrets or []) if s and len(s) >= 4]

    def add(self, value: str | None) -> None:
        if value and len(value) >= 4:
            self._secrets.append(value)

    def __call__(self, text: str) -> str:
        for s in self._secrets:
            text = text.replace(s, "***")
        return text


def mask_env(env: dict[str, str]) -> dict[str, str]:
    """Env for display: Runpod secret placeholders shown as-is, everything else masked."""
    shown = {}
    for k, v in env.items():
        shown[k] = v if v.startswith("{{ RUNPOD_SECRET_") else ("<set>" if v else "<empty>")
    return shown


# --------------------------------------------------------------------------- HTTP


class ApiError(RuntimeError):
    def __init__(self, status: int, method: str, path: str, detail: str):
        super().__init__(f"{method} {path} -> HTTP {status}: {detail}")
        self.status = status


class RunpodApi:
    """Minimal Runpod REST v2 client. `transport` is injectable for tests."""

    def __init__(self, api_key: str, base: str = API_BASE, transport=None, redact: Redactor | None = None):
        self.api_key = api_key
        self.base = base.rstrip("/")
        self.transport = transport or self._urllib_transport
        self.redact = redact or Redactor([api_key])
        self.redact.add(api_key)

    def _urllib_transport(self, method: str, url: str, headers: dict, body: bytes | None):
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def request(self, method: str, path: str, body: dict | None = None, query: dict | None = None):
        url = self.base + path
        if query:
            url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
            "User-Agent": "image-studio-setup/1.0",
        }
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        status, raw = self.transport(method, url, headers, data)
        text = raw.decode("utf-8", "replace") if raw else ""
        if status >= 400:
            detail = text
            try:
                problem = json.loads(text)
                parts = [problem.get("title"), problem.get("detail")] + list(problem.get("errors") or [])
                detail = "; ".join(str(p) for p in parts if p) or text
            except (ValueError, AttributeError):
                pass
            raise ApiError(status, method, path, self.redact(detail[:800]))
        return json.loads(text) if text.strip() else None

    def get(self, path, query=None):
        return self.request("GET", path, query=query)

    def post(self, path, body):
        return self.request("POST", path, body=body)

    def patch(self, path, body):
        return self.request("PATCH", path, body=body)

    def delete(self, path):
        return self.request("DELETE", path)

    def list_all(self, path: str, key: str) -> list[dict]:
        """GET a list endpoint, following cursor pagination when present."""
        items: list[dict] = []
        cursor = None
        while True:
            page = self.get(path, {"cursor": cursor} if cursor else None) or {}
            items.extend(page.get(key) or [])
            pag = page.get("pagination") or {}
            if not pag.get("hasNextPage") or not pag.get("nextCursor"):
                return items
            cursor = pag["nextCursor"]


def find_owned(items: list[dict], name: str | None = None) -> list[dict]:
    """Resources owned by these scripts: exact `name` if given, else the PREFIX."""
    if name is not None:
        return [i for i in items if i.get("name") == name]
    return [i for i in items if str(i.get("name", "")).startswith(PREFIX)]


def die(msg: str, code: int = 1) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)
