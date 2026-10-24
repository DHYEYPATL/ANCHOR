# Anchor — local-first personal memory & action layer

> **Working codebase and production-oriented foundation, not a security-audited release.** This repository contains a responsive installable web app and an encrypted sync-relay service. It does not include native Android/iOS or desktop binaries, and this should not be described as production-ready for high-risk or billion-user deployment until the release gates in `docs/ROADMAP.md` are completed.

Anchor helps turn everyday obligations into structured, source-backed records. Capture a thought, a screenshot, a PDF, a bill, a promise or an inventory item; review the proposed interpretation; save it into a local encrypted vault; find it later; and optionally synchronize encrypted changes across trusted devices.

## Product invariants

1. **Local first.** Capturing, editing, searching and viewing saved records do not require a relay or model service. Relay outages must never block local work.
2. **Typed data is the source of truth.** Model output is a suggestion. Deterministic validation, domain rules and user confirmation own the final record and date.
3. **Evidence stays attached to memory.** Captures preserve source text and optional encrypted attachments. The app must not claim to know something if it cannot find it in saved records.
4. **Encrypt before sync.** Record snapshots, change operations and attachment chunks are AES-GCM encrypted in the client before transfer. The relay stores opaque ciphertext and a hash of the vault bearer token; it never receives the vault key or passphrase.
5. **No cloud AI API.** The default rule-based extraction runs locally. Optional Gemma 4 inference uses either an on-device browser WebGPU runtime (first-use model weights are downloaded from the configured model host) or a loopback-only Ollama-compatible runtime. Capture text is not sent to a hosted inference API. The WebGPU runtime's model download does make an outbound network request and reveals ordinary connection metadata.
6. **Reminders are honest.** The current web app shows due items and can issue best-effort browser notifications while it is running. It does not promise exact-time alarm delivery while suspended or closed; native WorkManager/OS scheduler adapters remain a separate requirement.
7. **Conflict beats silent overwrite.** Version vectors resolve causally ordered changes; concurrent or divergent same-clock versions are encrypted and shown for manual review.
8. **Recovery is a first-class workflow.** Settings provide an encrypted backup of the local encrypted stores, pairing-file export and a plaintext record export. Encrypted backup import only runs into an empty browser profile, requeues prior operations for relay recovery, and still requires the original passphrase. Current in-memory JSON backup import/export is capped at 64 MiB.

## Repository layout

```text
anchor/
├── apps/web/                 # React + TypeScript responsive installable PWA
│   ├── src/domain/           # Typed records and strict domain validation
│   ├── src/application/      # Deterministic extractor, local Gemma adapters, PDF text extraction
│   ├── src/infrastructure/   # WebCrypto, IndexedDB, vault, backups, attachments, sync client
│   └── public/               # PWA manifest, app shell and service worker
├── services/relay/           # FastAPI opaque ciphertext relay backed by SQLite
│   ├── anchor_relay/app.py   # Authentication, body limits, quota, cursors, idempotency
│   └── tests/                # Relay access, size, headers, acknowledgement and replay tests
├── docs/                     # Architecture, threat model, operations and rollout roadmap
├── infra/                    # Hardened starter Compose deployment
└── .github/workflows/        # CI checks
```

## Run locally

Requirements: Node.js 20+ (Node 22 recommended), Python 3.11+ (Python 3.12 recommended), and a modern browser with WebCrypto and IndexedDB.

### 1. Start the relay (optional)

```bash
cd services/relay
python -m venv .venv
# Windows PowerShell: .venv\\Scripts\\Activate.ps1
# macOS/Linux: source .venv/bin/activate
python -m pip install -r requirements.txt
# Windows PowerShell:
$env:ANCHOR_RELAY_DB = "./data/relay.sqlite3"
$env:ANCHOR_ALLOWED_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"
# macOS/Linux:
# export ANCHOR_RELAY_DB=./data/relay.sqlite3
# export ANCHOR_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
uvicorn anchor_relay.app:app --host 127.0.0.1 --port 8080
```

Check `http://localhost:8080/healthz` and `/readyz`. Local-only usage does not require a relay.

### 2. Start the web app

```bash
cd apps/web
npm install
npm run dev
```

Open `http://localhost:5173`, create a vault using a strong passphrase, and capture a record. The local browser profile must not be cleared unless you have verified a backup.

### 3. Run checks

```bash
cd apps/web
npm test
npm run build

cd ../../services/relay
PYTHONPATH=. python -m pytest -q
```

### Optional container deployment

