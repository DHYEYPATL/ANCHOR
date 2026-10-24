# Validation record for this source snapshot

This record documents checks actually run in the authoring environment. It is not a production certification and must be refreshed by CI on every change.

## Passed checks

- Relay API tests: **11 passed** using `PYTHONPATH=services/relay python -m pytest -q services/relay/tests`.
- Python syntax/bytecode compilation: `PYTHONPATH=services/relay python -m compileall -q services/relay/anchor_relay`.
- Strict TypeScript check of the domain/infrastructure core (`backup`, `relayUrl`, domain validation, repository, vault, attachments, sync, and local Gemma adapter) using the globally available TypeScript compiler.
- TypeScript/TSX parser pass over **25 source/test files**, with zero parser syntax errors.
- Runtime smoke checks using Node's TypeScript transpilation for relay URL restrictions (including private-IPv6 hostname spoofing regression cases), loopback-only model endpoint policy, deterministic extraction, and encrypted-backup structural/date validation.

## Not verified in this environment

- `npm install` could not complete because the configured npm registry connection timed out. Consequently, `npm test` (Vitest) and `npm run build` (full React/TypeScript/Vite build) were **not run successfully** here.
- No real-browser end-to-end tests, Android/iOS native builds, laptop/phone hardware benchmarks, WebGPU model download/inference test, relay load test, penetration test, cryptographic review, or backup-restoration drill were performed.

## Re-run before use

```bash
cd apps/web
npm install
npm test
npm run build

cd ../../services/relay
python -m pip install -r requirements.txt
PYTHONPATH=. python -m pytest -q
```

Fix any failures under the current Node/Python/browser versions; do not suppress them to obtain a green check.
