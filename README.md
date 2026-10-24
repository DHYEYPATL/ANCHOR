# Anchor — Local-First Personal Memory & Action Layer

Anchor is a private, local-first personal memory system designed to turn messy everyday inputs—voice notes, scanned circulars, medication photos, schedules, and promises—into verified, deterministic, structured life records.

Everything is stored and encrypted locally on user devices before any optional synchronization across trusted devices over direct peer-to-peer Wi-Fi or an encrypted opaque-relay.

---

## 📋 Implementation Gap Audit

A comprehensive codebase audit and implementation status register is documented in:
👉 **[`ANCHOR_IMPLEMENTATION_GAP_AUDIT.md`](./ANCHOR_IMPLEMENTATION_GAP_AUDIT.md)**

All domain-specific workflows and actionable capabilities from the audit have been implemented and verified:
- **🎙 Native Speech-to-Text**: Real-time browser Web Speech API live transcription directly in capture.
- **📄 On-Device Scanned-PDF & Image OCR**: Browser Shape Detection (`TextDetector`) and Canvas extraction without server calls.
- **💊 Medication & Inventory Depletion Engine**: Calculates stock run-out dates, reorder warning thresholds, and manages dose history with 7-day adherence percentages.
- **🩺 Doctor-Visit Pre-Consultation Brief**: Generates Markdown briefs with active regimens, 7-day adherence rates, and health questions.
- **🪞 Weekly Life Mirror**: 7-day retrospective summarizing accomplishments, open loops, and upcoming radar.
- **📑 Multi-Record Circular Extraction**: Parses timetables and circular schedules into batch-confirmed items.
- **⏰ Multi-Stage Reminders & Recurrence**: 1w, 1d, 1h, and lead buffer reminder stages with synthesized Web Audio API chimes and leap-year/month-end recurrence math.
- **⚡ Local Intent Q&A Engine**: Grounded answers for *"What should I do next?"*, *"What is due?"*, *"What am I low on?"*, and *"What did I promise?"*.
- **🌐 Direct P2P Offline Sync**: Encrypted `.anchor-sync.json` bundles for offline transfer via Wi-Fi/AirDrop/USB.
- **📥 Data Portability**: Full JSON backup, RFC 4180 CSV export, and RFC 5545 iCalendar (`.ics`) export.
- **🔒 Zero-Cloud Privacy & Unlock Throttling**: Exponential backoff lockout delays, 15-minute inactivity auto-lock, and browser persistent storage request.
- **🧪 20-Item Evaluation Benchmark**: Labelled benchmark dataset with automated accuracy and prompt injection defense tests.

---

## 🚀 Quick Start

### Run Everything (Web + Relay)
```bash
# Windows
run-all.bat

# PowerShell
.\run-all.ps1
```

### Run Web App Only
```bash
# Windows
run-web.bat
```
Visit `http://localhost:5173` in any modern web browser.

### Run Tests & Verification
```bash
# Windows
test-all.bat

# PowerShell
.\test-all.ps1
```
- **Relay backend suite:** 11 passed (100% green via `pytest`).
- **Web frontend suite:** 79 passed across 21 test suites (100% green via `vitest`).
- **Production build:** Clean compilation with `tsc -b && vite build`.

---

## 📂 Repository Structure

```text
anchor-project/
├── ANCHOR_IMPLEMENTATION_GAP_AUDIT.md  # Detailed feature gap audit & implementation register
├── README.md                           # Main repository overview and quick start
├── run-all.bat / run-all.ps1           # Start both Relay service and Web frontend
├── test-all.bat / test-all.ps1         # Run all backend & frontend tests + production build
├── anchor/
│   ├── apps/web/                       # React + TypeScript responsive installable PWA
│   │   ├── src/domain/                 # Inventory math, medication, validation, subscription
│   │   ├── src/application/            # Reminders, OCR, speech, digest, Q&A, Gemma adapters
│   │   └── src/infrastructure/         # WebCrypto, IndexedDB, vault, sync, p2p, ical, csv
│   ├── services/relay/                 # FastAPI opaque ciphertext sync relay backed by SQLite
│   ├── docs/                           # Architecture, threat model, operations and roadmap
│   ├── infra/                          # Starter Docker Compose deployment
│   └── .github/workflows/              # Continuous integration pipeline
```

---

## 🔐 Security & Privacy Invariants

1. **Zero Cloud AI Dependency**: Default extraction runs 100% on-device using local rule extractors or optional loopback Gemma models. Zero cloud tokens billed.
2. **Encrypted at Rest**: All records and attachments use WebCrypto AES-256-GCM wrapped by PBKDF2-HMAC-SHA-256.
3. **Encrypted in Transit**: Relays only receive and store opaque ciphertext envelopes with no access to vault keys or plaintext.
4. **Local Autonomy**: Full functionality works without internet or network connections.
