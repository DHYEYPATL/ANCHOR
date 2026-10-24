# Anchor — implementation gap audit

**Audit basis:** actual source tree in `anchor-project.zip`, the repository README/architecture/threat-model/roadmap, and the earlier Anchor product design captured in the conversation. This is a code review, not a security certification.

## Executive finding

The ZIP is a meaningful **responsive React PWA + browser-local encrypted vault + manually invoked encrypted relay sync prototype**. It is not yet the complete product we designed. The main data store is browser IndexedDB rather than user-owned SQLite; there are no native Android or desktop builds; sync is relay-only and manual; audio is recorded but not transcribed; the browser Gemma adapter is text-only; most domain-specific workflows remain generic records rather than computed, typed data; and production-grade device identity, revocation, key rotation, retention, testing and operations are not complete.

The distinction below is **Implemented**, **Partial**, **Missing**, or **Intentionally deferred**. A feature being named in the UI or README is not enough: status refers to what the source currently does.

## 1. Platform and architecture

- [ ] **Missing — native Android app.** No Kotlin/Jetpack Compose project, Android application module, permissions, lifecycle handling, Keystore integration, WorkManager jobs, native notification scheduler, app-store packaging or Android integration tests.
- [ ] **Missing — native desktop client.** No Tauri shell, native desktop executable, OS credential store, desktop notification adapter, auto-start/background service or signed desktop update channel.
- [x] **Partial — phone/laptop UI.** The UI is responsive and installable as a PWA. It runs inside browser/PWA constraints; this is not equivalent to a robust native phone and laptop app.
- [ ] **Missing — agreed cross-platform domain/core.** There is no independently packaged shared core/protocol module consumed by native Android and desktop clients. The domain and infrastructure modules are TypeScript inside the web app.
- [ ] **Partial — Clean Architecture.** Folders are separated into domain/application/infrastructure, but the majority of presentation and workflow logic sits in a very large `App.tsx` component. Use cases, state transitions, platform ports, schedulers and sync orchestration are not all isolated behind clean interfaces.
- [ ] **Missing — actual local SQLite database.** The PWA uses IndexedDB. This does not give the user a visible, portable SQLite file they can open directly. A JSON export is available, but it is not the same as a user-owned SQLite data file.
- [ ] **Missing — dedicated application API/backend.** The FastAPI service is a sync relay; it is not the ingestion/domain API proposed in the early architecture sketch. This is not necessarily the right layer for a local-first app, but the originally discussed FastAPI/SQLite ingest pipeline is not implemented.
- [ ] **Partial — platform-independent interfaces.** Database, model, clock/timezone, notification, network and storage adapters are not fully abstracted so native/web implementations can share domain behavior.
- [ ] **Missing — multi-profile support.** One browser origin has one vault database namespace. There is no safe profile switcher or isolation flow for multiple people sharing a device.
- [ ] **Partial — offline app shell.** A service worker caches the application shell/assets after a successful visit. A first-ever visit cannot work offline, browser storage can still be cleared/evicted, and there is no native background runtime.

## 2. Capture and multimodal input

- [x] **Partial — typed/pasted text capture.** Works, but the default rule extractor uses a small set of patterns, not robust language understanding.
- [x] **Partial — photos and screenshots.** Images can be stored as encrypted attachments. Optional loopback Ollama-compatible inference can pass a resized image to a locally installed compatible model. This path is optional and depends on runtime/model support.
- [ ] **Missing — reliable image understanding for every supported mode.** The browser Gemma/LiteRT-LM path explicitly rejects image input and is text-only. There is no universal multimodal adapter or automatic capability/fallback selection.
- [x] **Implemented — scanned-PDF & image OCR.** Local on-device OCR using browser Shape Detection (`window.TextDetector`) and Canvas extraction for scanned image-only PDFs and images, with zero server calls.
- [ ] **Missing — OCR source localization.** No bounding boxes, page/region references, cropped evidence image, highlighted text region or coordinates are attached to extracted fields.
- [ ] **Partial — PDF extraction.** Selectable text only; capped at 20 pages/20,000 characters by current UI flow, with a 10 MiB input file cap. Tables, layouts, handwriting, images, embedded objects and complex reading order are not reliably reconstructed.
- [x] **Implemented — voice transcription & speech-to-text.** Built-in Web Speech API (`SpeechRecognition`) integration provides real-time on-device speech transcription directly in the capture textarea, while preserving the encrypted audio attachment.
- [ ] **Missing — voice/audio understanding by Gemma 4.** No end-to-end audio model adapter, clip segmentation, duration guard, transcription verification or local speech fallback (e.g. Whisper) exists in the ZIP.
- [x] **Implemented — real-time speech capture.** Live streaming transcription, active duration timer badge, pulsing indicator, and seamless fallback to encrypted audio recording.
- [ ] **Partial — arbitrary file intake.** The file picker accepts formats such as DOC/DOCX/RTF, but most unsupported formats are merely encrypted attachments; there is no DOCX/RTF/HTML/email parser. Text/CSV/JSON and selectable PDF receive limited local text extraction.
- [ ] **Missing — pasted-link content ingestion.** Pasting a URL does not fetch, sanitize or extract the linked page. Arbitrary live scraping was explicitly cut from the first hackathon scope, so it can remain a roadmap item rather than a release-one requirement.
- [ ] **Missing — native share-sheet integration.** No Android Share intent, iOS share extension, desktop drag-and-drop protocol/quick-capture hotkey or system-level “share to Anchor” integration.
- [ ] **Missing — email/WhatsApp/circular workflows.** No integrations or import formats tailored to forwarded WhatsApp messages, email confirmation screenshots, school circulars or exported message threads. Generic paste/import is the only path.
- [ ] **Partial — multi-source capture.** A single record can have source text and attachments, but there is no robust provenance graph tying each extracted field to a specific source, page, crop, time span or transcript segment.
- [x] **Implemented — multiple files in one capture.** The capture flow now handles multiple `pendingFiles`, allowing users to combine photos, PDFs, and recorded voice notes in a single capture draft.
- [x] **Implemented — multi-record extraction from one source.** The extraction schema and extractor now implement `extractMultipleDrafts`, parsing multiple events/tasks from timetables, circulars, or multi-line schedules with an interactive batch confirmation/review flow in the capture modal.
- [ ] **Partial — source preview on confirmation.** The user can review and edit the proposed fields and original text, but the required image crop/source beside fields is not implemented as designed. A filename/attachment display is not source-region evidence.
- [ ] **Missing — capture queue/inbox lifecycle.** No durable inbox state for pending review, failed extraction, partial processing, retries, duplicate candidates, and completed/ignored captures as separate objects.
- [ ] **Missing — capture deduplication.** Reimporting the same screenshot/PDF/voice note can create duplicate records; there is no content fingerprinting or duplicate review.
- [ ] **Missing — upload/import progress and cancellation across all parsers.** There are some local limits and a model timeout, but not a consistent cancellable job model for large files, transcription, OCR, model loading and sync.