From the repository root, configure `ANCHOR_ALLOWED_ORIGINS` and other values from `.env.example`, then run `docker compose -f infra/compose.yaml up --build -d`. The compose port is bound to loopback intentionally; publish it only behind a trusted HTTPS reverse proxy after applying the operations checklist.

## Pair another device and sync

1. Serve the web app over HTTPS on non-localhost deployments; browser WebCrypto and secure storage expectations require a secure origin.
2. Make a relay reachable by both devices. Use HTTPS on the public internet. A self-hosted relay can run on a trusted LAN, but browsers can block secure pages from calling plaintext HTTP on a private address; configure a trusted HTTPS endpoint for that case.
3. Configure the relay under Settings → Encrypted device sync and run a sync once on the first device.
4. Export the pairing file, transfer it privately, import it on the other device and unlock with the same passphrase.
5. Run sync on the second device. Changes remain in the local encrypted outbox when offline and retry later.

**Current transport scope:** the client currently uses the relay transport for all sync. A relay hosted on the same LAN can avoid sending records over the internet, but **direct peer-to-peer Wi-Fi/hotspot discovery and transfer is not implemented**. Cross-network sync uses the relay. The relay sees vault IDs, cursors, change IDs, payload sizes, timings and client IP metadata. The shared vault bearer credential is not a per-device identity: stolen credentials can disrupt or read the opaque stream, although they do not reveal the AES-GCM vault key.

## Capture and model scope

- **Rule-based capture:** always available offline. It recognizes a small set of date phrases and record types; it is intentionally not presented as human-level understanding.
- **PDF:** selectable text is extracted locally with page and text limits. Scanned image-only PDFs are stored as encrypted attachments but are not OCR'd by this build.
- **Images and audio:** media can be stored as encrypted attachments. Optional loopback Ollama-compatible models may accept resized image input if the installed model supports vision. There is no speech-to-text pipeline yet; recording stores audio only.
- **Gemma 4 WebGPU:** optional and opt-in. It loads the selected LiteRT-LM E2B web model weights from Hugging Face on first use. It is text-only in this build, needs WebGPU support and substantial memory/storage, and may not work on average phones.
- **Local Ollama-compatible model:** only loopback endpoints such as `http://localhost:11434` are accepted. Verify the local model name, runtime, CORS and its supported input modalities.

The optional adapters do not use paid tokens, but hardware, bandwidth for weight downloads, storage and self-hosted relay operation still consume resources. The repository does not bundle model weights.

## Security and production boundaries

- WebCrypto AES-256-GCM encrypts records, sync operations and attachment chunks with random 96-bit nonces and context-bound AAD. PBKDF2-HMAC-SHA-256 at 600,000 iterations wraps the random vault key. This is a reviewed standard primitive used in an implementation that still needs independent cryptographic review.
- The relay enforces request body/payload bounds, an SQLite-backed quota, bearer authentication, response headers, limited per-process rate limiting and exact-origin CORS. Multi-worker/global deployments need shared rate limiting and an operational deployment review.
- The relay stores ciphertext in SQLite without application-layer disk encryption. Protect disks and backups with infrastructure-level controls.
- Encrypted backups keep record/attachment payloads encrypted, but IDs, timestamps, counts, wrapped-key metadata and other envelope metadata are visible. JSON backup import/export has a 64 MiB in-memory cap and is not a streaming archival format.
- This is a PWA, not native Kotlin/Compose or Tauri. Web push/alarm scheduling and browser notifications can be delayed or lost when the browser/OS suspends the app. The UI states this limitation.
- The current relay uses a shared vault credential, not revocable per-device keys. A compromised authorized device can attack its own local plaintext or submit malformed authenticated data. Per-device credentials, revocation, rotation, stronger abuse controls and independent security testing are pre-production requirements.
- No architecture can protect plaintext on a compromised unlocked device, or remotely erase copies already downloaded by another device.
- Do not use this build as a clinical medication manager, emergency alerting system or regulated records system. It does not confirm medication administration, diagnose, change treatment, or guarantee alarms.
- The project does not claim GDPR, India's DPDP Act, HIPAA or other legal compliance. Obtain jurisdiction-specific legal/privacy/security review before a commercial launch.

See `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`, `docs/OPERATIONS.md`, `docs/ROADMAP.md`, `docs/TEST_RESULTS.md` and `SECURITY.md` for implementation constraints and the exact validation status.

## License

Application code is under Apache-2.0; see `LICENSE`. Model weights have separate licenses and terms—review the exact Gemma model card before downloading or redistributing weights.
