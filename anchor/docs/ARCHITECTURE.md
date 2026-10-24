# Architecture decision record

## Goal

Anchor is a local-first memory/action system. It ingests a capture, offers a structured interpretation for confirmation, stores a typed record with source provenance, and keeps a durable local change outbox. Optional sync transports encrypted changes between trusted replicas.

## Layers

- **Presentation:** responsive React PWA; it renders local state and explicit offline/sync/error/conflict status.
- **Application:** capture extraction, vault lifecycle, CRUD, sync orchestration and conflict review.
- **Domain:** `AnchorItem`, item kinds/status, vector clocks and deterministic validation.
- **Infrastructure:** WebCrypto AES-GCM, PBKDF2 key wrapping, IndexedDB, relay client and FastAPI/SQLite relay.

Domain logic does not depend on React or FastAPI. The local database and relay are replaceable adapters. Relay API accepts ciphertext envelopes only; it never decrypts a record.

## Storage and cryptography

- On vault creation, a 256-bit random vault key is generated on the client.
- A passphrase is used with PBKDF2-HMAC-SHA-256 (600,000 iterations, random 128-bit salt) to derive a wrapping key. The vault key is wrapped by AES-GCM with vault-scoped additional authenticated data.
- Individual records and sync operation payloads are AES-GCM encrypted with new random 96-bit nonces and context-bound additional authenticated data.
- Plaintext is decrypted only after vault unlock; the IndexedDB record payloads and outbox payloads are ciphertext. IDs and a small amount of metadata remain visible locally for indexing/deduplication.
- Pairing bundles contain ciphertext and the relay credential encrypted under the vault key; the wrapped key still requires the passphrase. The bundle itself should nevertheless be treated as sensitive.

PBKDF2 is chosen for broad browser support in this foundation. A production review should benchmark mobile unlock time and evaluate a memory-hard KDF where supported, including UX and interoperability implications. Any KDF change needs a versioned envelope migration.

## Sync algorithm

1. Client connects to an HTTPS relay using the vault's separate bearer token.
2. Pull changes after the persisted relay cursor in ascending cursor order.
3. Authenticate and decrypt each change; validate schema and stable operation ID.
4. Apply only once. Persist the cursor after every successfully processed envelope; a crash replays safely.
5. Push local outbox entries and mark them sent only after relay acknowledgement.
6. Pull again to catch writes that raced with local uploads.
7. A vector clock resolves causal updates. Concurrent edits create encrypted conflicts and require user selection; no timestamp-only last-writer-wins policy is used.

The client intentionally does not advance the pull cursor merely because it uploaded an item. Relay cursors are a shared total order and advancing on push alone can skip another device's change.

## Domain-level safeguards

- Source text is retained in the same encrypted record so a user can inspect what led to an extracted title/date.
- Low-confidence records visibly request review.
- No medication dose is inferred or changed. An item reminder does not represent proof of completion/taking medication.
- Imported content is untrusted data. Model output is parsed and schema-validated; the model receives no unrestricted tools.
- Unsupported date ambiguity stays a review task; invalid dates are rejected.

## Explicit non-goals for this iteration

- Native Android/iOS/desktop application binaries and native OS alarm scheduling while the app is suspended or force-stopped. Browser reminders are best-effort only.
- Direct peer-to-peer LAN discovery/transport. The relay can be self-hosted on a LAN, but the client still communicates with the relay; direct P2P is not implemented.
- Scanned-PDF OCR and speech-to-text transcription. An opt-in browser WebGPU adapter for Gemma 4 E2B is present, but it is text-only and depends on compatible WebGPU hardware/browser plus a model download. The loopback Ollama-compatible adapter may accept images when its local model supports vision; that capability is model/runtime-dependent.
- End-user per-device key/token revocation, automatic relay history compaction, relay queue encryption at rest, a production-grade distributed rate limiter, key rotation UX and tested account recovery.
- A production operational service for global availability or population-scale infrastructure.

These are deliberate exclusions from the first code iteration, not features implied by the UI. See `THREAT_MODEL.md` and `ROADMAP.md`.