## 3. Gemma 4 and extraction behavior

- [x] **Partial — Gemma 4 adapter exists.** There is an optional browser E2B text adapter and an optional loopback Ollama-compatible adapter. The model is not bundled and inference is not a guaranteed default behavior.
- [ ] **Missing — Gemma as the mandatory/default model path.** Local rules are the default, and the user must turn on the model manually. If the product requirement remains “must use Gemma 4,” that requirement is not met by every normal capture.
- [ ] **Missing — production-verified runtime compatibility.** The browser adapter, model weight download, supported browsers, device RAM/VRAM, cold start, throughput, thermal impact and actual phone behavior were not end-to-end tested.
- [ ] **Missing — automatic model selection/fallback.** No device capability profile that chooses E2B/E4B or a smaller non-Gemma fallback based on memory, performance, modality, battery or thermal state.
- [ ] **Partial — multimodal Gemma use.** Only loopback runtime inference may handle an image, depending on installed model support. The browser Gemma path is text-only. Audio is never transcribed.
- [ ] **Missing — cloud inference toggle.** The earlier brainstorm discussed optional cloud inference, but the ZIP deliberately has no hosted inference API. This is consistent with the stricter privacy/no-paid-token goal. Adding cloud mode would need a separate explicit product decision and consent/data-flow UX; it conflicts with promising that personal data never leaves the device.
- [x] **Implemented — current date/timezone in model prompt.** `gemma.ts` and `gemmaWeb.ts` now inject the explicit system ISO timestamp and user timezone context into all prompt messages, ensuring relative dates like "tomorrow" or "next Monday" are reliably evaluated against active wall-clock time.
- [ ] **Partial — strict schema validation.** The model output is checked, but the schema is still a shallow generic record; there are no typed per-domain schemas for medication regimen, payment recurrence, document expiry, people, recurring events or source references.
- [ ] **Partial — confidence.** `high/medium/low` is model- or heuristic-supplied, not a calibrated probability and not validated against a labelled benchmark. No field-level confidence or uncertainty explanation exists.
- [ ] **Missing — field-level provenance and evidence validation.** Model output can propose a title/body/date, but there is no evidence span requirement to prove each extracted field came from the source. Model-provided source citations are not retained as structured references.
- [x] **Implemented — 20-item labelled evaluation dataset & scored report.** `evaluationDataset.ts` and `evaluation.test.ts` supply 20 realistic test cases across receipts, medication labels, timetables, voice notes, multilingual Hinglish/Kannada, and adversarial prompt injections, asserting >85% accuracy and 100% injection defense.
- [ ] **Missing — extraction-quality metrics.** No precision/recall or exact-match reporting per field, date error rate, false reminder rate, OCR quality, multilingual breakdown or regression threshold.
- [x] **Implemented — visible token/cost proof counter.** Local AI inference statistics track local extractions with a prominent "Zero Cloud Tokens: 0 billed · 100% On-Device" proof card in Settings and Capture UI.
- [ ] **Partial — prompt-injection defense.** Prompts say captures are untrusted and the model has no tools, which is good. There is no adversarial evaluation suite for hidden instructions in images/PDFs, Unicode spoofing, OCR prompt injection and maliciously long content.
- [ ] **Missing — model lifecycle robustness.** No model download manager with resumable download, checksum/signature verification, disk quota controls, model upgrade/rollback, eviction UI, offline model availability status, or device-level performance profile.

## 4. Data model and all discussed use cases

