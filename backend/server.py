"""Face Recall Hub: standard-library HTTP server and SQLite-backed API."""

import base64
import binascii
import json
import logging
import os
import re
import sqlite3
import threading
import time
import uuid
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

import cv2
import numpy as np

ROOT_DIR = Path(__file__).resolve().parents[1]
FRONTEND_DIR = ROOT_DIR / "frontend"
DEFAULT_DATABASE = ROOT_DIR / "backend" / "data" / "face_recall_hub.sqlite3"
MAX_REQUEST_BYTES = 20 * 1024 * 1024
FACE_MODEL = "Facenet512"
FACE_DETECTOR = "opencv"
FACE_METRIC = "cosine"
FALLBACK_THRESHOLDS = {
    ("Facenet512", "cosine"): 0.30,
    ("Facenet512", "euclidean"): 23.56,
    ("Facenet512", "euclidean_l2"): 0.67,
}
FACE_LOCK = threading.Lock()
LOGGER = logging.getLogger("face_recall_hub")


class InputValidationError(Exception):
    """A syntactically valid API request contains an invalid field."""


def load_local_environment() -> None:
    env_file = ROOT_DIR / "backend" / ".env"
    if not env_file.is_file():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        key, separator, value = line.partition("=")
        if separator and key.strip() and not key.lstrip().startswith("#"):
            value = value.strip().strip("\"'")
            os.environ.setdefault(key.strip(), value)


load_local_environment()
FACE_MODEL = os.environ.get("FACE_MODEL", FACE_MODEL)
FACE_DETECTOR = os.environ.get("FACE_DETECTOR", FACE_DETECTOR)
FACE_METRIC = os.environ.get("FACE_METRIC", FACE_METRIC)
DATABASE_PATH = Path(os.environ.get("DATABASE_PATH", str(DEFAULT_DATABASE)))
if not DATABASE_PATH.is_absolute():
    DATABASE_PATH = ROOT_DIR / DATABASE_PATH


