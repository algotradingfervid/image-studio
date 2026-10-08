from __future__ import annotations

import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from registry import load_registry

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="session")
def registry() -> dict:
    return load_registry(Path(__file__).resolve().parents[2] / "shared" / "models.json")


@pytest.fixture(scope="session")
def object_info() -> dict:
    return json.loads((FIXTURES / "object_info_v0.39.0.json").read_text())["nodes"]


# ---------------------------------------------------------------------------
# Local HTTP file server used by the downloader and handler tests.
# ---------------------------------------------------------------------------
class FileServer:
    """Serves in-memory files with Range support and scriptable misbehaviour.

    files[path] = bytes
    behaviours[path] = dict with optional keys:
      drop_after: int     close the connection after this many body bytes (first N requests)
      drop_times: int     how many requests misbehave (default 1)
      stall_after: int    send this many bytes then sleep `stall_for` seconds
      stall_for: float
      trickle: (n, s)     send n bytes every s seconds (first `drop_times` requests)
      redirect: url       302 to this absolute URL
      status: int         respond with this status
      ignore_range: bool  always answer 200 with the full body
      chunk_delay: float  sleep between 64 KiB chunks (for concurrency tests)
    """

    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.behaviours: dict[str, dict] = {}
        self.requests: list[dict] = []
        self.counts: dict[str, int] = {}
        self.in_flight = 0
        self.max_in_flight = 0
        self.lock = threading.Lock()
        server = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def do_GET(self):
                with server.lock:
                    server.requests.append({"path": self.path, "headers": dict(self.headers),
                                            "host": self.headers.get("Host")})
                    n = server.counts.get(self.path, 0) + 1
                    server.counts[self.path] = n
                    server.in_flight += 1
                    server.max_in_flight = max(server.max_in_flight, server.in_flight)
                try:
                    self._serve(n)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                finally:
                    with server.lock:
                        server.in_flight -= 1

            def _serve(self, n):
                b = server.behaviours.get(self.path, {})
                misbehave = n <= b.get("drop_times", 1)
                if "redirect" in b:
                    self.send_response(302)
                    self.send_header("Location", b["redirect"])
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if "status" in b:
                    self.send_response(b["status"])
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                body = server.files.get(self.path)
                if body is None:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                start = 0
                rng = self.headers.get("Range")
                if rng and not b.get("ignore_range"):
                    start = int(rng.split("=")[1].split("-")[0])
                    if start >= len(body):
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{len(body)}")
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{len(body) - 1}/{len(body)}")
                else:
                    self.send_response(200)
                payload = body[start:]
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                if misbehave and "drop_after" in b:
                    self.wfile.write(payload[: b["drop_after"]])
                    self.wfile.flush()
                    self.close_connection = True
                    return
                if misbehave and "stall_after" in b:
                    self.wfile.write(payload[: b["stall_after"]])
                    self.wfile.flush()
                    time.sleep(b["stall_for"])
                    self.close_connection = True
                    return
                if misbehave and "trickle" in b:
                    k, s = b["trickle"]
                    for i in range(0, len(payload), k):
                        self.wfile.write(payload[i:i + k])
                        self.wfile.flush()
                        time.sleep(s)
                    return
                delay = b.get("chunk_delay", 0)
                for i in range(0, len(payload), 65536):
                    self.wfile.write(payload[i:i + 65536])
                    if delay:
                        self.wfile.flush()
                        time.sleep(delay)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def url(self, path: str, host: str = "127.0.0.1") -> str:
        return f"http://{host}:{self.port}{path}"

    def add(self, path: str, data: bytes, **behaviour) -> str:
        self.files[path] = data
        if behaviour:
            self.behaviours[path] = behaviour
        return hashlib.sha256(data).hexdigest()

    def requests_for(self, path: str) -> list[dict]:
        return [r for r in self.requests if r["path"] == path]

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def file_server():
    s = FileServer()
    yield s
    s.close()