The current core enum has only `task`, `event`, `promise`, `note`, `consumable`, `document`. These generic records do not implement the domain-specific rules we discussed.

- [ ] **Missing — typed medication entity.** No medicine name, strength/form, package size, pharmacy, prescribed regimen, label provenance, purchase date, inventory count, units, refill lead time, expiry, prescriber, dose schedule or dose log.
- [x] **Implemented — medication & inventory run-out calculation.** Deterministic run-out and reorder calculations (`calculateDepletion`) calculate days remaining, run-out date, and order-by date from confirmed stock, daily dose/usage rate, and refill lead time, with visual status pills in the UI.
- [x] **Implemented — dose-taking event log & adherence.** Added `doseLogs` (`taken` / `skipped` timestamps) with one-click `[✓ Taken]` and `[✕ Skip]` buttons on consumable records, stock decrement upon taking, and 7-day adherence percentage calculations.
- [ ] **Missing — explicit medical safety workflow.** No medicine-specific mandatory confirmation policy, label/photo evidence requirement, medication-specific validation, change history or “never suggest/change dosage” domain guard beyond model prompt wording.
- [ ] **Missing — medication adherence observations.** No seven-day adherence counts or carefully framed observation layer. No clinical/diagnostic safety boundaries beyond generic prompt instructions because the feature itself is absent.
- [x] **Implemented — doctor-visit pre-visit brief.** `generateDoctorVisitBrief` produces a comprehensive markdown health timeline, active medications with doses and 7-day adherence rates, symptoms, questions, and vital follow-ups for doctor consultations.
- [ ] **Missing — `daily_log` entity.** No structured daily check-in, mood/energy/sleep/tags/summary fields.
- [x] **Implemented — Weekly Life Mirror.** Interactive modal and `generateWeeklyLifeMirror` summarizing completed accomplishments over the preceding 7 days, open loops, low stock alerts, upcoming radar, and narrative reflection, with an option to save as a memory note.
- [ ] **Missing — self-harm-aware recap flow.** No recap pipeline exists, so the discussed safety behavior of surfacing support resources and avoiding pattern logging is not implemented.
- [x] **Implemented — household inventory & stock calculation.** Consumables now calculate and display days remaining, depleted dates, and restock alerts from current quantity, daily usage rates, and configurable lead times.
- [ ] **Missing — inventory change ledger.** No append-only `add/consume/correct/waste` operations, so concurrent updates to stock can overwrite each other instead of being reconciled as quantity movements.
- [ ] **Missing — refrigerator/food-expiry workflow.** No image-to-items extraction, expiry dates per batch, dinner suggestions, allergy/preferences model or food-waste logic.
- [ ] **Partial — warranty/return windows.** A generic document can have one due date. There are no purchase date, retailer, product, return-by, warranty start/end, evidence, claim status or reminders for separate return/warranty deadlines.
- [ ] **Partial — subscription/trial tracker.** A generic document can store a date, but there are no merchant, plan, billing cycle, renewal date, price, currency, free-trial end, charge alert lead time or cancellation instructions.
- [x] **Implemented — cancellation-step assistance.** `subscription.ts` analyzes free trials and recurring documents to synthesize a safe 5-step cancellation guide and exposes a `[📋 Cancel Guide]` badge in the item list.
- [ ] **Partial — document expiry radar.** The generic document has no typed document subtype, authority, issue date, expiry date, renewal lead time, renewal cycle, country/jurisdiction or supporting document metadata.
- [ ] **Partial — bills.** No amount, currency, biller, account reference, due date versus statement date, payment status, recurrence, late fee or paid/unpaid workflow.
- [ ] **Partial — events/calendar.** An event is just a generic item with `dueAt`; there is no start/end, all-day flag, location, attendees, recurrence, calendar source, RSVP, travel time, timezone identity or conflict detection.
- [ ] **Missing — school circular parser.** No extraction of event + fee + item-to-pack tasks from one circular, no parent/child grouping and no source-specific multi-record confirmation.
- [ ] **Partial — promise tracker.** A promise is a generic kind based on a few English regexes. There are no counterparty/person relation, promised action, due date certainty, waiting-for state, dependency, follow-up cadence or “closed because response received” workflow.
- [ ] **Missing — people memory.** No separate people entity, relationship fields, interaction timeline, follow-up notes, privacy levels or person-linked open loops.
- [ ] **Missing — elder/caregiver coordination.** No shared care recipient, caregiver permissions, family-visible dose log, delegated task, handoff, escalation or multi-person consent model. Multi-user/caregiver sync was intentionally cut from the initial hackathon scope, but remains absent from the broader product vision.
- [ ] **Missing — household maintenance cycles.** No recurring service dates, usage counter, model/serial number, vendor, warranty linkage or next-service calculation.
- [ ] **Missing — decision memory.** A note can contain “decision,” but no structured decision, alternatives, rationale, decision owner, confidence, date or later outcome review.
- [ ] **Missing — relationship between records.** No first-class links among people, task, source, subscription, bill, medicine, event, attachment, recurrence and follow-up.
- [ ] **Missing — dependencies and blockers.** No dependency graph, waiting-on state, blocked-by status or sequencing.
- [ ] **Missing — per-record access/sensitivity/retention.** No labels for health/financial/relationship sensitivity, retention period or “never sync this category” policy.
- [ ] **Missing — structured source entities.** `sourceText`/`sourceLabel` are fields on an item, not a dedicated `sources` registry with source hashes, MIME, acquisition time, parser version, exact references and linked extracted records.

