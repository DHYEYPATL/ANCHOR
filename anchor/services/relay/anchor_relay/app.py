from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Annotated
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, field_validator

DB_PATH = Path(os.getenv("ANCHOR_RELAY_DB", "./data/relay.sqlite3"))
MAX_CIPHERTEXT_BYTES = int(os.getenv("ANCHOR_MAX_CIPHERTEXT_BYTES", str(1024 * 1024)))
MAX_REQUEST_BODY_BYTES = ((MAX_CIPHERTEXT_BYTES + 2) // 3) * 4 + 16_384
ADMIN_TOKEN = os.getenv("ANCHOR_ADMIN_TOKEN", "")
MAX_VAULT_BYTES = int(os.getenv("ANCHOR_MAX_VAULT_BYTES", str(50 * 1024 * 1024)))
MAX_CHANGES_PER_PULL = 200
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{40,100}$")

@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


class RequestBodyLimitMiddleware:
    """Bound request bodies even when a client omits Content-Length (chunked transfer)."""
    def __init__(self, app, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("method") not in {"POST", "PUT", "PATCH"}:
            await self.app(scope, receive, send)
            return
        headers = {k.lower(): v for k, v in scope.get("headers", [])}
        declared = headers.get(b"content-length")
        if declared:
            try:
                if int(declared) > self.max_bytes:
                    await self._too_large(scope, send)
                    return
            except ValueError:
                await self._bad_length(scope, send)
                return
        body = bytearray()
        while True:
            message = await receive()
            if message.get("type") == "http.disconnect":
                return
            if message.get("type") != "http.request":
                continue
            body.extend(message.get("body", b""))
            if len(body) > self.max_bytes:
                await self._too_large(scope, send)
                return
            if not message.get("more_body", False):
                break
        sent = False
        buffered = bytes(body)
        async def replay_receive():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": buffered, "more_body": False}
            # The request body has been consumed. An empty terminal request keeps ASGI
            # consumers which inspect receive after body parsing from waiting on the socket.
            return {"type": "http.request", "body": b"", "more_body": False}
        await self.app(scope, replay_receive, send)

    async def _too_large(self, scope, send):
        await self._plain(scope, send, 413, b"Request too large")

    async def _bad_length(self, scope, send):
        await self._plain(scope, send, 400, b"Invalid Content-Length")

    async def _plain(self, scope, send, status: int, body: bytes):
        headers = [(b"content-type", b"text/plain; charset=utf-8"), (b"cache-control", b"no-store"),
                   (b"x-content-type-options", b"nosniff"), (b"x-frame-options", b"DENY")]
        origin = dict(scope.get("headers", [])).get(b"origin", b"").decode("latin1")
        if origin in _allowed_origins:
            headers.extend([(b"access-control-allow-origin", origin.encode("latin1")), (b"vary", b"Origin")])
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body, "more_body": False})


