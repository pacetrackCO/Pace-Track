"""Run the browser fixture with Chromium and only Python's standard library.

Uses real time (Chromium virtual time can skip video/animation frames).
The browser fixtures replace the Replit API and camera, and Chromium DNS is
restricted to the local app host so fixture traffic cannot reach live services.
"""
import argparse
import base64
import json
import mimetypes
import os
import signal
import socket
import struct
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_DIRECTORIES = {
    "Construccion", "Images", "images", "events", "timer", "timer_loop",
    "timer_PC", "timer_sector", "timing",
}
ROOT_FILES = {"index.html", "styles.css", "pacetrack-ui.css", "script.js"}
FIXTURE_FILES = {
    "tests/browser-timing.html",
    "tests/browser-interface.html",
    "tests/session-api-browser-mock.js",
}
PRIVATE_COMPONENTS = {
    ".agents", ".cache", ".config", ".git", ".local", ".upm", "db",
    "netlify", "node_modules", "server",
}


class FixtureHandler(BaseHTTPRequestHandler):
    server_version = "PaceTrackFixture/1.0"

    def _target(self):
        parsed = urlsplit(self.path)
        decoded = unquote(parsed.path)
        if "\x00" in decoded or "\\" in decoded:
            return None, 403, "invalid path"
        relative = Path("index.html") if decoded == "/" else Path(decoded.lstrip("/"))
        parts = relative.parts
        if not parts or any(part in ("", ".", "..") for part in parts):
            return None, 403, "path traversal is not allowed"
        if any(part in PRIVATE_COMPONENTS or part.startswith(".") for part in parts):
            return None, 403, "private project paths are not served"

        relative_name = relative.as_posix()
        allowed = (
            relative_name in FIXTURE_FILES
            or (len(parts) == 1 and parts[0] in ROOT_FILES)
            or parts[0] in PUBLIC_DIRECTORIES
        )
        if not allowed:
            return None, 404, "path is outside the browser fixture allowlist"

        target = (ROOT / relative).resolve()
        try:
            actual_relative = target.relative_to(ROOT).as_posix()
        except ValueError:
            return None, 403, "path resolves outside the project"
        actual_parts = Path(actual_relative).parts
        if any(part in PRIVATE_COMPONENTS or part.startswith(".") for part in actual_parts):
            return None, 403, "resolved path points to private project content"
        actual_allowed = (
            actual_relative in FIXTURE_FILES
            or (len(actual_parts) == 1 and actual_parts[0] in ROOT_FILES)
            or actual_parts[0] in PUBLIC_DIRECTORIES
        )
        if not actual_allowed:
            return None, 403, "resolved path is outside the browser fixture allowlist"
        if not target.is_file():
            return None, 404, "file does not exist"
        return target, 200, ""

    def _respond(self, include_body):
        if urlsplit(self.path).path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        target, status, reason = self._target()
        if status != 200:
            message = f"Fixture-only static server {status}: {reason}: {urlsplit(self.path).path}\n"
            self.server.denied_requests.append(message.strip())
            body = message.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if include_body:
                self.wfile.write(body)
            return

        try:
            body = target.read_bytes()
        except OSError as error:
            message = f"Fixture-only static server could not read {target.name}: {error}\n"
            body = message.encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if include_body:
                self.wfile.write(body)
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in ("application/javascript", "application/json"):
            content_type += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if include_body:
            self.wfile.write(body)

    def do_GET(self):
        self._respond(True)

    def do_HEAD(self):
        self._respond(False)

    def do_POST(self):
        self.send_error(405, "Fixture server does not proxy or accept API requests")

    def do_PUT(self):
        self.send_error(405, "Fixture server does not proxy or accept API requests")

    def do_DELETE(self):
        self.send_error(405, "Fixture server does not proxy or accept API requests")

    def log_message(self, _format, *_args):
        pass


def preflight_fixture(origin, path):
    required_paths = [path]
    if path in ("/tests/browser-timing.html", "/tests/browser-interface.html"):
        required_paths.append("/tests/session-api-browser-mock.js")
    for required_path in required_paths:
        url = origin + required_path
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status != 200:
                    raise RuntimeError(f"Browser fixture path returned HTTP {response.status}: {url}")
                if required_path in ("/tests/browser-timing.html", "/tests/browser-interface.html"):
                    body = response.read().decode("utf-8", errors="replace")
                    if 'id="results"' not in body:
                        raise RuntimeError(f"Browser fixture page is missing its results element: {url}")
        except Exception as error:
            raise RuntimeError(f"Browser fixture server cannot serve {url}: {error}") from error


def exact(sock, count):
    data = b""
    while len(data) < count:
        chunk = sock.recv(count - len(data))
        if not chunk:
            raise ConnectionError("Chromium closed the connection")
        data += chunk
    return data