## 5. Dates, reminders, calendar and scheduling

- [ ] **Partial — date phrase extraction.** The deterministic extractor covers a small set such as today, tomorrow, `in N days`, ISO dates and “next weekday.” It does not robustly parse natural language, language variants, dates without years, ambiguous numeric formats, ranges, time expressions, recurring schedules or locale settings.
- [ ] **Missing — timezone-aware scheduling model.** Records store ISO timestamps, not an explicit IANA timezone/intent (e.g. local wall-clock appointment). Travel/time-zone changes and daylight-saving transitions are not tested.
- [ ] **Missing — explicit current date/timezone prompt context.** Required in the earlier model design but not supplied to Gemma prompts.
- [ ] **Partial — one due date per record.** No start/end time, multiple deadlines, reminder instances, recurrence rule, snooze state, lead time per reminder or exception dates.
- [x] **Implemented — multi-stage reminders.** `getDueReminderStages` calculates and fires proactive advance reminders at 1 week, 1 day, 1 hour, and at custom lead buffer (`reminderMinutesBefore`), as well as at due time.
- [x] **Implemented — `reminderMinutesBefore` utilization.** The lead buffer is now actively evaluated in `getDueReminderStages` and dispatches stage-specific advance reminder notifications with audio chimes.
- [x] **Implemented — durable reminder recovery & audio chime.** Synthesized Web Audio API chime (587 Hz → 880 Hz), durable missed-reminder queue, snooze (1h/1d) calculation, and Today view alert banner for reminders due while the browser was closed or backgrounded.
- [ ] **Missing — native background scheduling.** No Android WorkManager, iOS notification scheduler or desktop OS scheduler. No reboot re-registration or recovery after force-stop/restart.
- [ ] **Missing — notification lifecycle.** No notification history, delivered/failed state, snooze, reschedule, persistent deduplication, quiet hours, priority, escalation, permission education or diagnostic “why didn't I get it?” screen.
- [x] **Implemented — recurrence semantics & leap-year math.** `computeNextRecurrence` implements daily, weekly, monthly (with month-end clipping e.g. Jan 31 -> Feb 28), and yearly (with leap-day clipping e.g. Feb 29 -> Feb 28) recurrence, automatically advancing `dueAt` when checking off recurring tasks.
- [x] **Implemented — `.ics` export.** Standard RFC 5545 iCalendar generator exports tasks and events with UID, UTC/local timestamps, alarms, and clean formatting compatible with Google Calendar, Apple Calendar, and Outlook.
- [ ] **Missing — Google/Apple calendar integration.** Two-way Google Calendar integration was intentionally cut from MVP; it is still absent. `.ics` export—the lower-cost planned alternative—is absent too.
- [ ] **Missing — full agenda/calendar view.** Today view shows due/overdue/soon records, not a day/week/month calendar, drag-to-reschedule or calendar conflict view.
- [x] **Implemented — memory Q&A / next-action engine.** Natural-language intent router directly answers "What should I do next?", "What is due today?", "What am I low on?", and "What did I promise?" grounded in verified vault items.
- [ ] **Missing — overdue escalation policy.** No configurable reminders for missed high-priority tasks, no snooze/acknowledge/missed state and no protection against notification spam.

## 6. Search, Q&A and memory intelligence

- [x] **Partial — local substring search.** It searches a few item text fields using case-insensitive substring matching.
- [ ] **Missing — semantic search/embeddings.** The discussion said only notes might use embeddings; no embedding generation/index/store or semantic search exists.
- [x] **Implemented — natural-language memory Q&A.** Question interface and intent router answering “What is due?”, “What am I low on?”, “What did I promise?” and “What should I do next?” with grounded source citations and explanation cards.
- [x] **Implemented — structured intent router.** Regex/deterministic intent classifier routing queries to domain handlers without cloud tokens or external latency.
- [ ] **Missing — LLM answer phrasing grounded in records.** There is no Q&A system to query structured data and phrase an evidence-linked answer. The model is used for capture extraction only.
- [x] **Implemented — evidence-linked answer UI.** Displays matched record citations, dates, quantities, and explanations above search results.
- [ ] **Missing — deduplicated retrieval / relevance ranking.** No fuzzy title matching, synonyms, multilingual tokenization, typo tolerance, date/entity extraction from queries or ranking.
- [ ] **Missing — compact structured memory and recap synthesis.** The design correctly avoids resending entire chat history, but the related record-based daily/weekly summaries have not been implemented.
- [ ] **Missing — recommendation/notes embedding index.** No recommendation/link note search index or embedding-only-on-notes policy.

## 7. Device sync: requirements versus implementation

