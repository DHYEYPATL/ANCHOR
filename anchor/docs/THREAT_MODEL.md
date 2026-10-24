# Threat model and security review checklist

## Assets

Personal records and source text, dates/obligations, document metadata, the vault key, relay credential, device identities, plaintext exports and recovery/pairing bundles.

## Trust boundaries

1. **Capture boundary:** all user text/imported content is untrusted. The current PDF.js adapter extracts selectable text with file/page/text limits; scanned-PDF OCR and audio transcription are not implemented. PDF and media parsers remain attack surfaces and must be updated and tested like other dependencies.
2. **Model boundary:** local model output is probabilistic and untrusted. It must pass schema checks, bounds checks, date parsing, provenance checks and explicit user review.
3. **Storage boundary:** IndexedDB is not a secure enclave. The current client encrypts record payloads, but a compromised browser profile, XSS, malicious extension, unlocked OS user or compromised application can access plaintext after unlock.
4. **Network boundary:** only ciphertext payloads cross the relay API. The relay still sees vault ID, operation IDs, cursor, device ID on acknowledgements, payload size, timing, IP addresses and the shared relay bearer credential during HTTPS requests.
5. **Relay boundary:** relay host is not trusted with plaintext. Production hosting requires TLS termination, disk/volume protection, least privilege, patching, storage quotas and tested backup/deletion procedures.
6. **Export boundary:** readable JSON exports are plaintext. Pairing bundles are sensitive credentials even though the vault key remains passphrase-wrapped.

## Threats and mitigations present in the repository

- Unauthorized relay access: random high-entropy token, SHA-256 token hash at rest, constant-time comparison, authentication on read/write/ack/status.
- Payload tampering: WebCrypto AES-GCM authenticated decryption; malformed or unauthenticated changes are rejected.
- Replay/duplicate operations: stable change IDs and an idempotent relay unique constraint; local operations are deduplicated.
- Network loss/crash: local outbox remains until the server acknowledges; cursor persisted after each decrypted operation.
- Concurrent edit: vector clocks and encrypted conflict retention; UI requires a user to choose a version.
- Oversized payload: Pydantic field bounds, ciphertext-byte quota, an ASGI streamed request-body cap and declared Content-Length checks. Production reverse-proxy/server limits are still mandatory.
- CORS: exact origins configured through `ANCHOR_ALLOWED_ORIGINS`; CORS is not treated as authentication.
- Relay data growth: per-vault ciphertext quota; this version fails closed rather than pruning unacknowledged changes. An optional operator-authenticated purge endpoint supports explicit deletion when configured.

## Known risks / not yet mitigated enough for production

- Bearer token is per vault, not per device. There is no user-facing per-device revocation yet. Anyone who steals the pairing bundle or token can read/append encrypted envelopes and can disrupt sync. The vault data key is separate, so token access alone does not decrypt the payload.
- Relay stores ciphertext in SQLite without application-layer disk encryption; disk/backup access reveals ciphertext and metadata. Encrypted backup JSON likewise leaves IDs, timestamps, counts, and envelope metadata visible.
- No automatic retention or compaction; a vault can hit its configured quota. Operator purge exists but must be enabled with a secret and has not been hardened through an operational security review.
- The per-process rate limiter is not globally consistent across multiple workers and SQLite writes serialize under load.
- The app-level ASGI body cap bounds chunked requests, but an ASGI app cannot by itself prevent all slow-client/resource-exhaustion scenarios. Production proxy/server request-timeout, concurrent-connection and body limits are required.
- PBKDF2 can be slow on low-end devices and is not memory-hard.
- Unlock keeps a non-extractable CryptoKey reference in JavaScript state, but malicious same-origin script can still invoke crypto while unlocked; a strict CSP, dependency audit, XSS review and minimal third-party code are required.
- App currently imports no remote font or analytics dependency. Keep it that way or explicitly assess the privacy boundary for any new dependency.
- Browser notifications are not reliable native alarms and do not guarantee delivery when the app is closed or suspended.
- Pairing bundle has no separate user-encrypted export password beyond the wrapped vault key's passphrase.
- Sync has not been independently penetration-tested, fuzzed at scale, or reviewed by a cryptography expert.

## Minimum pre-production checklist

- [ ] Independent cryptographic and application security review.
- [ ] Move to per-device credentials, invitation tokens with expiry, device revocation and vault-key rotation.
- [ ] Strict CSP and production headers; dependency lockfile and vulnerability monitoring.
- [ ] Proxy-level request/body limits, distributed rate limits, abuse controls and quotas.
- [ ] Backups, restoration drills, operator-authenticated deletion and documented retention.
- [ ] Fuzz parsers and API schemas; property-test vector-clock merge; chaos test crashes/network faults.
- [ ] Test multiple browser engines/devices, tab concurrency, storage pressure and browser data deletion.
- [ ] Native platform notification schedule + reboot/time-zone changes if high-reliability alarms are a product claim.
- [ ] Verify zero personal payload egress in local-only mode with network instrumentation.
- [ ] Privacy/legal review for each launch region; avoid health/safety guarantees without domain review.