class CDP:
    def __init__(self, url):
        from urllib.parse import urlparse
        parsed = urlparse(url)
        self.sock = socket.create_connection((parsed.hostname, parsed.port), timeout=15)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            f"GET {parsed.path} HTTP/1.1\r\nHost: {parsed.netloc}\r\n"
            f"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n".encode()
        )
        header = b""
        while not header.endswith(b"\r\n\r\n"):
            header += exact(self.sock, 1)
        if header.split(b" ", 2)[1] != b"101":
            raise ConnectionError(header.decode())
        self.sequence = 0

    def send(self, payload, opcode=1):
        mask = os.urandom(4)
        size = len(payload)
        length = bytes([size | 128]) if size < 126 else (
            b"\xfe" + struct.pack("!H", size) if size < 65536
            else b"\xff" + struct.pack("!Q", size)
        )
        self.sock.sendall(bytes([128 | opcode]) + length + mask +
                          bytes(value ^ mask[i % 4] for i, value in enumerate(payload)))

    def receive(self):
        while True:
            first, second = exact(self.sock, 2)
            size = second & 127
            if size == 126:
                size = struct.unpack("!H", exact(self.sock, 2))[0]
            elif size == 127:
                size = struct.unpack("!Q", exact(self.sock, 8))[0]
            mask = exact(self.sock, 4) if second & 128 else None
            payload = exact(self.sock, size)
            if mask:
                payload = bytes(value ^ mask[i % 4] for i, value in enumerate(payload))
            if first & 15 == 9:
                self.send(payload, 10)
            elif first & 15 == 1:
                return json.loads(payload)
            elif first & 15 == 8:
                raise ConnectionError("WebSocket closed")

    def call(self, method, params=None):
        self.sequence += 1
        sequence = self.sequence
        self.send(json.dumps({"id": sequence, "method": method, "params": params or {}}).encode())
        while True:
            response = self.receive()
            if response.get("id") == sequence:
                if "error" in response:
                    raise RuntimeError(response["error"])
                return response.get("result", {})

    def evaluate(self, expression):
        result = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True})
        if "exceptionDetails" in result:
            raise RuntimeError(result["exceptionDetails"])
        return result.get("result", {}).get("value")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", default="/tests/browser-timing.html")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=1000)
    parser.add_argument("--screenshot")
    parser.add_argument("--evaluate", help="Optional expression after navigation, for local UI inspection")
    args = parser.parse_args()

    static_server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    static_server.daemon_threads = True
    static_server.denied_requests = []
    static_thread = threading.Thread(target=static_server.serve_forever, daemon=True)
    static_thread.start()
    origin = f"http://localhost:{static_server.server_address[1]}"
    try:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        preflight_fixture(origin, args.path)
        with tempfile.TemporaryDirectory(prefix="pacetrack-chromium-", ignore_cleanup_errors=True) as profile:
            with tempfile.TemporaryFile() as log:
                browser_environment = os.environ.copy()
                browser_environment.update({
                    "HOME": profile,
                    "XDG_CONFIG_HOME": os.path.join(profile, "config"),
                    "XDG_CACHE_HOME": os.path.join(profile, "cache"),
                    "XDG_DATA_HOME": os.path.join(profile, "data"),
                })
                browser = subprocess.Popen([
                    "chromium", "--headless", "--no-sandbox", "--disable-gpu",
                    "--disable-dev-shm-usage", "--no-proxy-server",
                    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
                    "--disable-background-networking", "--autoplay-policy=no-user-gesture-required",
                    "--host-resolver-rules=MAP localhost 127.0.0.1, MAP * ~NOTFOUND",
                    f"--unsafely-treat-insecure-origin-as-secure={origin}",
                    f"--remote-debugging-port={port}", f"--user-data-dir={profile}", "about:blank",
                ], stdout=log, stderr=log, start_new_session=True, env=browser_environment)
                client = None
                try:
                    deadline = time.time() + 10
                    while True:
                        try:
                            targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=1))
                            target = next(t for t in targets if t["type"] == "page")
                            break
                        except (OSError, StopIteration):
                            if time.time() > deadline:
                                raise TimeoutError("Chromium did not start")
                            time.sleep(.1)
                    client = CDP(target["webSocketDebuggerUrl"])
                    client.call("Emulation.setDeviceMetricsOverride", {
                        "width": args.width, "height": args.height, "deviceScaleFactor": 1,
                        "mobile": args.width < 600,
                    })
                    client.call("Page.enable")
                    client.call("Page.navigate", {"url": origin + args.path})
                    deadline = time.time() + 65
                    if args.path in ("/tests/browser-timing.html", "/tests/browser-interface.html"):
                        while True:
                            text = client.evaluate("document.getElementById('results')?.textContent")
                            if text and text.startswith("{"):
                                result = json.loads(text)
                                print(json.dumps(result, indent=2))
                                if not result["passed"]:
                                    raise SystemExit(1)
                                break
                            body = client.evaluate("document.body?.innerText || ''")
                            if "Fixture-only static server" in body:
                                raise RuntimeError(f"Chromium could not load the browser fixture: {body.strip()}")
                            if time.time() > deadline:
                                raise TimeoutError(
                                    f"Browser fixture did not complete at {args.path}; "
                                    f"page title={client.evaluate('document.title')!r}, body={body[:300]!r}"
                                )
                            time.sleep(.25)
                    else:
                        time.sleep(3)
                        if args.evaluate:
                            print(json.dumps(client.evaluate(args.evaluate), indent=2))
                    if args.screenshot:
                        image = client.call("Page.captureScreenshot", {"format": "png"})
                        with open(args.screenshot, "wb") as output:
                            output.write(base64.b64decode(image["data"]))
                finally:
                    if client:
                        client.sock.close()
                    try:
                        os.killpg(browser.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        browser.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        try:
                            os.killpg(browser.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        browser.wait()
        if static_server.denied_requests:
            raise RuntimeError(
                "Fixture-only static server denied browser resource requests: "
                + "; ".join(static_server.denied_requests[:10])
            )
    finally:
        static_server.shutdown()
        static_server.server_close()
        static_thread.join(timeout=5)


if __name__ == "__main__":
    main()