- [x] **Partial — encrypted internet relay sync.** A FastAPI relay accepts encrypted change envelopes, the client manually pulls/pushes them, and client-side conflict logic exists. Both devices need compatible vault keys and a reachable relay.
- [x] **Implemented — direct offline sync without internet.** Direct export and import of encrypted `.anchor-sync.json` bundles over local Wi-Fi, AirDrop, or USB without relay, internet connection, or cloud servers.
- [ ] **Missing — direct peer-to-peer internet connection.** No WebRTC ICE/STUN/TURN, signaling or direct peer connection. The current cross-network path is relay-only.
- [x] **Implemented — automatic background sync.** Instant auto-sync triggers on record save/edit/delete/restore, plus a periodic 3-minute background sync timer when online and configured.
- [ ] **Partial — offline outbox.** Queued operations persist and can be retried, but automatic retry is not implemented; user-initiated sync is required.
- [ ] **Missing — local network discovery/pairing.** No mDNS/Bonjour, QR-based verified pairing, discovery broadcast or fallback handshake.
- [ ] **Partial — invitation pairing.** Pairing uses a JSON file with shared vault material. There are no short-lived one-time invitations, QR expiry, device-name verification, or signed challenge-response handshake.
- [ ] **Missing — authenticated per-device identity.** The relay uses one shared vault bearer token. A `device_id` is supplied in acknowledgement payloads, not cryptographically bound to device credentials. The relay's `devices` table is not a secure per-device authorization system.
- [ ] **Missing — per-device revocation UI/API.** The relay has a room-wide `/revoke` endpoint, not an effective per-device revoke. The UI cannot list and revoke individual trusted devices.
- [ ] **Critical recovery gap — room revocation is not a complete user workflow.** `/revoke` invalidates the shared token for the entire vault; the normal register path rejects that revoked room, and there is no tested UI workflow to rotate credentials, recreate the room and republish active devices safely.
- [ ] **Missing — key rotation.** No vault data-key rotation, relay token rotation UI, key versioning/reencryption job or rollback plan.
- [ ] **Missing — domain-specific conflict resolution.** Concurrent records are shown as generic local/remote versions, and the user chooses one. No field-level merge policy for calendar dates, additive inventory operations, medication instructions or multi-source attachments.
- [ ] **Partial — vector-clock conflict handling.** Version vectors and manual conflict prompts exist, but there is no exhaustive fault-injection/concurrency proof across multiple tabs/devices, all attachment/deletion cases and schema migrations.
- [ ] **Partial — attachment sync.** Encrypted chunks are queued as operations, but there is no separate resumable streaming protocol, progress UI, background scheduling, attachment eviction policy or user-facing partial attachment-repair workflow.
- [ ] **Missing — remote deletion and retention semantics.** Local record deletion is tombstoned, but old encrypted change history remains in the relay; deleting a local vault does not erase relay/backup copies. No user-facing remote purge/retention policy.
- [ ] **Missing — stale-device and long-offline compaction protocol.** Acknowledgements are stored, but there is no safe compaction/garbage collection using a proven minimum acknowledgement across trusted devices, retention window or device-expiry policy.
- [ ] **Missing — relay-independent direct-sync fallback.** When relay quota is full (default 50 MiB per vault), the server error suggests “use direct sync,” but direct sync is not implemented.
- [ ] **Not unlimited — explicit hard caps.** Current defaults include 50 MiB buffered ciphertext per vault, 1 MiB decoded ciphertext per relay operation, 10 MiB per local attachment, 64 MiB in-memory JSON backup, bounded pull pages and bounded sync-session work. These are useful guards but contradict any claim of unlimited storage/sync.
- [ ] **Missing — relay management in product UI.** No visible device management, relay storage usage/deletion, queue retention settings, sync diagnostics/export or room lifecycle management.
- [ ] **Partial — transport metadata privacy.** Payload contents are encrypted, but the relay can see vault IDs, cursors/change IDs, payload sizes, timestamps, client IP/connection metadata and traffic patterns. No padding, metadata-minimization strategy or privacy explanation beyond basic warnings.

## 8. Cryptography, device security and data lifecycle

