import base64
import os
import secrets
import tempfile
import uuid

# Tests isolate relay storage before importing the app.
_tmp = tempfile.TemporaryDirectory()
os.environ["ANCHOR_RELAY_DB"] = os.path.join(_tmp.name, "relay.sqlite3")
from fastapi.testclient import TestClient
from anchor_relay.app import app, init_db

init_db()
client = TestClient(app)


def setup_room():
    vault_id = str(uuid.uuid4())
    token = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    response = client.post("/v1/rooms", json={"vault_id": vault_id, "access_token": token})
    assert response.status_code == 201
    return vault_id, token


def envelope(change_id="change-0001", ciphertext=None):
    # Simulated ciphertext only; relay must not care what it represents.
    raw = ciphertext or secrets.token_bytes(64)
    return {"change_id": change_id, "nonce": base64.b64encode(secrets.token_bytes(12)).decode(),
            "ciphertext": base64.b64encode(raw).decode(), "schema_version": 1}


def test_health_and_ready():
    assert client.get("/healthz").json()["status"] == "ok"
    assert client.get("/readyz").status_code == 200


def test_register_idempotent_but_wrong_token_cannot_take_over():
    vault, token = setup_room()
    assert client.post("/v1/rooms", json={"vault_id": vault, "access_token": token}).json()["already_registered"] is True
    other = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    assert client.post("/v1/rooms", json={"vault_id": vault, "access_token": other}).status_code == 409


def test_change_is_private_opaque_and_pulled_in_cursor_order():
    vault, token = setup_room()
    headers = {"Authorization": f"Bearer {token}"}
    first = envelope("change-0001", b"\x00opaque encrypted bytes 1")
    second = envelope("change-0002", b"\x00opaque encrypted bytes 2")
    r1 = client.post(f"/v1/rooms/{vault}/changes", json=first, headers=headers)
    r2 = client.post(f"/v1/rooms/{vault}/changes", json=second, headers=headers)
    assert r1.status_code == r2.status_code == 201
    pulled = client.get(f"/v1/rooms/{vault}/changes?after=0", headers=headers).json()
    assert [c["change_id"] for c in pulled["changes"]] == ["change-0001", "change-0002"]
    assert pulled["changes"][0]["ciphertext"] == first["ciphertext"]
    assert "opaque encrypted bytes" not in str(pulled)


def test_duplicate_push_is_idempotent():
    vault, token = setup_room()
    headers = {"Authorization": f"Bearer {token}"}
    body = envelope("replay-safe-001")
    a = client.post(f"/v1/rooms/{vault}/changes", json=body, headers=headers)
    b = client.post(f"/v1/rooms/{vault}/changes", json=body, headers=headers)
    assert a.status_code == b.status_code == 201
    assert b.json()["duplicate"] is True
    assert client.get(f"/v1/rooms/{vault}/changes", headers=headers).json()["changes"].__len__() == 1


def test_unauthorized_and_unknown_room_rejected():
    vault, _ = setup_room()
    body = envelope()
    assert client.get(f"/v1/rooms/{vault}/changes").status_code == 401
    assert client.post(f"/v1/rooms/{vault}/changes", json=body, headers={"Authorization": "Bearer " + "x" * 43}).status_code == 401


def test_cursor_acknowledgement_rejects_future_cursor():
    vault, token = setup_room()
    headers = {"Authorization": f"Bearer {token}"}
    assert client.post(f"/v1/rooms/{vault}/ack", json={"device_id": "device-12345678", "cursor": 2}, headers=headers).status_code == 400
    client.post(f"/v1/rooms/{vault}/changes", json=envelope(), headers=headers)
    assert client.post(f"/v1/rooms/{vault}/ack", json={"device_id": "device-12345678", "cursor": 1}, headers=headers).status_code == 200


def test_change_id_cannot_be_reused_for_different_ciphertext():
    vault, token = setup_room()
    headers = {"Authorization": f"Bearer {token}"}
    first = envelope("same-id-0001", b"first encrypted payload")
    second = {**first, "ciphertext": base64.b64encode(b"different encrypted payload").decode()}
    assert client.post(f"/v1/rooms/{vault}/changes", json=first, headers=headers).status_code == 201
    conflict = client.post(f"/v1/rooms/{vault}/changes", json=second, headers=headers)
    assert conflict.status_code == 409
    assert client.get(f"/v1/rooms/{vault}/changes?after=0", headers=headers).json()["changes"][0]["ciphertext"] == first["ciphertext"]


def test_nonce_must_be_a_twelve_byte_aes_gcm_nonce():
    vault, token = setup_room()
    headers = {"Authorization": f"Bearer {token}"}
    body = envelope("bad-nonce-0001")
    body["nonce"] = base64.b64encode(secrets.token_bytes(10)).decode()
    response = client.post(f"/v1/rooms/{vault}/changes", json=body, headers=headers)
    assert response.status_code == 400


def test_security_headers_are_present_and_docs_are_disabled():
    response = client.get("/healthz")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["cache-control"] == "no-store"
    assert client.get("/docs").status_code == 404


def test_oversized_declared_body_is_rejected_before_json_processing():
    response = client.post("/v1/rooms", content=b"{}", headers={"Content-Length": str(999_999_999), "Content-Type": "application/json"})
    assert response.status_code == 413


def test_streaming_body_limit_rejects_chunked_body_without_content_length():
    import asyncio
    from anchor_relay.app import RequestBodyLimitMiddleware

    downstream_called = False
    async def downstream(_scope, _receive, _send):
        nonlocal downstream_called
        downstream_called = True

    middleware = RequestBodyLimitMiddleware(downstream, max_bytes=4)
    messages = [
        {"type": "http.request", "body": b"123", "more_body": True},
        {"type": "http.request", "body": b"456", "more_body": False},
    ]
    sent = []
    async def receive():
        return messages.pop(0)
    async def send(message):
        sent.append(message)
    scope = {"type": "http", "method": "POST", "headers": [], "client": ("127.0.0.1", 12345)}
    asyncio.run(middleware(scope, receive, send))
    assert not downstream_called
    assert sent[0]["status"] == 413
    assert b"Request too large" in sent[-1]["body"]
