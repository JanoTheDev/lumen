# SPDX-License-Identifier: GPL-3.0-or-later
# Plain Python tests for the bpy-free half of the add-on:
#   python -m unittest discover -s bridges/blender/tests
import json
import os
import socket
import sys
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lumen_bridge"))

import server  # noqa: E402

TOKEN = "a" * 64


class ParseRequest(unittest.TestCase):
    def test_needs_the_token(self):
        self.assertEqual(server.parse_request(b'{"id":1,"cmd":"state"}', TOKEN), (1, "unauthorized"))
        bad = json.dumps({"id": 2, "cmd": "state", "token": "b" * 64})
        self.assertEqual(server.parse_request(bad, TOKEN), (2, "unauthorized"))
        ok = json.dumps({"id": 3, "cmd": "state", "token": TOKEN})
        self.assertEqual(server.parse_request(ok, None), (3, "unauthorized"))

    def test_only_known_commands(self):
        req = json.dumps({"id": 1, "cmd": "exec", "token": TOKEN, "code": "print(1)"})
        self.assertEqual(server.parse_request(req, TOKEN), (1, "unknown command"))
        req = json.dumps({"id": 1, "cmd": "object", "token": TOKEN})
        self.assertEqual(server.parse_request(req, TOKEN), (1, "name required"))

    def test_bad_json(self):
        self.assertEqual(server.parse_request(b"{nope", TOKEN), (None, "bad json"))
        self.assertEqual(server.parse_request(b"[1]", TOKEN), (None, "bad request"))

    def test_good_request(self):
        req, err = server.parse_request(json.dumps({"cmd": "state", "token": TOKEN}), TOKEN)
        self.assertIsNone(err)
        self.assertEqual(req["cmd"], "state")


class Helpers(unittest.TestCase):
    def test_op_idname(self):
        self.assertEqual(server.op_idname("mesh.primitive_monkey_add"), "MESH_OT_primitive_monkey_add")
        self.assertEqual(server.op_idname("TRANSFORM_OT_translate"), "TRANSFORM_OT_translate")

    def test_select_mode_label(self):
        self.assertEqual(server.select_mode_label((False, False, True)), "FACE")
        self.assertEqual(server.select_mode_label((True, True, False)), "VERTEX+EDGE")
        self.assertIsNone(server.select_mode_label((False, False, False)))

    def test_read_token(self):
        self.assertIsNone(server.read_token(os.path.join(os.path.dirname(__file__), "missing")))


class OperatorLogTest(unittest.TestCase):
    def test_counts_only_new_operators(self):
        log = server.OperatorLog()
        log.update([(1, "object.select_all", "Select")])
        self.assertEqual(log.seq, 0)
        log.update([(1, "object.select_all", "Select")])
        self.assertEqual(log.seq, 0)
        log.update(
            [
                (1, "object.select_all", "Select"),
                (2, "transform.translate", "Move"),
                (3, "transform.rotate", "Rotate"),
            ]
        )
        self.assertEqual(log.seq, 2)
        self.assertEqual(
            [e["idname"] for e in log.entries], ["TRANSFORM_OT_translate", "TRANSFORM_OT_rotate"]
        )
        self.assertEqual(log.entries[-1]["seq"], 2)

    def test_keeps_a_short_history(self):
        log = server.OperatorLog()
        log.update([])
        for i in range(1, 40):
            log.update([(i, "mesh.extrude_region", "Extrude")])
        self.assertEqual(log.seq, 39)
        self.assertEqual(len(log.entries), server.HISTORY)


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.srv = server.Server(port=0, token_reader=lambda: TOKEN)
        self.srv.start()
        self.stop = threading.Event()

        def main_thread():
            while not self.stop.is_set():
                self.srv.drain(lambda req: {"mode": "OBJECT", "cmd": req["cmd"]})
                self.stop.wait(0.02)

        self.loop = threading.Thread(target=main_thread, daemon=True)
        self.loop.start()

    def tearDown(self):
        self.stop.set()
        self.srv.stop()

    def ask(self, *reqs):
        with socket.create_connection(("127.0.0.1", self.srv.port), timeout=3) as s:
            f = s.makefile("rwb")
            out = []
            for r in reqs:
                f.write((json.dumps(r) + "\n").encode())
                f.flush()
                out.append(json.loads(f.readline()))
            return out

    def test_state_round_trip(self):
        ping, state = self.ask(
            {"id": 1, "cmd": "ping", "token": TOKEN}, {"id": 2, "cmd": "state", "token": TOKEN}
        )
        self.assertEqual(ping, {"id": 1, "ok": True, "result": {"bridge": server.VERSION}})
        self.assertEqual(state, {"id": 2, "ok": True, "result": {"mode": "OBJECT", "cmd": "state"}})

    def test_rejects_without_token(self):
        (reply,) = self.ask({"id": 7, "cmd": "state"})
        self.assertEqual(reply, {"id": 7, "ok": False, "error": "unauthorized"})

    def test_binds_localhost_only(self):
        self.assertEqual(self.srv._sock.getsockname()[0], "127.0.0.1")


if __name__ == "__main__":
    unittest.main()