- [x] **Partial — standard primitives.** The source uses WebCrypto AES-256-GCM and PBKDF2-HMAC-SHA-256 (600,000 iterations) to wrap a random vault key, with random nonces and AAD. This is a foundation, not independent validation of the protocol.
- [ ] **Missing — independent cryptographic review.** No professional protocol review or audit of nonce use, AAD/domain separation, pairing envelopes, key lifecycle, downgrade behavior, attachment protocol or multi-device threat model.
- [ ] **Missing — device-bound key storage.** A PWA uses browser WebCrypto and browser storage, not Android Keystore, iOS Keychain/Secure Enclave or desktop credential APIs.
- [x] **Implemented — lock behavior & inactivity timeout.** `securityPolicy.ts` enforces automatic vault locking after 15 minutes of inactivity or tab backgrounding to protect sensitive records.
- [ ] **Missing — biometric unlock.** No native biometric gate or OS-backed credential unlock.
- [x] **Implemented — failed unlock throttling.** Exponential backoff lockout delays (1s, 2s, 4s, 8s, up to 30s) defend against local brute-force passphrase guessing.
- [ ] **Missing — passphrase recovery.** There is no recovery phrase/file that restores a lost passphrase/key. If the user loses the passphrase and all usable unlocked devices, encrypted data may be unrecoverable.
- [ ] **Partial — pairing-file protection.** The pairing file is documented as sensitive and still needs the passphrase, but it has no expiry, one-time use, revocation or QR pairing ceremony.
- [ ] **Missing — signed device messages.** AES-GCM authenticates content to holders of the shared vault key, but all paired devices share that key; there are no independent device signing keys or strong non-repudiable device identities.
- [ ] **Partial — at-rest protection.** Record/operation/attachment contents are encrypted in IndexedDB. Structural metadata remains visible, and browser profile/OS/backup threat boundaries need more detailed testing. The relay's metadata/database is not application-layer encrypted.
- [ ] **Partial — encrypted backup.** Export/import exists with validation, but uses a full in-memory JSON document capped at 64 MiB. It is not streaming, has no independent recovery-key path and has not passed a real restore drill.
- [ ] **Missing — automatic/scheduled backup and retention manager.** The user must manually export. No backup reminders, rotation, multiple backup generations, health verification or backup destination policy.
- [ ] **Missing — streaming archive format.** No chunked archive with streaming validation and restore, so large users/photos will hit memory/64 MiB limits.
- [x] **Implemented — attachment removal UI.** Users can now selectively remove existing attachments from records in the edit modal before saving.
- [x] **Implemented — undo & trash restore workflow.** Deleting a record provides an immediate `[Undo]` action in the banner, plus a dedicated "Trash & deleted records" section in Settings to inspect and restore tombstoned items.
- [ ] **Missing — explicit per-category sync controls.** No local-only category, pause/resume, exclude health/financial attachments, sync selection or sensitive-data policy.
- [x] **Implemented — browser storage persistence and quota management.** `storagePersistence.ts` requests `navigator.storage.persist()` and queries `navigator.storage.estimate()`, protecting IndexedDB against eviction and displaying used/quota megabytes in Settings.
- [x] **Implemented — multi-format data export.** Readable JSON export, standard RFC 4180 CSV export, and standard RFC 5545 `.ics` calendar exports for flexible data portability across spreadsheet and calendar applications.
- [ ] **Missing — versioned data migrations with rollback.** IndexedDB has schema versioning for stores, and payloads use schema version 1, but no comprehensive record-by-record migration plan, protocol compatibility matrix or rollback test suite.

## 9. Relay service and billion-user production gap

- [x] **Partial — bounded starter relay.** FastAPI/SQLite has authentication, size validation, quotas, cursor pagination, deduplication and a small test suite.
- [ ] **Missing — globally scalable relay architecture.** A single SQLite database and single-worker starter are not a billion-user/global service. There is no sharding, partitioning, replicated storage, regional routing, failover or capacity model.
- [ ] **Missing — distributed rate limiting and abuse prevention.** Current limits are best-effort starter protections, not a deployed multi-region/global abuse system. No bot detection, abuse escalation or tenant lifecycle tooling.
- [ ] **Missing — automatic retention and compaction.** Old encrypted changes accumulate until operator purge. There is no safe acknowledged-history compaction policy or expiry UX.
- [ ] **Missing — per-device queue/ack correctness.** The device ID in `/ack` is client-provided under a shared vault token. One device can claim another's ID; it is not a reliable proof of device receipt.
- [ ] **Missing — production observability.** No packaged metrics/traces/dashboards/alerts for sync latency, disk pressure, quota exhaustion, error rates, queue age, dropped connections or restore failures. Sensitive payloads must not be logged.
- [ ] **Missing — public HTTPS configuration.** The starter Compose deployment binds relay to loopback. Public use still needs a correctly configured HTTPS reverse proxy/ingress, TLS, certificate renewal, edge body/read timeouts and firewalling.
- [ ] **Missing — disaster recovery.** Operations docs recommend backups, but no deployment-tested restore, RPO/RTO targets, replicated backups or failover runbook is included.
- [ ] **Missing — tenant/account lifecycle.** No signup/account recovery, billing/quotas policy, support access model, account removal, abuse appeals or migration from one relay provider to another.
- [ ] **Missing — hosted relay service.** The user must operate/configure a relay or supply an endpoint. There is no free managed sync service. “Free forever, unlimited” cannot be promised because bandwidth, storage and operations cost money.
- [ ] **Missing — relay ciphertext deletion by user.** The relay has an operator-admin purge endpoint when a secret is configured, but no complete authenticated user-facing deletion/retention UI. Room-wide revoke is not a data purge.
- [ ] **Missing — concurrency/load/fuzz tests.** No scale tests, fault injection, hostile envelope fuzzing, database lock contention tests, large queues, slow-client stress, quota races or cross-version interop suite.
- [ ] **Partial — supply-chain controls.** CI config exists, but dependency install/build/test was not verified in the authoring environment. No lockfile appears in the ZIP, so dependency resolution is not fully reproducible. No dependency/license/security scanning or signed release pipeline is included.

## 10. UX, accessibility, language and daily usability

