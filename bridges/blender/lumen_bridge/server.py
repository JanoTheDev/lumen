# SPDX-License-Identifier: GPL-3.0-or-later
"""Localhost NDJSON server for Lumen. This module never imports bpy: socket threads queue
requests, and the add-on answers them on Blender's main thread through Server.drain()."""

import hmac
import json
import os
import queue
import socket
import threading

VERSION = "1.0.0"
HOST = "127.0.0.1"
PORT = 47651
MAX_LINE = 16 * 1024
MAX_CLIENTS = 4
REPLY_TIMEOUT = 2.0
COMMANDS = ("ping", "state", "object")
HISTORY = 16


def token_path():
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    return os.path.join(base, "Lumen", "blender-bridge.token")


def read_token(path=None):
    """The token Lumen wrote, or None (Lumen has not run yet)."""
    try:
        with open(path or token_path(), encoding="utf-8") as f:
            token = f.read().strip()
    except OSError:
        return None
    return token if len(token) >= 32 else None


def parse_request(raw, token):
    """One request line -> (request, None) or (request id or None, error)."""
    try:
        req = json.loads(raw)
    except ValueError:
        return None, "bad json"
    if not isinstance(req, dict):
        return None, "bad request"
    rid = req.get("id")
    given = req.get("token")
    if (
        not token
        or not isinstance(given, str)
        or not hmac.compare_digest(given.encode(), token.encode())
    ):
        return rid, "unauthorized"
    cmd = req.get("cmd")
    if cmd not in COMMANDS:
        return rid, "unknown command"
    if cmd == "object" and not isinstance(req.get("name"), str):
        return rid, "name required"
    return req, None


def op_idname(idname):
    """'mesh.extrude_region' -> 'MESH_OT_extrude_region'; C-style names pass through."""
    if "." in idname and "_OT_" not in idname:
        prefix, rest = idname.split(".", 1)
        return prefix.upper() + "_OT_" + rest
    return idname


def select_mode_label(flags):
    """tool_settings.mesh_select_mode (vertex, edge, face) -> 'FACE', 'VERTEX+EDGE' …"""
    names = [n for n, on in zip(("VERTEX", "EDGE", "FACE"), flags) if on]
    return "+".join(names) or None


class OperatorLog:
    """Numbers operators as they appear in the window manager's history, so Lumen can tell an
    operator that ran during a step from one that ran before it."""

    def __init__(self):
        self.seq = 0
        self.entries = []
        self._last = None
        self._primed = False

    def update(self, ops):
        """ops: [(pointer, idname, name)], oldest first, as wm.operators lists them."""
        if not self._primed:
            self._primed = True
            self._last = ops[-1][0] if ops else None
            return
        if not ops or ops[-1][0] == self._last:
            return
        fresh = []
        for op in reversed(ops):
            if op[0] == self._last:
                break
            fresh.append(op)
        for _ptr, idname, name in reversed(fresh):
            self.seq += 1
            self.entries.append({"seq": self.seq, "idname": op_idname(idname), "name": name})
        self.entries = self.entries[-HISTORY:]
        self._last = ops[-1][0]


class _Job:
    def __init__(self, req):
        self.req = req
        self.reply = None
        self.done = threading.Event()


class Server:
    def __init__(self, port=PORT, token_reader=read_token):
        self.port = port
        self._read_token = token_reader
        self._jobs = queue.Queue()
        self._sock = None
        self._stop = threading.Event()
        self._clients = threading.BoundedSemaphore(MAX_CLIENTS)

    def start(self):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        s.bind((HOST, self.port))
        s.listen(MAX_CLIENTS)
        s.settimeout(0.5)
        self._sock = s
        self.port = s.getsockname()[1]
        threading.Thread(target=self._accept, name="lumen-bridge", daemon=True).start()

    def stop(self):
        self._stop.set()
        if self._sock:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None
        # Unblock socket threads still waiting on the main thread.
        while True:
            try:
                job = self._jobs.get_nowait()
            except queue.Empty:
                break
            job.reply = {"ok": False, "error": "stopping"}
            job.done.set()

    def _accept(self):
        sock = self._sock
        while not self._stop.is_set() and sock:
            try:
                conn, _ = sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            if not self._clients.acquire(blocking=False):
                conn.close()
                continue
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn):
        try:
            conn.settimeout(30)
            reader = conn.makefile("rb")
            while not self._stop.is_set():
                line = reader.readline(MAX_LINE + 1)
                if not line:
                    break
                if len(line) > MAX_LINE:
                    self._send(conn, {"id": None, "ok": False, "error": "line too long"})
                    break
                self._send(conn, self.handle(line))
        except OSError:
            pass
        finally:
            conn.close()
            self._clients.release()

    @staticmethod
    def _send(conn, reply):
        conn.sendall((json.dumps(reply) + "\n").encode())

    def handle(self, line):
        req, err = parse_request(line, self._read_token())
        if err:
            return {"id": req, "ok": False, "error": err}
        rid = req.get("id")
        if req["cmd"] == "ping":
            return {"id": rid, "ok": True, "result": {"bridge": VERSION}}
        job = _Job(req)
        self._jobs.put(job)
        if not job.done.wait(REPLY_TIMEOUT):
            return {"id": rid, "ok": False, "error": "blender is busy"}
        return dict(job.reply, id=rid)

    def drain(self, run, limit=8):
        """Main thread: answers queued requests with run(request) -> result."""
        for _ in range(limit):
            try:
                job = self._jobs.get_nowait()
            except queue.Empty:
                return
            try:
                job.reply = {"ok": True, "result": run(job.req)}
            except Exception as e:  # noqa: BLE001 - any bpy error becomes an error reply
                job.reply = {"ok": False, "error": str(e)[:200]}
            job.done.set()
