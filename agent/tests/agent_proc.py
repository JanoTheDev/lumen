"""Spawns the agent as a child process and reads its stdout frames."""
import json
import os
import queue
import subprocess
import sys
import threading
import time

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class AgentProc:
    def __init__(self, *args: str):
        env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        self.proc = subprocess.Popen(
            [sys.executable, os.path.join(AGENT_DIR, "main.py"), *args],
            cwd=AGENT_DIR,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        self.lines: "queue.Queue[str]" = queue.Queue()
        self.raw: list[str] = []
        self.stderr: list[str] = []
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self):
        for raw in self.proc.stdout:
            line = raw.decode("utf-8").rstrip("\n")
            self.raw.append(line)
            self.lines.put(line)

    def _read_stderr(self):
        for raw in self.proc.stderr:
            self.stderr.append(raw.decode("utf-8", "replace"))

    def send(self, obj) -> None:
        data = obj if isinstance(obj, str) else json.dumps(obj)
        self.proc.stdin.write((data + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def next(self, timeout: float = 10.0) -> dict:
        return json.loads(self.lines.get(timeout=timeout))

    def wait_for(self, pred, timeout: float = 10.0) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError("no matching frame; stderr:\n" + "".join(self.stderr[-20:]))
            msg = self.next(left)
            if pred(msg):
                return msg

    def close(self) -> int:
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            return self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            return self.proc.wait()