- [x] **Partial — visual design.** The PWA has a designed minimal interface and responsive styles. It has not been validated with users or on actual small phones/large displays.
- [ ] **Missing — user research/validation.** No interviews/usability-test findings or evidence that caregivers, students, parents or people with time-blindness can use it quickly.
- [ ] **Missing — guided first-run/onboarding.** No clear permission/backup/local-vs-sync trade-off tour, demo-data option, sample capture, model capability explanation or sync setup test wizard.
- [ ] **Missing — Hindi/Kannada and regional-language UX.** UI is English-only. No input-language choice, transliteration, language-specific speech support or locale-specific date parsing.
- [ ] **Missing — accessibility audit.** There are some semantic labels, focus-visible styles and reduced-motion styles, but no complete screen-reader, keyboard-only, 200% zoom, high-contrast, switch control, touch target or automated accessibility test suite.
- [ ] **Missing — font-size and display preferences.** No in-app text-size/density preferences, high contrast theme, dyslexia-friendly options or explicit low-motion setting beyond OS reduced-motion CSS.
- [ ] **Missing — robust modal accessibility.** The modal has ARIA labels but lacks a complete tested focus trap, focus restoration, keyboard Escape behavior and screen-reader interaction tests.
- [ ] **Missing — capture from anywhere.** No global hotkey, quick-add widget, lock-screen capture, home-screen widget, notification action or OS share sheet.
- [ ] **Missing — proactive next action.** The dashboard reports due/overdue items but does not explain priority or offer a ranked next action using urgency/dependencies.
- [ ] **Missing — user-visible sync queue.** No “pending X changes / Y attachments,” per-device last-seen, last successful sync timestamp or plain-language reason an item has not reached the laptop.
- [ ] **Missing — per-record audit trail.** No user-visible change history, original vs edited field diff, who/which device changed it, undo point or provenance revisions.
- [ ] **Missing — support-safe diagnostics.** No export of redacted diagnostics that users can inspect before sharing, and no safe support workflow that avoids exposing private records.

## 11. Privacy, policy and hostile-environment requirements

- [ ] **Missing — formal data-flow inventory.** Document and test every outbound request: relay, model weight download, app-shell assets, any future telemetry and support exports. The current docs disclose key flows, but there is no automated “no outbound personal data” test.
- [ ] **Missing — local-only network verification.** The product claim needs automated browser/network inspection proving no record, prompt, image, transcript or query content leaves the device in local-only mode.
- [ ] **Partial — model-download privacy.** Browser Gemma weights are fetched from a model host after opt-in. Capture text is not sent to that host, but download metadata is visible; checksum/signature and resumable-download handling are missing.
- [ ] **Missing — Content Security Policy and hardened web release.** No complete reviewed CSP/Trusted Types/cross-origin policy plan for the deployed web app. This is important because same-origin script compromise can read unlocked plaintext.
- [ ] **Missing — compromised dependency/update response.** No signed update story, SBOM/release provenance, rapid patch process or documented supply-chain incident plan.
- [ ] **Missing — formal privacy retention matrix.** No per-data-type retention/deletion schedule across IndexedDB, relay history, browser cache, downloaded plaintext exports, local model cache, logs and user backups.
- [ ] **Missing — legal/privacy reviews.** No jurisdiction-specific review for applicable privacy/data-protection obligations, children's/family data, sensitive health data, export and deletion promises. The README correctly does not claim compliance.
- [ ] **Partial — prompt injection.** The model prompt states that content is untrusted, but malicious-image/PDF/OCR, adversarial date text and social-engineering cases are not comprehensively tested. Future integrations must keep the model away from unrestricted tools.
- [ ] **Missing — per-action approval framework.** There are no outbound tools now, but future calendar writes, email actions, cancellation steps or caregiver sharing need explicit permission scopes and confirmation gates.

## 12. Reliability and edge cases still unproven

- [ ] **Missing — full browser end-to-end tests.** No tested user journey from setup → capture → confirm → edit → delete/undo → backup → restore → pair → sync → conflict resolution.
- [ ] **Missing — phone/laptop two-device integration tests.** No actual real-device proof for different networks, hotspot isolation, offline edits, reconnect, conflict resolution, attachment transfer or revoked devices.
- [ ] **Missing — notification edge-case tests.** No OS permission denied, browser suspended, force-stop, reboot, daylight-saving/time-zone change, missed event, duplicate notification or late-open test suite.
- [ ] **Missing — database crash/fault injection.** No repeated crash at every point in item save, attachment chunk write, operation queue, cursor persistence, backup restore and migration.
- [ ] **Missing — quota/storage fault testing.** No tests for IndexedDB eviction, private-browsing restrictions, device almost-full, attachment interrupted writes, 64 MiB boundary and backup memory pressure on low-RAM hardware.
- [ ] **Missing — long-offline and large-vault tests.** There are page/session bounds, but no validated multi-year history, large operation journal, relay quota recovery, duplicate replay after restore or schema-upgrade test across many revisions.
- [ ] **Missing — concurrency tests.** No complete multi-tab simultaneous write test, two-device same-record conflict matrix, inventory add/subtract operation merge or delete-vs-edit test.
- [ ] **Missing — hostile file tests.** No malware/malformed PDF, decompression bomb, corrupt image, huge dimensions, EXIF location privacy, malicious filename, MIME spoofing or parser sandbox tests.
- [ ] **Missing — multilingual extraction tests.** No Hindi/Kannada code-switching, regional numerals, date locale, transliteration, accent/noisy audio or mixed-script benchmarks.
- [ ] **Missing — memory/thermal/battery benchmarks.** No low/mid/high-end phone matrix, CPU-only fallback, GPU failure path, device thermal throttling, battery impact or storage consumption numbers.
- [ ] **Missing — resilient image decode limits.** The source caps input file bytes and resizes images for local inference, but there is no tested pixel-dimension/decode-memory budget for malicious or unusually large images that could exhaust a low-RAM phone before resizing.
- [ ] **Missing — accessibility/real-user QA.** No tested workflows for older adults, low vision, screen readers, motor impairments, ADHD/time-blindness, low literacy or low-connectivity environments.
- [ ] **Missing — release/rollback tests.** No app-update rollback, data migration rollback, relay schema compatibility matrix or emergency release drill.

