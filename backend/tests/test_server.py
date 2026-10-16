import base64
import http.client
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import cv2
import numpy as np

import server


class ApiDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.previous_database_path = server.DATABASE_PATH
        server.DATABASE_PATH = Path(self.temp_dir.name) / "test.sqlite3"
        server.ensure_database()
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.FaceRecallHandler)
        self.httpd.daemon_threads = False
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.connection = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port)

    def tearDown(self):
        self.connection.close()
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        server.DATABASE_PATH = self.previous_database_path
        self.temp_dir.cleanup()

    def request(self, method, path, payload=None):
        body = json.dumps(payload).encode() if payload is not None else None
        headers = {"Content-Type": "application/json"} if body else {}
        self.connection.request(method, path, body=body, headers=headers)
        response = self.connection.getresponse()
        content = response.read()
        return response.status, response.getheader("Content-Type", ""), content

    @staticmethod
    def valid_person_payload(roll_no="2026-CSE-001"):
        ok, buffer = cv2.imencode(".jpg", np.zeros((24, 24, 3), dtype=np.uint8))
        if not ok:
            raise RuntimeError("Could not build JPEG test image")
        return {
            "name": "Example Person",
            "roll_no": roll_no,
            "department": "Computer Science & Engineering",
            "email": "person@example.edu",
            "notes": "SQLite API test",
            "image_b64": base64.b64encode(buffer.tobytes()).decode("ascii"),
        }

    def test_database_uses_wal_and_preserves_integrity(self):
        with closing(sqlite3.connect(server.DATABASE_PATH)) as connection:
            self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_registration_is_atomic_and_delete_cascades(self):
        with patch.object(server, "build_embedding", return_value=[0.2, 0.8]):
            status, _, body = self.request("POST", "/api/persons", self.valid_person_payload())
            self.assertEqual(status, 201)
            person = json.loads(body)

            status, _, body = self.request("POST", "/api/persons", self.valid_person_payload())
            self.assertEqual(status, 409)
            self.assertIn("already registered", json.loads(body)["detail"]["message"])

        with closing(sqlite3.connect(server.DATABASE_PATH)) as connection:
            for table in ("persons", "person_images", "face_embeddings"):
                self.assertEqual(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 1)

        status, _, body = self.request("GET", "/api/persons")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)[0]["id"], person["id"])

        self.connection.request("GET", f"/api/persons/{person['id']}/image")
        image_response = self.connection.getresponse()
        self.assertEqual(image_response.status, 200)
        self.assertTrue(image_response.read().startswith(b"\xff\xd8"))

        status, _, body = self.request("DELETE", f"/api/persons/{person['id']}")
        self.assertEqual(status, 204)
        with closing(sqlite3.connect(server.DATABASE_PATH)) as connection:
            for table in ("persons", "person_images", "face_embeddings"):
                self.assertEqual(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0)

    def test_validation_and_recognition_no_face_are_reported(self):
        status, _, body = self.request(
            "POST",
            "/api/persons",
            {"name": " ", "roll_no": "x", "department": "CSE", "image_b64": "not-base64"},
        )
        self.assertEqual(status, 422)
        self.assertIn("name", json.loads(body)["detail"]["message"])

        ok, buffer = cv2.imencode(".jpg", np.zeros((24, 24, 3), dtype=np.uint8))
        self.assertTrue(ok)
        class FaceNotDetected(ValueError):
            pass

        class FakeDeepFace:
            @staticmethod
            def extract_faces(**kwargs):
                raise FaceNotDetected(
                    "Face could not be detected in numpy array. Please use a clear face photo."
                )

        fake_deepface = SimpleNamespace(DeepFace=FakeDeepFace)
        image_b64 = base64.b64encode(buffer.tobytes()).decode("ascii")
        with patch.dict(sys.modules, {"deepface": fake_deepface}):
            status, _, body = self.request(
                "POST",
                "/api/persons",
                {**self.valid_person_payload(), "image_b64": image_b64},
            )
            self.assertEqual(status, 422)
            self.assertIn("No face was detected", json.loads(body)["detail"]["message"])

            status, _, body = self.request(
                "POST",
                "/api/recognize",
                {"image_b64": image_b64},
            )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["result"], "no_face")
        with closing(sqlite3.connect(server.DATABASE_PATH)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM persons").fetchone()[0], 0)

    def test_status_api_and_unknown_routes(self):
        status, _, body = self.request("POST", "/api/status", {"client_name": "test"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["client_name"], "test")

        status, _, body = self.request("GET", "/api/status")
        self.assertEqual(status, 200)
        self.assertEqual(len(json.loads(body)), 1)

        status, _, body = self.request("GET", "/api/not-a-route")
        self.assertEqual(status, 404)
        self.assertIn("not found", json.loads(body)["detail"]["message"])


if __name__ == "__main__":
    unittest.main()
