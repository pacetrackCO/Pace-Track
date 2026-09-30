"""Run the browser fixture with Chromium and only Python's standard library.

Uses real time (Chromium virtual time can skip video/animation frames).
The fixture replaces Firebase, camera and storage: it never changes live data.
"""
import argparse
import base64
import json
import os
import signal
import socket
import struct
import subprocess
import tempfile
import time
import urllib.request


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
    host = os.environ.get("REPLIT_DEV_DOMAIN", "localhost")
    origin = f"http://{host}:5000"
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
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
                "--autoplay-policy=no-user-gesture-required",
                f"--host-resolver-rules=MAP {host} 127.0.0.1",
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
                if args.path == "/tests/browser-timing.html":
                    while True:
                        text = client.evaluate("document.getElementById('results')?.textContent")
                        if text and text.startswith("{"):
                            result = json.loads(text)
                            print(json.dumps(result, indent=2))
                            if not result["passed"]:
                                raise SystemExit(1)
                            break
                        if time.time() > deadline:
                            raise TimeoutError("Browser fixture did not complete")
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


if __name__ == "__main__":
    main()