@contextmanager
def database():
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=30)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def ensure_database() -> None:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(DATABASE_PATH, timeout=30)) as connection:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS persons (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                roll_no TEXT NOT NULL UNIQUE,
                department TEXT NOT NULL,
                email TEXT,
                notes TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS persons_created_at
                ON persons (created_at DESC);

            CREATE TABLE IF NOT EXISTS person_images (
                person_id TEXT PRIMARY KEY REFERENCES persons(id) ON DELETE CASCADE,
                content_type TEXT NOT NULL,
                data BLOB NOT NULL
            );

            CREATE TABLE IF NOT EXISTS face_embeddings (
                person_id TEXT PRIMARY KEY REFERENCES persons(id) ON DELETE CASCADE,
                embedding TEXT NOT NULL,
                face_model TEXT NOT NULL,
                detector TEXT NOT NULL,
                metric TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS face_embeddings_config
                ON face_embeddings (face_model, detector, metric);

            CREATE TABLE IF NOT EXISTS status_checks (
                id TEXT PRIMARY KEY,
                client_name TEXT NOT NULL,
                timestamp TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS status_checks_timestamp
                ON status_checks (timestamp DESC);
            """
        )


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def person_from_row(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "roll_no": row["roll_no"],
        "department": row["department"],
        "email": row["email"],
        "notes": row["notes"],
        "created_at": row["created_at"],
        "has_image": True,
    }


def decode_image(data: str) -> np.ndarray | None:
    if not isinstance(data, str) or not data:
        return None
    payload = data.strip()
    if payload.startswith("data:"):
        header, separator, payload = payload.partition(",")
        if not separator or ";base64" not in header:
            return None
    try:
        raw = base64.b64decode(payload, validate=True)
        image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    except (binascii.Error, ValueError, TypeError):
        return None
    if image is None or image.size == 0:
        return None
    height, width = image.shape[:2]
    scale = max(height, width) / 1400
    if scale > 1:
        image = cv2.resize(
            image,
            (max(1, int(width / scale)), max(1, int(height / scale))),
            interpolation=cv2.INTER_AREA,
        )
    return image


def build_embedding(image: np.ndarray) -> list[float]:
    from deepface import DeepFace

    with FACE_LOCK:
        try:
            faces = DeepFace.extract_faces(
                img_path=image,
                detector_backend=FACE_DETECTOR,
                enforce_detection=True,
                align=False,
                color_face="bgr",
                normalize_face=False,
            )
        except ValueError as exc:
            if type(exc).__name__ == "FaceNotDetected" or "face could not be detected" in str(exc).lower():
                raise LookupError("No face was detected. Choose a clear, front-facing photo.") from exc
            raise
        if not faces:
            raise LookupError("No face was detected. Choose a clear, front-facing photo.")

        def face_area(item: dict) -> int:
            box = item.get("facial_area") or {}
            return int(box.get("w", 0)) * int(box.get("h", 0))

        box = max(faces, key=face_area).get("facial_area") or {}
        x, y = max(0, int(box.get("x", 0))), max(0, int(box.get("y", 0)))
        width = min(int(box.get("w", 0)), image.shape[1] - x)
        height = min(int(box.get("h", 0)), image.shape[0] - y)
        if width <= 0 or height <= 0:
            raise LookupError("No face was detected. Choose a clear, front-facing photo.")
        crop = image[y : y + height, x : x + width].copy()
        representations = DeepFace.represent(
            img_path=crop,
            model_name=FACE_MODEL,
            detector_backend="skip",
            enforce_detection=False,
        )
    if not representations or not representations[0].get("embedding"):
        raise LookupError("No face embedding could be generated.")
    return [float(value) for value in representations[0]["embedding"]]


def face_threshold() -> float:
    override = os.environ.get("FACE_THRESHOLD")
    if override:
        try:
            return float(override)
        except ValueError as exc:
            raise ValueError("FACE_THRESHOLD must be a number") from exc
    try:
        from deepface.modules.verification import find_threshold

        return float(find_threshold(model_name=FACE_MODEL, distance_metric=FACE_METRIC))
    except (ImportError, AttributeError, ValueError):
        return FALLBACK_THRESHOLDS.get((FACE_MODEL, FACE_METRIC), 0.30)


def face_distance(first: list[float], second: list[float]) -> float:
    left = np.asarray(first, dtype=np.float64)
    right = np.asarray(second, dtype=np.float64)
    if left.shape != right.shape:
        raise ValueError("Stored face embedding dimensions do not match the active model.")
    if FACE_METRIC == "cosine":
        denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
        return 2.0 if denominator == 0 else float(1.0 - np.dot(left, right) / denominator)
    if FACE_METRIC == "euclidean":
        return float(np.linalg.norm(left - right))
    if FACE_METRIC == "euclidean_l2":
        left_norm, right_norm = float(np.linalg.norm(left)), float(np.linalg.norm(right))
        if left_norm == 0 or right_norm == 0:
            return float("inf")
        return float(np.linalg.norm(left / left_norm - right / right_norm))
    raise ValueError(f"Unsupported face distance metric: {FACE_METRIC}")


def similarity_percent(distance: float) -> float:
    return round(max(0.0, min(1.0, 1.0 - distance)) * 100.0, 1)


def recognition_result(result: str, message: str, latency_ms: int, **extra) -> dict:
    return {
        "result": result,
        "message": message,
        "threshold": face_threshold(),
        "face_model": FACE_MODEL,
        "detector": FACE_DETECTOR,
        "metric": FACE_METRIC,
        "latency_ms": latency_ms,
        "person": None,
        "distance": None,
        "similarity_pct": None,
        **extra,
    }


def error_body(message: str) -> dict:
    return {"detail": {"message": message}}


class FaceRecallHandler(SimpleHTTPRequestHandler):
    server_version = "FaceRecallHub/2"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FRONTEND_DIR), **kwargs)

    def log_message(self, format_string: str, *args) -> None:
        LOGGER.info("%s - %s", self.address_string(), format_string % args)

    def send_json(self, status: int, payload: dict | list) -> None:
        content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def send_api_error(self, status: int, message: str) -> None:
        self.send_json(status, error_body(message))

    def read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Invalid request content length.") from exc
        if length <= 0:
            raise ValueError("A JSON request body is required.")
        if length > MAX_REQUEST_BYTES:
            raise OverflowError("The submitted request is too large.")
        try:
            payload = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("The request body must contain valid JSON.") from exc
        if not isinstance(payload, dict):
            raise ValueError("The JSON request body must be an object.")
        return payload

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        path = unquote(parsed.path)
        if path.startswith("/api/") or path == "/api":
            try:
                self.handle_api_get(path)
            except sqlite3.Error:
                LOGGER.exception("SQLite request failed")
                self.send_api_error(503, "The database request failed. Check the SQLite database file and retry.")
            except (OSError, ValueError):
                LOGGER.exception("API request failed")
                self.send_api_error(500, "The request could not be completed.")
            return
        if path in {"/", "/register", "/live", "/scan", "/records"}:
            self.path = "/index.html"
        super().do_GET()

    def handle_api_get(self, path: str) -> None:
        if path in {"/api", "/api/"}:
            self.send_json(200, {"message": "Face Recall Hub API"})
            return
        if path == "/api/stats":
            with database() as connection:
                count = connection.execute("SELECT COUNT(*) FROM persons").fetchone()[0]
            self.send_json(
                200,
                {
                    "persons": count,
                    "face_model": FACE_MODEL,
                    "detector": FACE_DETECTOR,
                    "metric": FACE_METRIC,
                    "threshold": face_threshold(),
                    "database": "connected",
                    "app_version": "1.0.0",
                },
            )
            return
        if path == "/api/persons":
            with database() as connection:
                rows = connection.execute(
                    "SELECT id, name, roll_no, department, email, notes, created_at "
                    "FROM persons ORDER BY created_at DESC LIMIT 5000"
                ).fetchall()
            self.send_json(200, [person_from_row(row) for row in rows])
            return
        image_match = re.fullmatch(r"/api/persons/([^/]+)/image", path)
        if image_match:
            with database() as connection:
                row = connection.execute(
                    "SELECT content_type, data FROM person_images WHERE person_id = ?",
                    (image_match.group(1),),
                ).fetchone()
            if row is None:
                self.send_api_error(404, "Photo not found.")
            else:
                data = bytes(row["data"])
                self.send_response(200)
                self.send_header("Content-Type", row["content_type"])
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "private, max-age=60")
                self.end_headers()
                self.wfile.write(data)
            return
        if path == "/api/status":
            with database() as connection:
                rows = connection.execute(
                    "SELECT id, client_name, timestamp FROM status_checks "
                    "ORDER BY timestamp DESC LIMIT 1000"
                ).fetchall()
            self.send_json(200, [dict(row) for row in rows])
            return
        self.send_api_error(404, "API endpoint not found.")

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if not path.startswith("/api/"):
            self.send_api_error(404, "API endpoint not found.")
            return
        try:
            payload = self.read_json()
            if path == "/api/persons":
                self.create_person(payload)
            elif path == "/api/recognize":
                self.recognize(payload)
            elif path == "/api/status":
                self.create_status(payload)
            else:
                self.send_api_error(404, "API endpoint not found.")
        except OverflowError as exc:
            self.send_api_error(413, str(exc))
        except InputValidationError as exc:
            self.send_api_error(422, str(exc))
        except ValueError as exc:
            self.send_api_error(400, str(exc))
        except sqlite3.IntegrityError:
            LOGGER.info("A person registration violated a database constraint")
            self.send_api_error(409, "That roll number is already registered.")
        except sqlite3.Error:
            LOGGER.exception("SQLite write failed")
            self.send_api_error(503, "The database request failed. Check the SQLite database file and retry.")
        except Exception:
            LOGGER.exception("API request failed")
            self.send_api_error(500, "The request could not be completed.")

    def create_person(self, payload: dict) -> None:
        name = self.required_text(payload, "name", 80)
        roll_no = self.required_text(payload, "roll_no", 32)
        department = self.required_text(payload, "department", 80)
        email_value = payload.get("email")
        notes_value = payload.get("notes")
        if email_value is not None and not isinstance(email_value, str):
            self.send_api_error(422, "Email must be text.")
            return
        if notes_value is not None and not isinstance(notes_value, str):
            self.send_api_error(422, "Notes must be text.")
            return
        email = email_value.strip() or None if email_value is not None else None
        notes = notes_value.strip() or None if notes_value is not None else None
        if email is not None and (
            len(email) > 254 or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email)
        ):
            self.send_api_error(422, "Enter a valid email address.")
            return
        if notes is not None and len(notes) > 500:
            self.send_api_error(422, "Notes must contain at most 500 characters.")
            return
        image = decode_image(payload.get("image_b64"))
        if image is None:
            self.send_api_error(422, "The uploaded image is invalid or unsupported.")
            return
        try:
            embedding = build_embedding(image)
        except LookupError as exc:
            self.send_api_error(422, str(exc))
            return
        except Exception:
            LOGGER.exception("Face embedding failed during registration")
            self.send_api_error(
                503,
                "Face recognition could not process this image. Check the Python terminal and "
                "the troubleshooting section in README.md, then restart the backend.",
            )
            return

        encoded, buffer = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
        if not encoded:
            self.send_api_error(422, "The image could not be stored.")
            return
        person = {
            "id": str(uuid.uuid4()),
            "name": name,
            "roll_no": roll_no,
            "department": department,
            "email": email,
            "notes": notes,
            "created_at": utc_now(),
            "has_image": True,
        }
        with database() as connection:
            connection.execute(
                "INSERT INTO persons (id, name, roll_no, department, email, notes, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                tuple(person[key] for key in ("id", "name", "roll_no", "department", "email", "notes", "created_at")),
            )
            connection.execute(
                "INSERT INTO person_images (person_id, content_type, data) VALUES (?, ?, ?)",
                (person["id"], "image/jpeg", buffer.tobytes()),
            )
            connection.execute(
                "INSERT INTO face_embeddings (person_id, embedding, face_model, detector, metric) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    person["id"],
                    json.dumps(embedding),
                    FACE_MODEL,
                    FACE_DETECTOR,
                    FACE_METRIC,
                ),
            )
        self.send_json(201, person)

    @staticmethod
    def required_text(payload: dict, key: str, maximum: int) -> str:
        value = payload.get(key)
        if not isinstance(value, str):
            raise InputValidationError(f"{key} is required.")
        value = value.strip()
        if not value or len(value) > maximum:
            raise InputValidationError(f"{key} must contain between 1 and {maximum} characters.")
        return value

    def recognize(self, payload: dict) -> None:
        image = decode_image(payload.get("image_b64"))
        if image is None:
            self.send_api_error(422, "The submitted image could not be decoded.")
            return
        started = time.perf_counter()
        try:
            embedding = build_embedding(image)
        except LookupError:
            self.send_json(
                200,
                recognition_result(
                    "no_face",
                    "No face was detected in the submitted image — try a clearer, front-facing shot.",
                    int((time.perf_counter() - started) * 1000),
                ),
            )
            return
        except Exception:
            LOGGER.exception("Face embedding failed during recognition")
            self.send_api_error(503, "Face recognition is unavailable. Check the model setup.")
            return

        with database() as connection:
            rows = connection.execute(
                "SELECT person_id, embedding FROM face_embeddings "
                "WHERE face_model = ? AND detector = ? AND metric = ? LIMIT 5000",
                (FACE_MODEL, FACE_DETECTOR, FACE_METRIC),
            ).fetchall()
            people = {
                row["id"]: row
                for row in connection.execute(
                    "SELECT id, name, roll_no, department, email, notes, created_at FROM persons"
                ).fetchall()
            }
        if not rows:
            self.send_json(
                200,
                recognition_result(
                    "no_match",
                    "No faces are registered yet — register one first, then scan again.",
                    int((time.perf_counter() - started) * 1000),
                ),
            )
            return
        candidates = [
            (row["person_id"], face_distance(embedding, json.loads(row["embedding"])))
            for row in rows
        ]
        person_id, distance = min(candidates, key=lambda candidate: candidate[1])
        threshold = face_threshold()
        elapsed = int((time.perf_counter() - started) * 1000)
        details = {
            "distance": round(distance, 4),
            "similarity_pct": similarity_percent(distance) if FACE_METRIC == "cosine" else None,
        }
        if distance <= threshold and person_id in people:
            person = person_from_row(people[person_id])
            self.send_json(
                200,
                recognition_result(
                    "match",
                    f"Matched {person['name']} — retrieved the registered record.",
                    elapsed,
                    person=person,
                    **details,
                ),
            )
            return
        self.send_json(
            200,
            recognition_result(
                "no_match",
                "No registered face is similar enough — this person is not in the database.",
                elapsed,
                **details,
            ),
        )

    def create_status(self, payload: dict) -> None:
        client_name = self.required_text(payload, "client_name", 100)
        status = {
            "id": str(uuid.uuid4()),
            "client_name": client_name,
            "timestamp": utc_now(),
        }
        with database() as connection:
            connection.execute(
                "INSERT INTO status_checks (id, client_name, timestamp) VALUES (?, ?, ?)",
                (status["id"], status["client_name"], status["timestamp"]),
            )
        self.send_json(200, status)

    def do_DELETE(self) -> None:
        path = unquote(urlsplit(self.path).path)
        match = re.fullmatch(r"/api/persons/([^/]+)", path)
        if not match:
            self.send_api_error(404, "API endpoint not found.")
            return
        try:
            with database() as connection:
                cursor = connection.execute("DELETE FROM persons WHERE id = ?", (match.group(1),))
                if cursor.rowcount == 0:
                    self.send_api_error(404, "Person not found.")
                    return
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
        except sqlite3.Error:
            LOGGER.exception("SQLite delete failed")
            self.send_api_error(503, "The database request failed. Check the SQLite database file and retry.")


def warm_face_model() -> None:
    try:
        from deepface import DeepFace

        with FACE_LOCK:
            DeepFace.build_model(FACE_MODEL)
        LOGGER.info("Face model ready: %s", FACE_MODEL)
    except Exception:
        LOGGER.exception("Face model warm-up failed; registration and recognition may be unavailable.")


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    ensure_database()
    LOGGER.info("SQLite database ready at %s", DATABASE_PATH)
    threading.Thread(target=warm_face_model, name="face-model-warmup", daemon=True).start()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer((host, port), FaceRecallHandler)
    server.daemon_threads = True
    LOGGER.info("Face Recall Hub listening at http://%s:%s", host, port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOGGER.info("Shutting down")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
