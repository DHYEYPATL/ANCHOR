# Roadmap from current code to a reliable real-world product

## Current iteration (implemented)
- Responsive installable PWA on phone/laptop browsers.
- Local vault setup/unlock using passphrase-wrapped AES-GCM key.
- Encrypted IndexedDB record snapshots and encrypted local sync outbox.
- Typed task/event/promise/note/consumable/document records with source-text provenance.
- Local deterministic date/type extraction with review-before-save.
- Optional loopback-only Ollama-compatible local Gemma adapter, with bounded model response reading and schema checks.
- Optional on-device browser WebGPU LiteRT-LM Gemma 4 E2B web text adapter; model weights are downloaded only on opt-in and may not fit average phones.
- Local selectable-text PDF extraction, plus on-device OCR for scanned PDFs (via Canvas rendering) and image attachments using local Shape Detection.
- Real-time on-device speech-to-text transcription during voice recording with live text streaming and automatic memory extraction.
- Encrypted attachment chunks and validated encrypted backup export/import with a 64 MiB memory cap and relay requeue on restore.
- Direct offline peer-to-peer (P2P) synchronization bundle export/import for device-to-device sync over local Wi-Fi, AirDrop, or local file transfer without a relay server.
- Local search, Today dashboard, open loops, basic inventory, editing and deletion tombstones.
- FastAPI relay with hashed bearer token, envelope-size validation, quota, cursor pull, deduplication and ack.
- Client cursor persistence, encrypted change envelopes and vector-clock conflict prompts.
- Durable reminder notifications with synthesized Web Audio chimes, overdue/missed reminder alert banners, and snooze actions.

## Next release blockers
1. Separate native Android client in Kotlin/Compose with a shared protocol test suite, SQLCipher/OS-backed key protection, durable WorkManager sync and exact LiteRT-LM Gemma 4 model loading integration.
2. Desktop Tauri shell and OS notification/secure key-storage adapter; avoid making the browser the only execution environment.
3. Media ingestion improvements: OCR for scanned PDFs, robust image understanding and voice transcription using verified local runtimes; current attachment store is encrypted/chunked, PDF support is selectable-text only, and browser LiteRT-LM is text-only.
4. Direct LAN discovery/transport and fallback policy. The current client uses the relay only.
5. Per-device credentials and short-lived, one-time invitation pairing; device list, revocation, rotation, recovery and a clear compromise story.
6. Proper E2EE protocol design review, protocol domain separation/versioning, key-rotation migration, security test suite and external cryptographic review.
7. Relay operational features: retention and purge policy, bounded queues with device acknowledgements, authenticated operator controls, distributed rate limits, abuse controls and load-tested storage.
8. Durable reminder scheduler on each native platform, reboot re-registration, time-zone changes, recurrence semantics, missed reminder UI and reminder-delivery diagnostics.
9. Harden backup/restore: large streaming archive format, tested key-recovery workflow, import/export versioning and migration rollback. Current JSON backups are integrity-validated but limited to 64 MiB and still require the original vault passphrase.
10. Accessibility/localization, larger low-end device benchmark matrix, usage/battery profiling, app-store policies and privacy/legal review.

## Acceptance principles
- A confirmed local write must survive page reload and application restart, unless the user/browser explicitly clears site storage.
- A relay outage must not block local capture/search/edit.
- A sent operation may be replayed; it must not apply twice.
- An invalid authentication tag must never be applied.
- Concurrent edits to the same record must not be silently overwritten.
- A stale or revoked device must not silently regain access.
- Model unavailability must never block a manually confirmed record from being stored.
- Every data movement path must be documented and tested; no analytics or cloud inference by default.