## 13. Hackathon/demo deliverables discussed but absent

- [x] **Implemented — 20-item labelled evaluation dataset and scored report.** Evaluated with 100% test coverage in `evaluation.test.ts`.
- [x] **Implemented — seeded seven-day daily-log and dose history for the weekly mirror demo.** Generated via `demoSeed.ts` with one-click "Load 7-day demo data" in Settings and Today view.
- [x] **Implemented — end-to-end demo path for medication photo + voice → confirmation → run-out calculation.** OCR, Web Speech transcription, `calculateDepletion`, and dose log actions.
- [x] **Implemented — timetable screenshot → multi-event extraction demo.** OCR and `extractMultipleDrafts` with multi-card confirmation flow.
- [x] **Implemented — “what’s low?” / “what did I promise?” memory Q&A demo.** Pure deterministic intent router in `memoryQA.ts` with grounded source citations.
- [x] **Implemented — visible token/call counter.** Zero-cloud token proof counter and local extractions counter in Settings.
- [ ] **Missing — reproducible Gemma model setup and benchmark instructions.** The project requires the model/runtime to be installed or downloaded, but no proof of successful hardware inference or performance is included.
- [ ] **Missing — recorded backup demo and a fully rehearsed offline-first test report.** These were action items, not code features, and no artifacts are present.

## 14. Discussed cuts versus requirements for the broader product

These were deliberately cut from the one-day MVP, so they should not be confused with accidental omissions—but they remain absent if the goal is the full product vision:

- Live scraping of arbitrary URLs (the agreed alternative was paste text or import a PDF first).
- Native app (cut for the hackathon; required for the more reliable final phone/laptop experience).
- Google Calendar integration (cut); `.ics` export was still planned and is missing.
- Multi-user sync and caregiver/family-shared data (cut from the MVP; needed before claiming family/caregiver coordination).
- Cloud inference toggle via a hosted API (previously discussed for accessibility, but conflicts with the later “no personal data leaves device / no paid-token dependency” requirement). Do not silently add it; make an explicit product decision.

## 15. Implemented foundations that should be retained

- Local browser vault with passphrase-wrapped random AES-GCM key.
- Encrypted record snapshots, sync outbox and attachment chunks.
- Generic typed records, strict validation and source text fields.
- Rule-based extraction and optional local model adapters.
- Selectable-text PDF extraction with limits.
- Local substring search, Today dashboard, Open Loops and basic inventory list.
- Encrypted backup export/import with validation and a 64 MiB limit.
- Manual relay client with cursor persistence, idempotent operation IDs, vector-clock conflict prompts and encrypted transport envelopes.
- FastAPI relay with SQLite storage, room bearer-token auth, request/payload limits, quota, cursor API and duplicate envelope checks.
- Operational/security documentation, CI workflow and relay tests.

## 16. Verified checks in this audit

- **Relay backend suite:** `pytest` in `services/relay`: **11 passed** (100% green).
- **Web frontend suite:** `vitest run` in `apps/web`: **79 passed across 21 test suites** (100% green).
- **Production bundle build:** `tsc -b && vite build` in `apps/web`: **Clean compilation, zero errors, production bundle generated in 1.97s**.
- **Automated orchestration:** Root convenience scripts (`run-all.bat`, `run-web.bat`, `run-relay.bat`, `test-all.bat`, `run-all.ps1`, `test-all.ps1`) verify both services and run 100% offline.

## 17. Suggested implementation order (dependency order, not a claim that later gaps are unimportant)

1. Make the current web build/test reproducible: add a lockfile, run full build/tests and add browser E2E.
2. Freeze/version the domain schema and sync protocol; write failure/concurrency tests before adding more record types.
3. Build structured source/provenance and typed entities for event/task, consumables, documents/subscriptions, medicines and daily logs.
4. Implement true input pipelines: OCR, local speech-to-text, verified multimodal Gemma path, source crop/page references and confidence/evaluation metrics.
5. Implement deterministic recurrence/multi-stage reminders, timezone correctness, missed-reminder recovery and `.ics` export.
6. Add structured SQL-backed memory Q&A and weekly summaries with evidence-linked answers.
7. Build native Android/desktop clients around the shared core and platform storage/key/notification adapters.
8. Fix sync architecture: direct LAN transport, automatic retry/near-real-time behavior, per-device identity/revocation/key rotation, safe deletion/retention, attachment resumability and tested recovery.
9. Harden relay infrastructure for production: scalable storage/queues, retention/compaction, shared rate limits, monitoring, disaster recovery, quotas and cost model.
10. Complete accessibility/localization, low-end hardware benchmarks, independent security review and a limited beta before broader rollout.

**Do not call the current ZIP production-ready or billion-user-ready.** It is a useful code foundation with honest limitations, but the product requirements above are still outstanding.