app = FastAPI(title="Anchor encrypted sync relay", version="0.1.0", docs_url=None, redoc_url=None, lifespan=lifespan)
_allowed_origins = [v.strip() for v in os.getenv("ANCHOR_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if v.strip()]
# Add this before CORS so CORS and the security-header middleware also wrap 413 responses.
app.add_middleware(RequestBodyLimitMiddleware, max_bytes=MAX_REQUEST_BODY_BYTES)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
    max_age=600,
)


@contextmanager
def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA busy_timeout=10000")
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def init_db() -> None:
    with connect() as con:
        con.executescript("""
        CREATE TABLE IF NOT EXISTS rooms (
          vault_id TEXT PRIMARY KEY,
          token_hash BLOB NOT NULL,
          created_at INTEGER NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS changes (
          cursor INTEGER PRIMARY KEY AUTOINCREMENT,
          vault_id TEXT NOT NULL REFERENCES rooms(vault_id) ON DELETE CASCADE,
          change_id TEXT NOT NULL,
          nonce TEXT NOT NULL,
          ciphertext TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          ciphertext_bytes INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(vault_id, change_id)
        );
        CREATE INDEX IF NOT EXISTS idx_changes_vault_cursor ON changes(vault_id, cursor);
        CREATE TABLE IF NOT EXISTS devices (
          vault_id TEXT NOT NULL REFERENCES rooms(vault_id) ON DELETE CASCADE,
          device_id TEXT NOT NULL,
          last_ack INTEGER NOT NULL DEFAULT 0,
          last_seen INTEGER NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(vault_id, device_id)
        );
        CREATE TABLE IF NOT EXISTS request_windows (
          bucket TEXT PRIMARY KEY,
          window_start INTEGER NOT NULL,
          request_count INTEGER NOT NULL
        );
        """)


@app.middleware("http")
async def security_and_body_limits(request: Request, call_next):
    # Reject oversized declared bodies before JSON parsing. The reverse proxy MUST also
    # enforce a streaming body limit; see docs/OPERATIONS.md. Starlette's default request
    # buffering is not a substitute for an edge/proxy limit against slow oversized uploads.
    length = request.headers.get("content-length")
    if length:
        try:
            if int(length) > MAX_REQUEST_BODY_BYTES:
                return Response("Request too large", status_code=413, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
        except ValueError:
            return Response("Invalid Content-Length", status_code=400, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    if request.url.path.startswith("/v1/"):
        # Single-process defense against unauthenticated token guessing and registration abuse.
        # Production multi-worker deployments must enforce a shared IP rate limit at the edge.
        rate_limit(f"ip:{request.client.host if request.client else 'unknown'}", limit=900)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    return response


class RoomRegistration(BaseModel):
    model_config = ConfigDict(extra="forbid")
    vault_id: str
    access_token: str = Field(min_length=40, max_length=100)

    @field_validator("vault_id")
    @classmethod
    def validate_vault_id(cls, value: str) -> str:
        try:
            return str(UUID(value))
        except ValueError as exc:
            raise ValueError("vault_id must be a UUID") from exc

    @field_validator("access_token")
    @classmethod
    def validate_token(cls, value: str) -> str:
        if not TOKEN_RE.fullmatch(value):
            raise ValueError("access_token must be a high-entropy base64url token")
        return value


class ChangeEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    change_id: str = Field(min_length=8, max_length=80, pattern=r"^[A-Za-z0-9._:-]+$")
    nonce: str = Field(min_length=12, max_length=100)
    ciphertext: str = Field(min_length=24, max_length=MAX_CIPHERTEXT_BYTES * 2)
    schema_version: int = Field(ge=1, le=1)

    @field_validator("nonce", "ciphertext")
    @classmethod
    def validate_base64urlish(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_+/=-]+", value):
            raise ValueError("invalid encoded bytes")
        return value


class DeviceAck(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_id: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9._:-]+$")
    cursor: int = Field(ge=0)


def token_digest(token: str) -> bytes:
    return hashlib.sha256(token.encode("utf-8")).digest()


def authenticate(vault_id: str, authorization: str | None) -> sqlite3.Row:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization[7:]
    if not TOKEN_RE.fullmatch(token):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    with connect() as con:
        room = con.execute("SELECT * FROM rooms WHERE vault_id = ?", (vault_id,)).fetchone()
    if room is None or room["revoked"] or not hmac.compare_digest(room["token_hash"], token_digest(token)):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return room


def rate_limit(key: str, limit: int = 120, window: int = 60) -> None:
    # Best-effort per-process protection for a self-hosted single-worker relay.
    # Put a shared rate limiter (e.g. Redis/API gateway) in front of multi-worker deployments.
    now = int(time.time())
    bucket = f"{key}:{now // window}"
    with connect() as con:
        con.execute("DELETE FROM request_windows WHERE window_start < ?", (now - window * 2,))
        con.execute("INSERT INTO request_windows(bucket, window_start, request_count) VALUES(?,?,1) "
                    "ON CONFLICT(bucket) DO UPDATE SET request_count=request_count+1", (bucket, now))
        count = con.execute("SELECT request_count FROM request_windows WHERE bucket=?", (bucket,)).fetchone()[0]
    if count > limit:
        raise HTTPException(status_code=429, detail="Too many requests; retry later")


@app.get("/healthz")
def healthz():
    return {"status": "ok", "service": "anchor-relay", "version": "0.1.0"}


@app.get("/readyz")
def readyz():
    try:
        with connect() as con:
            con.execute("SELECT 1").fetchone()
        return {"status": "ready"}
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail="Storage unavailable") from exc


@app.post("/v1/rooms", status_code=201)
def register_room(body: RoomRegistration, request: Request):
    rate_limit(request.client.host if request.client else "unknown", limit=20)
    digest = token_digest(body.access_token)
    with connect() as con:
        existing = con.execute("SELECT token_hash, revoked FROM rooms WHERE vault_id=?", (body.vault_id,)).fetchone()
        if existing:
            if existing["revoked"] or not hmac.compare_digest(existing["token_hash"], digest):
                raise HTTPException(status_code=409, detail="Vault ID already exists")
            # Idempotent setup on the paired device; never replace credentials implicitly.
            return {"vault_id": body.vault_id, "registered": True, "already_registered": True}
        con.execute("INSERT INTO rooms(vault_id, token_hash, created_at) VALUES(?,?,?)",
                    (body.vault_id, digest, int(time.time())))
    return {"vault_id": body.vault_id, "registered": True, "already_registered": False}


@app.post("/v1/rooms/{vault_id}/changes", status_code=201)
def push_change(vault_id: str, body: ChangeEnvelope, request: Request,
                authorization: Annotated[str | None, Header()] = None):
    authenticate(vault_id, authorization)
    rate_limit(f"vault:{vault_id}", limit=600)
    try:
        raw = body.ciphertext.encode("ascii")
        # Ciphertext is base64 encoded; actual payload may be at most the configured cap.
        import base64
        decoded = base64.b64decode(raw, validate=True)
        nonce_bytes = base64.b64decode(body.nonce.encode("ascii"), validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Malformed encoded envelope") from exc
    if len(nonce_bytes) != 12:
        raise HTTPException(status_code=400, detail="Invalid nonce length")
    if len(decoded) > MAX_CIPHERTEXT_BYTES:
        raise HTTPException(status_code=413, detail="Encrypted change exceeds size limit")
    with connect() as con:
        current_bytes = con.execute("SELECT COALESCE(SUM(ciphertext_bytes),0) FROM changes WHERE vault_id=?", (vault_id,)).fetchone()[0]
        existing = con.execute("SELECT cursor,nonce,ciphertext,schema_version FROM changes WHERE vault_id=? AND change_id=?", (vault_id, body.change_id)).fetchone()
        if existing:
            # Idempotent retries must be byte-identical. Reusing an ID for different bytes
            # is a protocol violation and must never silently acknowledge the wrong payload.
            if (existing["nonce"] != body.nonce or existing["ciphertext"] != body.ciphertext or
                    existing["schema_version"] != body.schema_version):
                raise HTTPException(status_code=409, detail="Change ID was reused for a different encrypted envelope")
            return {"cursor": existing["cursor"], "duplicate": True}
        if current_bytes + len(decoded) > MAX_VAULT_BYTES:
            raise HTTPException(status_code=507, detail="Vault relay quota reached; remove relay data or use direct sync")
        cur = con.execute("INSERT INTO changes(vault_id,change_id,nonce,ciphertext,schema_version,ciphertext_bytes,created_at) VALUES(?,?,?,?,?,?,?)",
                          (vault_id, body.change_id, body.nonce, body.ciphertext, body.schema_version, len(decoded), int(time.time())))
        cursor = cur.lastrowid
    return {"cursor": cursor, "duplicate": False}


@app.get("/v1/rooms/{vault_id}/changes")
def pull_changes(vault_id: str, after: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=MAX_CHANGES_PER_PULL),
                 authorization: Annotated[str | None, Header()] = None):
    authenticate(vault_id, authorization)
    rate_limit(f"vault:{vault_id}", limit=600)
    with connect() as con:
        rows = con.execute("SELECT cursor,change_id,nonce,ciphertext,schema_version,created_at FROM changes "
                           "WHERE vault_id=? AND cursor>? ORDER BY cursor ASC LIMIT ?", (vault_id, after, limit)).fetchall()
    changes = [dict(row) for row in rows]
    return {"changes": changes, "next_cursor": changes[-1]["cursor"] if changes else after,
            "has_more": len(changes) == limit}


@app.post("/v1/rooms/{vault_id}/ack")
def acknowledge(vault_id: str, body: DeviceAck, authorization: Annotated[str | None, Header()] = None):
    authenticate(vault_id, authorization)
    with connect() as con:
        max_cursor = con.execute("SELECT COALESCE(MAX(cursor),0) FROM changes WHERE vault_id=?", (vault_id,)).fetchone()[0]
        if body.cursor > max_cursor:
            raise HTTPException(status_code=400, detail="Cannot acknowledge a cursor that does not exist")
        con.execute("INSERT INTO devices(vault_id,device_id,last_ack,last_seen) VALUES(?,?,?,?) "
                    "ON CONFLICT(vault_id,device_id) DO UPDATE SET last_ack=MAX(last_ack,excluded.last_ack),last_seen=excluded.last_seen,revoked=0",
                    (vault_id, body.device_id, body.cursor, int(time.time())))
    return {"acknowledged": body.cursor}


@app.get("/v1/rooms/{vault_id}/status")
def room_status(vault_id: str, authorization: Annotated[str | None, Header()] = None):
    authenticate(vault_id, authorization)
    with connect() as con:
        stat = con.execute("SELECT COUNT(*) AS changes, COALESCE(SUM(ciphertext_bytes),0) AS bytes, COALESCE(MAX(cursor),0) AS latest_cursor FROM changes WHERE vault_id=?", (vault_id,)).fetchone()
        devices = con.execute("SELECT device_id,last_ack,last_seen,revoked FROM devices WHERE vault_id=?", (vault_id,)).fetchall()
    return {"changes": stat["changes"], "stored_ciphertext_bytes": stat["bytes"], "latest_cursor": stat["latest_cursor"],
            "devices": [dict(d) for d in devices]}


@app.post("/v1/admin/rooms/{vault_id}/purge", status_code=202)
def purge_room(vault_id: str, x_admin_token: Annotated[str | None, Header()] = None):
    # Destructive operator action; disabled unless an explicit admin credential is configured.
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=503, detail="Operator purge is disabled; configure ANCHOR_ADMIN_TOKEN first")
    if not x_admin_token or not hmac.compare_digest(hashlib.sha256(x_admin_token.encode()).digest(), hashlib.sha256(ADMIN_TOKEN.encode()).digest()):
        raise HTTPException(status_code=401, detail="Invalid operator credential")
    try:
        normalized = str(UUID(vault_id))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="vault_id must be a UUID") from exc
    with connect() as con:
        result = con.execute("DELETE FROM rooms WHERE vault_id=?", (normalized,))
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Vault not found")
    return {"purged": True}


@app.post("/v1/rooms/{vault_id}/revoke", status_code=202)
def revoke_room(vault_id: str, authorization: Annotated[str | None, Header()] = None):
    # Revoking a room invalidates its shared relay token. The owner must create a new room
    # and re-pair active devices. This cannot erase plaintext already copied to a device.
    authenticate(vault_id, authorization)
    with connect() as con:
        con.execute("UPDATE rooms SET revoked=1 WHERE vault_id=?", (vault_id,))
    return {"revoked": True}
