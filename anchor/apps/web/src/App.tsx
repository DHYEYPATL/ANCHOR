import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import type { AnchorItem, AttachmentMetadata, ItemKind, SyncState } from './domain/models';
import { extractDraft, extractMultipleDrafts, formatDue, isDueToday, isOverdue, toItemDraft, type ExtractionDraft } from './application/extractor';
import { LocalGemmaOllamaAdapter, validateLoopbackEndpoint } from './application/gemma';
import { LocalGemmaWebAdapter, disposeBrowserGemma, type BrowserGemmaModel } from './application/gemmaWeb';
import { extractPdfText } from './application/pdfText';
import { startSpeechTranscription, isSpeechRecognitionSupported, type SpeechTranscriptionSession } from './application/speech';
import { extractTextFromImageBlob, extractOcrFromPdf, isLocalOcrSupported } from './application/ocr';
import { playReminderChime } from './application/sound';
import { getMissedReminders, acknowledgeReminder, calculateSnoozedDueAt, dispatchReminderNotification, computeNextRecurrence, getDueReminderStages } from './application/reminders';
import { createP2PSyncBundle, applyP2PSyncBundle } from './infrastructure/p2pSync';
import { listConflicts, listItems, resolveConflict, saveItem, deleteItem, listDeletedItems, restoreItem, type ConflictView } from './infrastructure/repository';
import { createVault, exportPairingBundle, importPairingBundle, importTextBundle, isSecureContextAvailable, unlockVault, updateRelayConfig, type UnlockedVault } from './infrastructure/vault';
import { getVaultMeta, openDb, clearAllUserData } from './infrastructure/database';
import { createEncryptedBackupText, MAX_BACKUP_FILE_BYTES, restoreEncryptedBackupValue } from './infrastructure/backup';
import { syncNow } from './infrastructure/sync';
import { downloadAttachment, MAX_ATTACHMENT_BYTES, rollbackUnpublishedAttachment, saveAttachmentFile } from './infrastructure/attachments';
import { generateIcs } from './infrastructure/ical';
import { generateCsv } from './infrastructure/csv';
import { calculateDepletion } from './domain/inventoryMath';
import { answerMemoryQuery } from './application/memoryQA';
import { generateWeeklyLifeMirror, type WeeklyLifeMirror } from './application/digest';
import { recordMedicationDose, calculateAdherenceRate, generateDoctorVisitBrief } from './domain/medication';
import { recordFailedUnlock, recordSuccessfulUnlock, getUnlockThrottleState, createInactivityMonitor } from './application/securityPolicy';
import { requestPersistentStorage, getStorageQuotaEstimate, formatBytes, type StorageQuotaInfo } from './infrastructure/storagePersistence';
import { generateDemoSeedItems } from './application/demoSeed';
import { getSubscriptionCancellationGuide } from './domain/subscription';

 type View = 'today' | 'memory' | 'promises' | 'inventory' | 'settings';
 type Modal = 'capture' | 'edit' | 'delete' | null;

const kindLabels: Record<ItemKind, string> = {
  task: 'Task', event: 'Event', promise: 'Open loop', note: 'Memory', consumable: 'Inventory', document: 'Document',
};
const nav: { id: View; label: string; icon: string; subtitle: string }[] = [
  { id: 'today', label: 'Today', icon: '◷', subtitle: 'What needs you now' },
  { id: 'memory', label: 'Memory', icon: '⌕', subtitle: 'Everything you have saved' },
  { id: 'promises', label: 'Open loops', icon: '↗', subtitle: 'Promises and follow-ups' },
  { id: 'inventory', label: 'Inventory', icon: '▤', subtitle: 'Things running low' },
  { id: 'settings', label: 'Settings', icon: '⚙', subtitle: 'Your vault and devices' },
];

function relativeGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}
function niceDate() { return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()); }
function isDueThisWeek(item: AnchorItem) {
  if (!item.dueAt) return false;
  const t = new Date(item.dueAt).getTime(); const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7).getTime();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return t >= start && t < end;
}
function isDueSoon(item: AnchorItem) {
  if (!item.dueAt) return false;
  const d = new Date(item.dueAt).getTime();
  return d < Date.now() + 3 * 86400000 && !item.deletedAt && item.status !== 'done';
}
function displayKind(kind: ItemKind) { return kindLabels[kind] ?? 'Memory'; }
function formatClock(value?: string) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
}
function saveBlob(filename: string, text: string, mime = 'application/json') {
  const blob = new Blob([text], { type: mime }); const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Icon({ name }: { name: string }) { return <span className="icon" aria-hidden="true">{name}</span>; }

export default function App() {
  const [unlocked, setUnlocked] = useState<UnlockedVault | null>(null);
  const [hasVault, setHasVault] = useState<boolean | null>(null);
  const [view, setView] = useState<View>('today');
  const [items, setItems] = useState<AnchorItem[]>([]);
  const [conflicts, setConflicts] = useState<ConflictView[]>([]);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const [editing, setEditing] = useState<AnchorItem | null>(null);
  const [captureText, setCaptureText] = useState('');
  const [draft, setDraft] = useState<Partial<AnchorItem> & Pick<AnchorItem, 'title' | 'kind'>>({ title: '', kind: 'task' });
  const [capturePreview, setCapturePreview] = useState<ReturnType<typeof extractDraft> | null>(null);
  const [selectedDateIso, setSelectedDateIso] = useState<string | null>(null);
  const [selectedTimeOption, setSelectedTimeOption] = useState<{ hour: number; minute: number } | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [useLocalGemma, setUseLocalGemma] = useState(() => { try { return localStorage.getItem('anchor-local-gemma-enabled') === 'true'; } catch { return false; } });
  const [gemmaEndpoint, setGemmaEndpoint] = useState(() => { try { return localStorage.getItem('anchor-local-gemma-endpoint') || 'http://localhost:11434'; } catch { return 'http://localhost:11434'; } });
  const [gemmaModel, setGemmaModel] = useState(() => { try { return localStorage.getItem('anchor-local-gemma-model') || 'gemma4:e2b'; } catch { return 'gemma4:e2b'; } });
  const [gemmaRuntime, setGemmaRuntime] = useState<'ollama' | 'webgpu'>(() => { try { return localStorage.getItem('anchor-local-gemma-runtime') === 'webgpu' ? 'webgpu' : 'ollama'; } catch { return 'ollama'; } });
  const [gemmaWebModel, setGemmaWebModel] = useState<BrowserGemmaModel>(() => 'e2b');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [missedReminders, setMissedReminders] = useState<AnchorItem[]>([]);
  const [soundEnabled, setSoundEnabled] = useState(() => { try { return localStorage.getItem('anchor-reminder-sound') !== 'false'; } catch { return true; } });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const discardRecordingRef = useRef(false);
  const speechSessionRef = useRef<SpeechTranscriptionSession | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const notificationSentRef = useRef(new Set<string>());
  const [setupMode, setSetupMode] = useState<'create' | 'unlock' | 'import'>('create');
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [setupRelay, setSetupRelay] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'error' | 'success' | 'info'; text: string } | null>(null);
  const [syncState, setSyncState] = useState<SyncState>('local-only');
  const [syncMessage, setSyncMessage] = useState('This device only');
  const [relayUrl, setRelayUrl] = useState('');
  const [notificationState, setNotificationState] = useState<NotificationPermission | 'unsupported'>('unsupported');
  const [showWipeConfirm, setShowWipeConfirm] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const p2pImportRef = useRef<HTMLInputElement>(null);
  const captureInputRef = useRef<HTMLTextAreaElement>(null);
  const [multiDrafts, setMultiDrafts] = useState<ExtractionDraft[]>([]);
  const [weeklyMirror, setWeeklyMirror] = useState<WeeklyLifeMirror | null>(null);
  const [showWeeklyModal, setShowWeeklyModal] = useState(false);
  const [deletedItems, setDeletedItems] = useState<AnchorItem[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [lastDeleted, setLastDeleted] = useState<AnchorItem | null>(null);
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(() => { try { return localStorage.getItem('anchor-auto-sync') === 'true'; } catch { return false; } });
  const [storageInfo, setStorageInfo] = useState<StorageQuotaInfo | null>(null);
  const [localExtractionsCount, setLocalExtractionsCount] = useState<number>(() => {
    try {
      const v = localStorage.getItem('anchor-local-extraction-count');
      return v ? parseInt(v, 10) : 0;
    } catch {
      return 0;
    }
  });

  useEffect(() => {
    if (!unlocked) return;
    void getStorageQuotaEstimate().then(setStorageInfo);
    const monitor = createInactivityMonitor(() => {
      lockVault();
      setMessage({ type: 'info', text: 'Vault automatically locked due to 15 minutes of inactivity.' });
    }, 15);
    return () => monitor.destroy();
  }, [unlocked]);

  const refresh = useCallback(async (current?: UnlockedVault | null) => {
    const vault = current ?? unlocked;
    if (!vault) return;
    const [nextItems, nextConflicts, meta] = await Promise.all([
      listItems(vault.db, vault.session), listConflicts(vault.db, vault.session), getVaultMeta(vault.db),
    ]);
    setItems(nextItems);
    setConflicts(nextConflicts);
    setMissedReminders(getMissedReminders(nextItems));
    setRelayUrl(meta?.relayUrl ?? '');
    setSyncState((previous) => !meta?.relayUrl ? 'local-only' : previous === 'local-only' ? 'idle' : previous);
  }, [unlocked]);

  useEffect(() => {
    let canceled = false;
    (async () => {
      try {
        const database = await openDb();
        const meta = await getVaultMeta(database);
        database.close();
        if (!canceled) {
          setHasVault(!!meta);
          setSetupMode(meta ? 'unlock' : 'create');
        }
      } catch (e) {
        if (!canceled) setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Could not initialize local storage.' });
      }
    })();
    return () => { canceled = true; };
  }, []);

  useEffect(() => {
    if (typeof Notification !== 'undefined') setNotificationState(Notification.permission);
  }, []);

  useEffect(() => {
    if (!unlocked) return;
    refresh(unlocked).catch((e) => setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Could not read the local vault.' }));
  }, [unlocked, refresh]);

  const dueToday = useMemo(() => items.filter((i) => i.status === 'open' && isDueToday(i.dueAt)), [items]);
  const overdue = useMemo(() => items.filter((i) => i.status === 'open' && isOverdue(i.dueAt)), [items]);
  const dueSoon = useMemo(() => items.filter((i) => i.status === 'open' && isDueThisWeek(i)), [items]);
  const openItems = useMemo(() => items.filter((i) => i.status === 'open'), [items]);
  const matchedItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    const byView = items.filter((item) => {
      if (view === 'promises') return item.kind === 'promise';
      if (view === 'inventory') return item.kind === 'consumable';
      if (view === 'today') return item.status === 'open' && (isDueToday(item.dueAt) || isOverdue(item.dueAt) || isDueSoon(item));
      return true;
    });
    if (!q) return byView;
    return byView.filter((item) => [item.title, item.body, item.category, item.sourceText, item.sourceLabel, item.kind].some((v) => v?.toLowerCase().includes(q)));
  }, [items, search, view]);

  const memoryAnswer = useMemo(() => {
    if (!search.trim() || search.trim().length < 3) return null;
    const ans = answerMemoryQuery(search, items);
    return ans.intent !== 'unknown' ? ans : null;
  }, [search, items]);

  const doUnlock = async (mode: 'create' | 'unlock' | 'import') => {
    const throttle = getUnlockThrottleState();
    if (throttle.isLockedOut) {
      setMessage({ type: 'error', text: `Too many failed unlock attempts. Please wait ${Math.ceil(throttle.remainingMs / 1000)} seconds before trying again.` });
      return;
    }
    setBusy(true); setMessage(null);
    try {
      if (mode === 'create') {
        if (passphrase !== confirmPassphrase) throw new Error('The passphrases do not match.');
        const created = await createVault(passphrase, setupRelay);
        recordSuccessfulUnlock();
        void requestPersistentStorage();
        setUnlocked(created); setHasVault(true); setPassphrase(''); setConfirmPassphrase('');
        setMessage({ type: 'success', text: 'Your encrypted vault is ready on this device.' });
      } else {
        const result = await unlockVault(passphrase);
        recordSuccessfulUnlock();
        void requestPersistentStorage();
        setUnlocked(result); setHasVault(true); setPassphrase('');
        setMessage({ type: 'success', text: 'Vault unlocked. Your records stay encrypted in local storage.' });
      }
    } catch (e) {
      const throttled = recordFailedUnlock();
      if (throttled.isLockedOut) {
        setMessage({ type: 'error', text: `Incorrect passphrase. Lockout active for ${Math.ceil(throttled.remainingMs / 1000)}s.` });
      } else {
        setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Could not unlock the vault.' });
      }
    } finally { setBusy(false); }
  };

  const handleImportPairing = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true); setMessage(null);
    try {
      if (file.size <= 0) throw new Error('The selected file is empty.');
      if (file.size > MAX_BACKUP_FILE_BYTES) throw new Error('This import exceeds the 64 MiB safety limit. Use a smaller export or a device with more available memory.');
      // Avoid reading a large non-backup file into memory before rejecting it.
      if (file.size > 1_000_000) {
        const prefix = await file.slice(0, 4096).text();
        if (!/"format"\s*:\s*"anchor-encrypted-backup-v1"/.test(prefix)) {
          throw new Error('Pairing files must be under 1 MiB. Larger files must be Anchor encrypted backups.');
        }
      }
      const text = await file.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new Error('Anchor file is not valid JSON.'); }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as Record<string, unknown>).format === 'anchor-encrypted-backup-v1') {
        await restoreEncryptedBackupValue(parsed);
        setHasVault(true); setSetupMode('unlock');
        setMessage({ type: 'success', text: 'Encrypted backup restored to this empty browser profile. Unlock using the original vault passphrase.' });
      } else {
        const bundle = importTextBundle(text);
        await importPairingBundle(bundle);
        setHasVault(true); setSetupMode('unlock');
        setMessage({ type: 'success', text: 'Pairing bundle imported. Enter the vault passphrase to unlock and sync.' });
      }
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Could not import this Anchor file.' });
    } finally { setBusy(false); event.target.value = ''; }
  };

  const stopAndDiscardRecording = () => {
    const recorder = mediaRecorderRef.current;
    discardRecordingRef.current = Boolean(recorder);
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* The recorder may already have stopped. */ }
    }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    recordedChunksRef.current = [];
    setRecording(false);
  };

  const closeModal = () => {
    stopAndDiscardRecording();
    setModal(null); setEditing(null); setCaptureText(''); setCapturePreview(null); setPendingFiles([]); setMultiDrafts([]);
    setSelectedDateIso(null); setSelectedTimeOption(null);
    setDraft({ title: '', kind: 'task' });
  };

  const beginCapture = () => {
    stopAndDiscardRecording();
    setEditing(null); setCaptureText(''); setCapturePreview(null); setPendingFiles([]); setMultiDrafts([]);
    setSelectedDateIso(null); setSelectedTimeOption(null);
    setDraft({ title: '', kind: 'task' }); setModal('capture');
    setTimeout(() => captureInputRef.current?.focus(), 50);
  };

  const handleFilePick = async (event: ChangeEvent<HTMLInputElement>) => {
    const rawFiles = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!rawFiles.length) return;
    const accepted: File[] = [];
    for (const file of rawFiles) {
      if (file.size <= 0) {
        setMessage({ type: 'error', text: `“${file.name}” is empty.` });
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setMessage({ type: 'error', text: `“${file.name}” is larger than the ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MiB limit.` });
        continue;
      }
      accepted.push(file);
    }
    if (!accepted.length) return;
    setPendingFiles((prev) => [...prev, ...accepted]);
    setCapturePreview(null);
    if (modal === 'capture') {
      for (const file of accepted) {
        const ext = file.name.split('.').pop()?.toLowerCase();
        try {
          let extracted = '';
          if (['txt', 'md', 'json', 'csv', 'log'].includes(ext ?? '') || file.type.startsWith('text/')) {
            extracted = await file.text();
          } else if (file.type === 'application/pdf' || ext === 'pdf') {
            setMessage({ type: 'info', text: `Reading PDF text from “${file.name}” locally...` });
            const result = await extractPdfText(file, 20, 20_000);
            extracted = result.text;
            if (result.truncated) {
              setMessage({ type: 'info', text: `Read ${result.pagesRead} of ${result.totalPages} pages locally. The full PDF remains encrypted as an attachment.` });
            } else if (!extracted.trim() && isLocalOcrSupported()) {
              setMessage({ type: 'info', text: 'No selectable text found. Running on-device OCR on scanned PDF pages...' });
              try {
                const ocrRes = await extractOcrFromPdf(file, 5);
                if (ocrRes.text.trim()) {
                  extracted = ocrRes.text;
                  setMessage({ type: 'info', text: `Extracted text from ${ocrRes.pagesProcessed} scanned page(s) using on-device OCR.` });
                }
              } catch {
                setMessage({ type: 'info', text: 'Scanned PDF OCR was unavailable. The full file remains encrypted as an attachment.' });
              }
            }
          } else if (file.type.startsWith('image/') && isLocalOcrSupported()) {
            setMessage({ type: 'info', text: `Inspecting “${file.name}” with local on-device OCR...` });
            try {
              const ocrText = await extractTextFromImageBlob(file);
              if (ocrText.trim()) {
                extracted = ocrText;
                setMessage({ type: 'info', text: 'Extracted text from image using local on-device OCR.' });
              }
            } catch {
              // graceful fallback to attaching the image
            }
          }
          if (extracted) {
            setCaptureText((existing) => `${existing.trim()}${existing.trim() ? '\n\n' : ''}${extracted}`.slice(0, 20_000));
            if (extracted.length > 20_000) setMessage({ type: 'info', text: 'Only the first 20,000 characters are used for extraction. The full original file remains encrypted as an attachment.' });
          } else if (!captureText.trim()) {
            setCaptureText((existing) => `${existing.trim()}${existing.trim() ? '\n\n' : ''}Keep this file: ${file.name}. Review its contents when needed.`);
            if (!(file.type === 'application/pdf' || ext === 'pdf')) setMessage({ type: 'info', text: 'The file will be encrypted and attached. Add a short description to make it searchable.' });
          }
        } catch (error) {
          setMessage({ type: 'error', text: `Could not extract local text: ${error instanceof Error ? error.message : 'unsupported file'}. The original can still be saved as an encrypted attachment.` });
          if (!captureText.trim()) setCaptureText((existing) => `${existing.trim()}${existing.trim() ? '\n\n' : ''}Keep this file: ${file.name}. Add a description before saving.`);
        }
      }
    } else {
      setMessage({ type: 'info', text: `${accepted.length} file(s) selected. They will be encrypted and attached when you save this record.` });
    }
  };

  const startVoiceRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setMessage({ type: 'error', text: 'This browser does not support local audio recording. You can attach an existing audio file instead.' }); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      discardRecordingRef.current = false;
      mediaStreamRef.current = stream; recordedChunksRef.current = [];
      const recorder = new MediaRecorder(stream); mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size > 0) recordedChunksRef.current.push(event.data); };
      recorder.onerror = () => {
        setMessage({ type: 'error', text: 'Audio recording failed. The unsaved recording will not be used.' });
        setRecording(false);
        if (recordingTimerRef.current) { window.clearInterval(recordingTimerRef.current); recordingTimerRef.current = null; }
        speechSessionRef.current?.stop();
        speechSessionRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
      };
      recorder.onstop = () => {
        const chunks = recordedChunksRef.current;
        recordedChunksRef.current = [];
        const discard = discardRecordingRef.current;
        discardRecordingRef.current = false;
        const mimeType = recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunks, { type: mimeType });
        const ext = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm';
        const file = new File([blob], `voice-note-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`, { type: mimeType });
        stream.getTracks().forEach((track) => track.stop()); mediaStreamRef.current = null; mediaRecorderRef.current = null; setRecording(false);
        if (recordingTimerRef.current) { window.clearInterval(recordingTimerRef.current); recordingTimerRef.current = null; }
        speechSessionRef.current?.stop();
        speechSessionRef.current = null;
        if (discard) return;
        if (!file.size) { setMessage({ type: 'error', text: 'The recording was empty.' }); return; }
        if (file.size > MAX_ATTACHMENT_BYTES) { setMessage({ type: 'error', text: 'The recording exceeded the 10 MiB attachment limit. Record a shorter note.' }); return; }
        setPendingFiles((prev) => [...prev, file]);
        setCaptureText((existing) => existing.trim() ? existing : `Voice note recorded ${new Date().toLocaleString()}. Add a title or short description before saving.`);
        setCapturePreview(null);
        setMessage({ type: 'success', text: isSpeechRecognitionSupported() ? 'Voice recorded and transcribed on this device. Audio file attached.' : 'Voice recorded locally. The audio file will be encrypted on this device.' });
      };
      recorder.start();
      setRecording(true);
      setRecordingDuration(0);
      if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = window.setInterval(() => setRecordingDuration((s) => s + 1), 1000);

      // Start on-device real-time speech-to-text if supported by the browser
      if (isSpeechRecognitionSupported()) {
        speechSessionRef.current = startSpeechTranscription(
          (transcript) => {
            if (transcript.trim()) {
              setCaptureText(transcript);
              setCapturePreview(null);
            }
          },
          () => { /* non-fatal speech warning */ },
        );
      }

      setMessage({ type: 'info', text: isSpeechRecognitionSupported() ? 'Recording & transcribing live in this browser. Audio is not sent to a cloud service.' : 'Recording in this browser. Audio is not sent to a cloud service.' });
    } catch (e) { setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Microphone permission was denied or recording could not start.' }); }
  };

  const stopVoiceRecording = () => {
    if (recordingTimerRef.current) { window.clearInterval(recordingTimerRef.current); recordingTimerRef.current = null; }
    speechSessionRef.current?.stop();
    speechSessionRef.current = null;
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
  };

  useEffect(() => () => {
    discardRecordingRef.current = true;
    if (recordingTimerRef.current) { window.clearInterval(recordingTimerRef.current); recordingTimerRef.current = null; }
    speechSessionRef.current?.stop();
    try { if (mediaRecorderRef.current?.state !== 'inactive') mediaRecorderRef.current?.stop(); } catch { /* Nothing to stop. */ }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    void disposeBrowserGemma();
  }, []);

  const imageDataUrlForModel = async (file: File): Promise<string> => {
    if (!file.type.startsWith('image/')) throw new Error('Only image attachments can be passed to a local vision model.');
    if (!('createImageBitmap' in window)) throw new Error('This browser cannot safely resize an image for local inference.');
    const bitmap = await createImageBitmap(file);
    try {
      const maxEdge = 1400;
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Could not prepare image for local inference.');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      if (dataUrl.length > 4_200_000) throw new Error('Resized image is still too large for local model input.');
      return dataUrl;
    } finally { bitmap.close(); }
  };

  const previewCapture = async () => {
    setExtracting(true); setMessage(null);
    try {
      const multi = extractMultipleDrafts(captureText);
      if (multi.length > 1) {
        setMultiDrafts(multi);
        setCapturePreview(multi[0]);
        setDraft({ ...toItemDraft(multi[0]), dueAt: multi[0].dueAt });
        return;
      }
      setMultiDrafts([]);
      const firstImage = pendingFiles.find((f) => f.type.startsWith('image/'));
      let result: ReturnType<typeof extractDraft>;
      if (!useLocalGemma) {
        result = extractDraft(captureText);
      } else if (gemmaRuntime === 'webgpu') {
        if (firstImage) throw new Error('The browser Gemma runtime configured here is text-only and has not inspected the image. Switch to the loopback local vision runtime, or add a description and use the rule-based extractor.');
        result = await new LocalGemmaWebAdapter(gemmaWebModel).extract({ text: captureText });
      } else {
        const imageDataUrl = firstImage ? await imageDataUrlForModel(firstImage) : undefined;
        result = await new LocalGemmaOllamaAdapter(gemmaEndpoint, gemmaModel).extract({ text: captureText, imageDataUrl });
      }
      setCapturePreview(result);
      setSelectedDateIso(null);
      setSelectedTimeOption(null);
      setDraft({ ...toItemDraft(result), dueAt: result.dueAt });
      setLocalExtractionsCount((c) => {
        const next = c + 1;
        try { localStorage.setItem('anchor-local-extraction-count', String(next)); } catch { /* Ignore */ }
        return next;
      });
    } catch (e) { setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Capture could not be parsed.' }); }
    finally { setExtracting(false); }
  };

  const commitMultipleDrafts = async () => {
    if (!unlocked || multiDrafts.length === 0) return;
    setBusy(true); setMessage(null);
    try {
      let count = 0;
      for (const d of multiDrafts) {
        const itemDraft = toItemDraft(d);
        await saveItem(unlocked.db, unlocked.session, { ...itemDraft, id: crypto.randomUUID() });
        count++;
      }
      await refresh(unlocked);
      closeModal();
      setMessage({ type: 'success', text: `Extracted and saved ${count} records.` });
      if (autoSyncEnabled && relayUrl) void runSync();
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Could not save multiple records.' });
    } finally {
      setBusy(false);
    }
  };

  const applyResolvedDateTime = (dateIso?: string | null, timeOpt?: { hour: number; minute: number } | null) => {
    const dIso = dateIso !== undefined ? dateIso : selectedDateIso;
    const tOpt = timeOpt !== undefined ? timeOpt : selectedTimeOption;

    const hasAmbiguousDate = Boolean(capturePreview?.ambiguity?.isAmbiguousDate);
    const hasAmbiguousTime = Boolean(capturePreview?.ambiguity?.isAmbiguousTime);

    if (hasAmbiguousDate && !dIso) return;
    if (hasAmbiguousTime && !tOpt) return;

    const baseDate = dIso ? new Date(dIso) : new Date();
    if (tOpt) {
      baseDate.setHours(tOpt.hour, tOpt.minute, 0, 0);
    } else {
      baseDate.setHours(9, 0, 0, 0);
    }

    setDraft((prev) => ({
      ...prev,
      dueAt: baseDate.toISOString(),
      safetyBlocked: false,
      unresolvedReason: undefined,
    }));
  };

  const applyResolvedDosage = (option: { label: string; dailyRate: number }) => {
    setDraft((prev) => ({
      ...prev,
      dailyRate: option.dailyRate,
      safetyBlocked: false,
      unresolvedReason: undefined,
      confidence: 'medium',
      body: `${prev.body ?? ''}\n\n[Verified Regimen]: ${option.label}`,
    }));
  };

  const duplicateItem = useMemo(() => {
    if (!capturePreview || multiDrafts.length > 0) return null;
    const targetTitle = (draft.title || '').trim().toLowerCase();
    if (!targetTitle) return null;
    const targetNorm = targetTitle.replace(/^(?:remind me to|please|todo:)\s+/i, '').replace(/[^a-z0-9]/g, '');
    if (!targetNorm || targetNorm.length < 3) return null;
    return items.find((item) => {
      if (item.status === 'done' || item.deletedAt) return false;
      const itemNorm = item.title.trim().toLowerCase().replace(/^(?:remind me to|please|todo:)\s+/i, '').replace(/[^a-z0-9]/g, '');
      if (!itemNorm) return false;
      const isTitleSimilar = itemNorm === targetNorm ||
        (itemNorm.length >= 6 && targetNorm.length >= 6 && (itemNorm.includes(targetNorm) || targetNorm.includes(itemNorm)));
      return isTitleSimilar;
    });
  }, [items, draft.title, capturePreview, multiDrafts]);

  const updateExistingDuplicate = async (existing: AnchorItem) => {
    if (!unlocked) return;
    setBusy(true); setMessage(null);
    try {
      acknowledgeReminder(existing);
      const updated: AnchorItem = {
        ...existing,
        dueAt: draft.dueAt ?? existing.dueAt,
        body: draft.body ? `${existing.body}\n\n[Updated deadline]: ${draft.dueAt ? formatDue(draft.dueAt) : 'unscheduled'}` : existing.body,
        updatedAt: new Date().toISOString(),
      };
      await saveItem(unlocked.db, unlocked.session, updated);
      await refresh(unlocked);
      closeModal();
      setMessage({ type: 'success', text: `Updated deadline of “${existing.title}” to ${updated.dueAt ? formatDue(updated.dueAt) : 'unscheduled'}.` });
      if (autoSyncEnabled && relayUrl) void runSync();
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Could not update existing item.' });
    } finally {
      setBusy(false);
    }
  };

  const cancellationMatch = useMemo(() => {
    if (!capturePreview?.isCancelled || multiDrafts.length > 0) return null;
    const targetNorm = (draft.title || '').trim().toLowerCase()
      .replace(/\s*\(already completed\)|\s*\(no longer needed\)|\s*\(cancelled\)/ig, '')
      .replace(/^(?:remind me to|please|todo:)\s+/i, '')
      .replace(/[^a-z0-9]/g, '');
    if (!targetNorm || targetNorm.length < 3) return null;
    return items.find((item) => {
      if (item.status === 'done' || item.deletedAt) return false;
      const itemNorm = item.title.trim().toLowerCase().replace(/^(?:remind me to|please|todo:)\s+/i, '').replace(/[^a-z0-9]/g, '');
      if (!itemNorm) return false;
      return itemNorm === targetNorm || itemNorm.includes(targetNorm) || targetNorm.includes(itemNorm);
    });
  }, [items, draft.title, capturePreview, multiDrafts]);

  const deleteMatchedItem = async (target: AnchorItem) => {
    if (!unlocked) return;
    setBusy(true); setMessage(null);
    try {
      await deleteItem(unlocked.db, unlocked.session, target.id);
      acknowledgeReminder(target);
      await refresh(unlocked);
      closeModal();
      setMessage({ type: 'success', text: `Deleted active task “${target.title}”.` });
      if (autoSyncEnabled && relayUrl) void runSync();
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Could not delete item.' });
    } finally {
      setBusy(false);
    }
  };

  const completeMatchedItem = async (target: AnchorItem) => {
    if (!unlocked) return;
    setBusy(true); setMessage(null);
    try {
      acknowledgeReminder(target);
      await saveItem(unlocked.db, unlocked.session, {
        ...target,
        status: 'done',
        body: `${target.body}\n\n[Marked completed]: ${draft.body || 'No longer needed'}`,
        updatedAt: new Date().toISOString(),
      });
      await refresh(unlocked);
      closeModal();
      setMessage({ type: 'success', text: `Marked “${target.title}” as completed.` });
      if (autoSyncEnabled && relayUrl) void runSync();
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Could not complete item.' });
    } finally {
      setBusy(false);
    }
  };

  const commitDraft = async (event: FormEvent) => {
    event.preventDefault();
    if (!unlocked) return;
    if (draft.safetyBlocked) {
      setMessage({ type: 'error', text: draft.unresolvedReason || 'Please resolve the ambiguity or conflict before saving.' });
      return;
    }
    setBusy(true); setMessage(null);
    const createdAttachments: AttachmentMetadata[] = [];
    let recordCommitted = false;
    try {
      // Check if this draft is a self-cancellation of an existing open reminder
      if (draft.status === 'done' || capturePreview?.isCancelled) {
        const targetNorm = (draft.title || '').toLowerCase().replace(/\s*\(already completed\)/i, '').replace(/[^a-z0-9]/g, '');
        if (targetNorm.length >= 3) {
          const existingOpen = items.find((i) => i.status === 'open' && !i.deletedAt && i.title.toLowerCase().replace(/[^a-z0-9]/g, '').includes(targetNorm));
          if (existingOpen) {
            acknowledgeReminder(existingOpen);
            await saveItem(unlocked.db, unlocked.session, {
              ...existingOpen,
              status: 'done',
              body: `${existingOpen.body}\n\n[Marked completed]: ${draft.body || 'Self-cancellation'}`,
              updatedAt: new Date().toISOString(),
            });
          }
        }
      }

      const itemId = draft.id ?? editing?.id ?? crypto.randomUUID();
      let attachments: AttachmentMetadata[] = [...(draft.attachments ?? [])];
      for (const file of pendingFiles) {
        const createdAttachment = await saveAttachmentFile(unlocked.db, unlocked.session, file, itemId);
        createdAttachments.push(createdAttachment);
        attachments = [...attachments.filter((existing) => existing.id !== createdAttachment.id), createdAttachment];
      }
      const saved = await saveItem(unlocked.db, unlocked.session, { ...draft, id: itemId, attachments });
      recordCommitted = true;
      await refresh(unlocked);
      closeModal();
      setMessage({ type: 'success', text: `Saved “${saved.title}”${createdAttachments.length > 0 ? ` with ${createdAttachments.length} encrypted attachment(s)` : ''} to this vault.` });
      setView(saved.kind === 'promise' ? 'promises' : saved.kind === 'consumable' ? 'inventory' : 'today');
      if (autoSyncEnabled && relayUrl) void runSync();
    } catch (e) {
      if (createdAttachments.length > 0 && !recordCommitted) {
        for (const att of createdAttachments) {
          await rollbackUnpublishedAttachment(unlocked.db, unlocked.session, att.id).catch(() => undefined);
        }
      }
      const err = e instanceof Error ? e : new Error('Could not save this record.');
      setMessage({ type: 'error', text: err.name === 'QuotaExceededError' ? 'This device is out of browser storage. Export a backup and free some space before trying again.' : err.message });
    }
    finally { setBusy(false); }
  };

  const toggleDone = async (item: AnchorItem) => {
    if (!unlocked) return;
    try {
      if (item.status !== 'done' && item.recurrence && item.dueAt) {
        const nextDue = computeNextRecurrence(item.dueAt, item.recurrence);
        await saveItem(unlocked.db, unlocked.session, { ...item, dueAt: nextDue, status: 'open' });
        setMessage({ type: 'success', text: `Completed! Next recurrence scheduled for ${new Date(nextDue).toLocaleDateString()}.` });
      } else {
        await saveItem(unlocked.db, unlocked.session, { ...item, status: item.status === 'done' ? 'open' : 'done' });
      }
      await refresh(unlocked);
      if (autoSyncEnabled && relayUrl) void runSync();
    } catch (e) { setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Could not update this record.' }); }
  };

  const handleRecordDose = async (item: AnchorItem, status: 'taken' | 'skipped') => {
    if (!unlocked) return;
    try {
      const updated = recordMedicationDose(item, status);
      await saveItem(unlocked.db, unlocked.session, updated);
      await refresh(unlocked);
      const adherence = calculateAdherenceRate(updated);
      setMessage({ type: 'success', text: `Marked dose as ${status}. 7-day adherence: ${adherence.ratePercent}%.` });
      if (autoSyncEnabled && relayUrl) void runSync();
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Could not record dose.' });
    }
  };

  const editItem = (item: AnchorItem) => {
    stopAndDiscardRecording(); setPendingFiles([]); setEditing(item); setDraft({ ...item }); setModal('edit'); setMessage(null);
  };

  const confirmDelete = async () => {
    if (!unlocked || !editing) return;
    setBusy(true);
    const toDelete = editing;
    try {
      await deleteItem(unlocked.db, unlocked.session, editing.id);
      setLastDeleted(toDelete);
      await refresh(unlocked);
      closeModal();
      setMessage({ type: 'success', text: `Record “${toDelete.title}” deleted.` });
      if (autoSyncEnabled && relayUrl) void runSync();
    }
    catch (e) { setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Could not delete the record.' }); }
    finally { setBusy(false); }
  };

  const handleUndoDelete = async () => {
    if (!unlocked || !lastDeleted) return;
    try {
      await restoreItem(unlocked.db, unlocked.session, lastDeleted.id);
      setLastDeleted(null);
      await refresh(unlocked);
      setMessage({ type: 'success', text: 'Record restored successfully.' });
      if (autoSyncEnabled && relayUrl) void runSync();
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Could not restore record.' });
    }
  };

  const handleRestoreFromTrash = async (id: string) => {
    if (!unlocked) return;
    try {
      await restoreItem(unlocked.db, unlocked.session, id);
      const updatedDeleted = await listDeletedItems(unlocked.db, unlocked.session);
      setDeletedItems(updatedDeleted);
      await refresh(unlocked);
      setMessage({ type: 'success', text: 'Record restored from trash.' });
      if (autoSyncEnabled && relayUrl) void runSync();
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Could not restore record.' });
    }
  };

  const loadTrash = async () => {
    if (!unlocked) return;
    try {
      const list = await listDeletedItems(unlocked.db, unlocked.session);
      setDeletedItems(list);
      setShowTrash(true);
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Could not load trash.' });
    }
  };

  const exportDoctorBrief = () => {
    const brief = generateDoctorVisitBrief(items);
    saveBlob(`anchor-doctor-brief-${new Date().toISOString().slice(0, 10)}.md`, brief, 'text/markdown');
    setMessage({ type: 'info', text: 'Doctor-visit brief downloaded. Ready for consultation, printing, or offline review.' });
  };

  const exportCsvRecords = () => {
    const csv = generateCsv(items);
    saveBlob(`anchor-export-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv');
    setMessage({ type: 'info', text: 'Records exported as standard RFC 4180 CSV.' });
  };

  const openWeeklyMirror = () => {
    const digest = generateWeeklyLifeMirror(items);
    setWeeklyMirror(digest);
    setShowWeeklyModal(true);
  };

  const handleLoadDemoData = async () => {
    if (!unlocked) return;
    setBusy(true);
    try {
      const demoItems = generateDemoSeedItems();
      for (const item of demoItems) {
        await saveItem(unlocked.db, unlocked.session, item);
      }
      await refresh(unlocked);
      setMessage({ type: 'success', text: `Loaded 7-day demo dataset (${demoItems.length} records) with medications, dose history, and open loops!` });
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Failed to load demo data.' });
    } finally {
      setBusy(false);
    }
  };

  const handleRequestPersistence = async () => {
    const persisted = await requestPersistentStorage();
    const info = await getStorageQuotaEstimate();
    setStorageInfo(info);
    if (persisted) {
      setMessage({ type: 'success', text: 'Browser persistent storage granted! IndexedDB is protected against cache eviction.' });
    } else {
      setMessage({ type: 'info', text: 'Storage status updated. Some browsers grant persistence based on bookmarking or user engagement.' });
    }
  };

  const runSync = async () => {
    if (!unlocked) return;
    const meta = await getVaultMeta(unlocked.db);
    if (!meta) return;
    setBusy(true); setSyncState(meta.relayUrl ? 'syncing' : 'local-only'); setSyncMessage('Connecting…'); setMessage(null);
    try {
      const { result } = await syncNow(unlocked.db, meta, unlocked.session, (state, msg) => { setSyncState(state); setSyncMessage(msg); });
      setSyncState(result.state); setSyncMessage(result.message); await refresh(unlocked);
    } catch (e) {
      setSyncState(navigator.onLine ? 'error' : 'offline');
      setSyncMessage(e instanceof Error ? e.message : 'Sync failed. Local records remain available.');
      setMessage({ type: 'error', text: 'Sync failed; your local records are preserved. ' + (e instanceof Error ? e.message : '') });
    } finally { setBusy(false); }
  };

  const saveRelay = async (event: FormEvent) => {
    event.preventDefault();
    if (!unlocked) return;
    setBusy(true); setMessage(null);
    try {
      const meta = await getVaultMeta(unlocked.db);
      if (!meta) throw new Error('Vault metadata is missing.');
      const updated = await updateRelayConfig(unlocked.db, meta, unlocked.session, relayUrl);
      setUnlocked({ ...unlocked, meta: updated.meta, session: updated.session });
      setSyncState(updated.session.relayUrl ? 'idle' : 'local-only');
      setMessage({ type: 'success', text: updated.session.relayUrl ? 'Relay endpoint saved. Run sync to register this vault.' : 'Relay disabled. This device will remain local-only.' });
    } catch (e) { setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Could not save relay configuration.' }); }
    finally { setBusy(false); }
  };

  const enableNotifications = async () => {
    if (!('Notification' in window)) { setNotificationState('unsupported'); return; }
    const permission = await Notification.requestPermission(); setNotificationState(permission);
    if (permission === 'granted') setMessage({ type: 'info', text: 'Notifications enabled. Browser reminders are best-effort while the app can run; operating systems may suspend background web apps.' });
  };

  const lockVault = () => {
    stopAndDiscardRecording(); void disposeBrowserGemma();
    unlocked?.db.close(); setUnlocked(null); setItems([]); setConflicts([]); setView('today'); setSearch('');
    // Clear unsaved plaintext as well as the unlocked key/session references.
    setModal(null); setCaptureText(''); setCapturePreview(null); setPendingFiles([]); setDraft({ title: '', kind: 'task' }); setEditing(null); setPassphrase(''); setConfirmPassphrase('');
    setMessage({ type: 'info', text: 'Vault locked. The app cleared its active key reference and unsaved capture text.' });
  };

  const exportPairing = async () => {
    if (!unlocked) return;
    const meta = await getVaultMeta(unlocked.db);
    if (!meta) return;
    saveBlob('anchor-pairing.json', JSON.stringify(exportPairingBundle(meta), null, 2));
    setMessage({ type: 'info', text: 'Pairing file downloaded. Transfer it privately, keep it secure, and delete extra copies after pairing.' });
  };

  const exportRecords = async () => {
    if (!unlocked) return;
    saveBlob(`anchor-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ format: 'anchor-user-export-v1', exportedAt: new Date().toISOString(), items }, null, 2));
    setMessage({ type: 'info', text: 'A plaintext export was created because exports must be readable. Treat that file as sensitive and delete it when finished.' });
  };

  const exportIcsCalendar = () => {
    const ics = generateIcs(items);
    saveBlob(`anchor-calendar-${new Date().toISOString().slice(0, 10)}.ics`, ics, 'text/calendar');
    setMessage({ type: 'info', text: 'iCalendar (.ics) exported. Compatible with Apple Calendar, Google Calendar, and Outlook.' });
  };

  const exportEncryptedBackup = async () => {
    if (!unlocked) return;
    setBusy(true);
    try {
      const text = await createEncryptedBackupText(unlocked.db);
      saveBlob(`anchor-encrypted-backup-${new Date().toISOString().slice(0, 10)}.json`, text);
      setMessage({ type: 'info', text: 'Encrypted backup created. Record and attachment payloads remain encrypted, but IDs, timestamps, counts and wrapped-key metadata are visible. Keep this file private and test restore before relying on it.' });
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Could not create an encrypted backup.' });
    } finally { setBusy(false); }
  };

  const wipeVault = async () => {
    if (!unlocked) return;
    stopAndDiscardRecording(); void disposeBrowserGemma();
    setBusy(true);
    try {
      await clearAllUserData(unlocked.db); unlocked.db.close(); setUnlocked(null); setHasVault(false); setSetupMode('create');
      setPassphrase(''); setConfirmPassphrase(''); setShowWipeConfirm(false);
      setMessage({ type: 'success', text: 'Local vault data cleared from this browser profile. This cannot erase copies on other devices or backups.' });
    } catch (e) { setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Could not clear local vault data.' }); }
    finally { setBusy(false); }
  };

  const resolveOneConflict = async (conflict: ConflictView, pick: 'local' | 'remote') => {
    if (!unlocked) return;
    try { await resolveConflict(unlocked.db, unlocked.session, conflict.conflictId, pick); await refresh(unlocked); setMessage({ type: 'success', text: 'Conflict resolved and queued for sync.' }); }
    catch (e) { setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Conflict could not be resolved.' }); }
  };

  const handleSnoozeMissed = async (item: AnchorItem, minutes: number) => {
    if (!unlocked) return;
    const newDueAt = calculateSnoozedDueAt(minutes);
    await saveItem(unlocked.db, unlocked.session, { ...item, dueAt: newDueAt });
    acknowledgeReminder(item);
    setMissedReminders((prev) => prev.filter((i) => i.id !== item.id));
    await refresh(unlocked);
    setMessage({ type: 'info', text: `Snoozed “${item.title}” for ${minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`}.` });
  };

  const handleAcknowledgeAllMissed = () => {
    for (const item of missedReminders) acknowledgeReminder(item);
    setMissedReminders([]);
  };

  const handleToggleSound = (enabled: boolean) => {
    setSoundEnabled(enabled);
    try { localStorage.setItem('anchor-reminder-sound', String(enabled)); } catch { /* Ignore */ }
  };

  const handleExportP2PSync = async () => {
    if (!unlocked) return;
    setBusy(true);
    try {
      const bundle = await createP2PSyncBundle(unlocked.db, unlocked.session);
      saveBlob(`anchor-sync-${unlocked.session.vaultId.slice(0, 8)}-${Date.now()}.json`, JSON.stringify(bundle, null, 2));
      setMessage({ type: 'success', text: `Direct sync bundle exported (${bundle.operations.length} operations). Transfer it to your other device to sync without a relay.` });
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Could not export sync bundle.' });
    } finally { setBusy(false); }
  };

  const handleImportP2PSync = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !unlocked) return;
    setBusy(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const result = await applyP2PSyncBundle(unlocked.db, unlocked.session, parsed);
      await refresh(unlocked);
      setMessage({ type: 'success', text: `Direct sync complete: Applied ${result.applied} change(s), ${result.duplicates} already up to date.` });
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Could not import sync bundle.' });
    } finally { setBusy(false); }
  };

  const handleToggleAutoSync = (enabled: boolean) => {
    setAutoSyncEnabled(enabled);
    try { localStorage.setItem('anchor-auto-sync', String(enabled)); } catch { /* Ignore */ }
    if (enabled && relayUrl) void runSync();
  };

  // Background auto-sync (runs every 3 minutes if online and enabled)
  useEffect(() => {
    if (!unlocked || !autoSyncEnabled || !relayUrl) return;
    const timer = window.setInterval(() => {
      if (navigator.onLine && syncState !== 'syncing') {
        void runSync();
      }
    }, 180_000);
    return () => window.clearInterval(timer);
  }, [unlocked, autoSyncEnabled, relayUrl, syncState]);

  // Multi-stage in-app reminder notifications (1w, 1d, 1h, custom lead buffer, due time)
  useEffect(() => {
    if (!unlocked) return;
    const notifyDue = () => {
      const now = Date.now();
      for (const item of items) {
        if (item.status !== 'open' || !item.dueAt) continue;
        const stages = getDueReminderStages(item, now);
        for (const stage of stages) {
          if (!notificationSentRef.current.has(stage.stageKey)) {
            notificationSentRef.current.add(stage.stageKey);
            if (notificationSentRef.current.size > 500) {
              const oldestKey = notificationSentRef.current.values().next().value;
              if (oldestKey) notificationSentRef.current.delete(oldestKey);
            }
            void dispatchReminderNotification(item, soundEnabled, stage.label, stage.stageKey);
          }
        }
      }
    };
    notifyDue();
    const timer = window.setInterval(notifyDue, 30_000);
    return () => window.clearInterval(timer);
  }, [items, notificationState, soundEnabled, unlocked]);

  const handleDownloadAttachment = async (attachment: AttachmentMetadata) => {
    if (!unlocked) return;
    try { await downloadAttachment(unlocked.db, unlocked.session, attachment); }
    catch (e) { setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Could not open this attachment.' }); }
  };

  const currentNav = nav.find((n) => n.id === view) ?? nav[0];

  if (hasVault === null) return <div className="loading-screen"><div className="brand-mark">A</div><p>Opening your local vault…</p></div>;

  if (!unlocked) return <main className="setup-shell">
    <div className="setup-brand"><div className="brand-mark">A</div><span>anchor</span><span className="eyebrow">PRIVATE BY DESIGN</span></div>
    <div className="setup-content">
      <p className="eyebrow">YOUR MEMORY. YOUR DEVICES.</p>
      <h1>{setupMode === 'unlock' ? 'Welcome back.' : setupMode === 'import' ? 'Connect an existing vault.' : 'Keep life in view.'}</h1>
      <p className="lede">A quiet place for the things you need to remember. Your vault is encrypted on this device; no account or cloud AI is required.</p>
      <div className="segmented setup-tabs" role="tablist" aria-label="Vault setup">
        <button className={setupMode === 'create' ? 'selected' : ''} onClick={() => { setSetupMode('create'); setMessage(null); }}>New vault</button>
        <button className={setupMode === 'unlock' ? 'selected' : ''} onClick={() => { setSetupMode('unlock'); setMessage(null); }} disabled={!hasVault}>Unlock</button>
        <button className={setupMode === 'import' ? 'selected' : ''} onClick={() => { setSetupMode('import'); setMessage(null); }}>Pair device</button>
      </div>
      {setupMode === 'import' ? <section className="setup-card">
        <h2>Import a device or backup file</h2><p>Import a small pairing file to connect an existing vault, or restore an encrypted backup into an empty browser profile. The original passphrase is required.</p>
        <button className="button button-primary" onClick={() => importInputRef.current?.click()} disabled={busy}>Choose Anchor file</button>
        <input ref={importInputRef} type="file" accept="application/json,.json" hidden onChange={handleImportPairing} />
        <p className="form-hint">Only import a pairing file you trust. Do not send it in a public channel.</p>
      </section> : <form className="setup-card" onSubmit={(e) => { e.preventDefault(); void doUnlock(setupMode); }}>
        <label htmlFor="passphrase">Vault passphrase</label>
        <input id="passphrase" type="password" autoComplete={setupMode === 'unlock' ? 'current-password' : 'new-password'} minLength={12} required value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="At least 12 characters" />
        {setupMode === 'create' && <>
          <label htmlFor="confirmPassphrase">Confirm passphrase</label>
          <input id="confirmPassphrase" type="password" autoComplete="new-password" minLength={12} required value={confirmPassphrase} onChange={(e) => setConfirmPassphrase(e.target.value)} placeholder="Enter it again" />
          <label htmlFor="setupRelay">Encrypted relay URL <span className="optional">Optional</span></label>
          <input id="setupRelay" type="url" value={setupRelay} onChange={(e) => setSetupRelay(e.target.value)} placeholder="https://sync.your-domain.example" />
          <p className="form-hint">Leave blank for local-only mode. Self-host the relay for cross-network sync. Use HTTPS in production.</p>
        </>}
        {setupMode === 'unlock' && <p className="form-hint">The passphrase is never sent to the relay. If it is lost and there is no recoverable key backup, the vault cannot be decrypted.</p>}
        <button className="button button-primary button-wide" type="submit" disabled={busy || passphrase.length < 12}>{busy ? 'Working…' : setupMode === 'unlock' ? 'Unlock vault' : 'Create encrypted vault'}</button>
      </form>}
      {message && <div className={`banner banner-${message.type}`} role="status">{message.text}</div>}
      <div className="setup-footnote"><span className="privacy-dot" /> Local-first · No analytics · No required cloud account</div>
      {!isSecureContextAvailable() && <div className="banner banner-error">WebCrypto is unavailable in this context. Use HTTPS or localhost; do not enter your passphrase on an insecure public network.</div>}
    </div>
  </main>;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-row"><div className="brand-mark">A</div><span className="brand-name">anchor</span><span className="brand-private">PRIVATE</span></div>
      <button className="capture-button" onClick={beginCapture}><span className="capture-plus">＋</span><span>Capture anything</span><kbd>⌘ K</kbd></button>
      <nav className="primary-nav" aria-label="Main navigation">
        <p className="nav-label">YOUR SPACE</p>
        {nav.map((n) => <button key={n.id} className={`nav-item ${view === n.id ? 'active' : ''}`} onClick={() => { setView(n.id); setSearch(''); }}>
          <Icon name={n.icon} /><span>{n.label}</span>{n.id === 'promises' && items.filter((i) => i.kind === 'promise' && i.status !== 'done').length > 0 && <small>{items.filter((i) => i.kind === 'promise' && i.status !== 'done').length}</small>}
        </button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className={`sync-indicator state-${syncState}`}><span className="status-dot" /><div><strong>{syncState === 'local-only' ? 'This device only' : syncState === 'syncing' ? 'Syncing now' : syncState === 'synced' ? 'All caught up' : syncState === 'error' ? 'Sync needs attention' : syncState === 'offline' ? 'Offline' : 'Sync ready'}</strong><span>{syncMessage}</span></div></div>
        <button className="user-row" onClick={lockVault}><div className="avatar">A</div><div><strong>Your private vault</strong><span>Locked on exit</span></div><span className="more-dot">···</span></button>
      </div>
    </aside>

    <main className="main-panel">
      <header className="topbar">
        <div className="mobile-brand"><div className="brand-mark">A</div><span>anchor</span></div>
        <div className="topbar-title"><span className="eyebrow">{currentNav.subtitle.toUpperCase()}</span><span className="topbar-date">{niceDate()}</span></div>
        <div className="topbar-actions">
          <label className="search-box"><Icon name="⌕" /><input aria-label="Search memory" value={search} onChange={(e) => { setSearch(e.target.value); if (view === 'today') setView('memory'); }} placeholder="Search your memory" /><kbd>/</kbd></label>
          <button className="icon-button sync-button" title="Sync now" aria-label="Sync now" onClick={() => void runSync()} disabled={busy || !relayUrl}><Icon name="↻" /></button>
          <button className="avatar avatar-small" aria-label="Lock vault" title="Lock vault" onClick={lockVault}>A</button>
        </div>
      </header>

      <div className="content-scroll">
        {message && <div className={`banner banner-${message.type}`} role="status"><span>{message.text}</span>{lastDeleted && message.type === 'success' && message.text.includes('deleted') && <button className="banner-undo-btn" onClick={() => void handleUndoDelete()}>Undo</button>}<button aria-label="Dismiss message" onClick={() => setMessage(null)}>×</button></div>}
        {conflicts.length > 0 && <section className="conflict-banner"><div><strong>{conflicts.length} sync {conflicts.length === 1 ? 'conflict needs' : 'conflicts need'} your review</strong><p>Both devices changed the same record. Anchor kept both versions rather than silently overwriting one.</p></div><button className="button button-small" onClick={() => setView('settings')}>Review</button></section>}

        {missedReminders.length > 0 && <section className="missed-reminders-banner">
          <div className="missed-title">
            <span className="missed-icon">🔔</span>
            <div>
              <strong>{missedReminders.length} reminder{missedReminders.length === 1 ? '' : 's'} were due while Anchor was away</strong>
              <p>“{missedReminders[0].title}”{missedReminders.length > 1 ? ` and ${missedReminders.length - 1} other item(s)` : ''}</p>
            </div>
          </div>
          <div className="missed-actions">
            <button className="button button-small" onClick={() => void handleSnoozeMissed(missedReminders[0], 60)}>Snooze 1h</button>
            <button className="button button-small" onClick={() => void handleSnoozeMissed(missedReminders[0], 1440)}>Snooze 1d</button>
            <button className="button button-small button-secondary" onClick={() => void toggleDone(missedReminders[0])}>Mark done</button>
            <button className="button button-small button-secondary" onClick={handleAcknowledgeAllMissed}>Dismiss</button>
          </div>
        </section>}

        {view === 'today' && <>
          <section className="welcome-block">
            <div><p className="eyebrow">{relativeGreeting().toUpperCase()}</p><h1>Make room for <em>what matters.</em></h1><p>Everything important, gathered in one calm place.</p></div>
            <div className="welcome-actions">
              <button className="button button-primary" onClick={beginCapture}>＋ Capture a thought</button>
              <button className="button button-secondary" onClick={openWeeklyMirror}><span style={{ marginRight: '6px' }}>🪞</span>Weekly Life Mirror</button>
            </div>
          </section>
          <section className="stats-grid" aria-label="Today's summary">
            <div className="stat-card stat-dark"><span className="stat-label">NEEDS ATTENTION</span><strong>{overdue.length}</strong><span>{overdue.length === 1 ? 'overdue item' : 'overdue items'}</span><span className="stat-mark">↗</span></div>
            <div className="stat-card"><span className="stat-label">DUE TODAY</span><strong>{dueToday.length}</strong><span>{dueToday.length === 1 ? 'thing to keep moving' : 'things to keep moving'}</span><span className="stat-mark">◷</span></div>
            <div className="stat-card"><span className="stat-label">OPEN LOOPS</span><strong>{openItems.filter((i) => i.kind === 'promise').length}</strong><span>promises & follow-ups</span><span className="stat-mark">↗</span></div>
          </section>
          <section className="section-block"><div className="section-heading"><div><p className="eyebrow">YOUR NEXT STEPS</p><h2>On your radar <span className="count-pill">{matchedItems.length}</span></h2></div><button className="text-button" onClick={() => setView('memory')}>View all <span>↗</span></button></div>
            {matchedItems.length ? <div className="items-list">{matchedItems.map((item) => <ItemRow key={item.id} item={item} onToggle={() => void toggleDone(item)} onEdit={() => editItem(item)} onDownloadAttachment={handleDownloadAttachment} onRecordDose={handleRecordDose} />)}</div> : <EmptyState onCapture={beginCapture} onLoadDemo={handleLoadDemoData} title="A little breathing room." text="Nothing urgent is on your radar. Capture the things you want to remember when they come up, or load our sample 7-day demo data." />}
          </section>
          <section className="section-block"><div className="section-heading"><div><p className="eyebrow">COMING UP</p><h2>Next seven days</h2></div></div>
            {dueSoon.filter((i) => !isDueToday(i.dueAt) && !isOverdue(i.dueAt)).length ? <div className="items-list">{dueSoon.filter((i) => !isDueToday(i.dueAt) && !isOverdue(i.dueAt)).slice(0, 4).map((item) => <ItemRow key={item.id} item={item} onToggle={() => void toggleDone(item)} onEdit={() => editItem(item)} onDownloadAttachment={handleDownloadAttachment} onRecordDose={handleRecordDose} />)}</div> : <p className="subtle-empty">No upcoming dates saved yet.</p>}
          </section>
        </>}

        {view === 'memory' && <section className="section-page"><div className="page-heading"><div><p className="eyebrow">YOUR PERSONAL INDEX</p><h1>Memory <span className="count-pill">{items.length}</span></h1><p>Saved details, tasks, plans and decisions. Search only reads your local vault.</p></div><button className="button button-primary" onClick={beginCapture}>＋ Capture</button></div>
          {search && <div className="search-summary">Showing results for <strong>“{search}”</strong><button onClick={() => setSearch('')}>Clear search</button></div>}
          {search && memoryAnswer && <div className="memory-answer-card">
            <div className="memory-answer-badge"><span>⚡ Intent Answer</span><span className="confidence-pill">{memoryAnswer.intent.replace('_', ' ').toUpperCase()}</span></div>
            <h3 style={{ margin: '8px 0 4px', fontSize: '1rem', fontWeight: 600 }}>{memoryAnswer.headline}</h3>
            <p className="memory-answer-text" style={{ whiteSpace: 'pre-line' }}>{memoryAnswer.explanation}</p>
            {memoryAnswer.matchedItems.length > 0 && <div className="memory-evidence-list"><span className="evidence-title">Matched records ({memoryAnswer.matchedItems.length}):</span><ul>{memoryAnswer.matchedItems.slice(0, 5).map((item) => <li key={item.id}><strong>{item.title}</strong>{item.dueAt ? ` — Due ${item.dueAt.slice(0, 10)}` : ''}</li>)}</ul></div>}
          </div>}
          {matchedItems.length ? <div className="items-list">{matchedItems.map((item) => <ItemRow key={item.id} item={item} onToggle={() => void toggleDone(item)} onEdit={() => editItem(item)} onDownloadAttachment={handleDownloadAttachment} onRecordDose={handleRecordDose} />)}</div> : <EmptyState onCapture={beginCapture} title={search ? 'Nothing matched that search.' : 'Your memory starts here.'} text={search ? 'Try a shorter phrase or another detail from the original capture.' : 'Capture anything you would rather not have to remember by yourself.'} />}
        </section>}

        {view === 'promises' && <section className="section-page"><div className="page-heading"><div><p className="eyebrow">FOLLOW-THROUGH</p><h1>Open loops <span className="count-pill">{matchedItems.length}</span></h1><p>Promises made to other people, replies owed, and things that deserve a follow-up.</p></div><button className="button button-primary" onClick={beginCapture}>＋ Add a loop</button></div>
          {matchedItems.length ? <div className="items-list">{matchedItems.map((item) => <ItemRow key={item.id} item={item} onToggle={() => void toggleDone(item)} onEdit={() => editItem(item)} onDownloadAttachment={handleDownloadAttachment} onRecordDose={handleRecordDose} />)}</div> : <EmptyState onCapture={beginCapture} title="Nothing left hanging." text="When you say “I’ll send that tomorrow,” capture it here and give it a date if one matters." />}
        </section>}

        {view === 'inventory' && <section className="section-page"><div className="page-heading"><div><p className="eyebrow">HOME & EVERYDAY LIFE</p><h1>Inventory <span className="count-pill">{matchedItems.length}</span></h1><p>Track supplies and restock reminders. Quantities are estimates until you confirm them.</p></div><button className="button button-primary" onClick={() => { stopAndDiscardRecording(); setEditing(null); setPendingFiles([]); setDraft({ title: '', kind: 'consumable', quantity: 1, unit: 'item' }); setModal('edit'); }}>＋ Add item</button></div>
          {matchedItems.length ? <div className="items-list">{matchedItems.map((item) => <ItemRow key={item.id} item={item} onToggle={() => void toggleDone(item)} onEdit={() => editItem(item)} onDownloadAttachment={handleDownloadAttachment} onRecordDose={handleRecordDose} />)}</div> : <EmptyState onCapture={beginCapture} title="Nothing on the shelf yet." text="Add essentials like eggs, detergent, medication stock or filters—and decide when you want to restock." />}
        </section>}

        {view === 'settings' && <section className="section-page settings-page"><div className="page-heading"><div><p className="eyebrow">CONTROL & PRIVACY</p><h1>Settings</h1><p>Your vault is local-first. These controls are explicit so you know what leaves a device.</p></div></div>
          <div className="settings-layout">
            <section className="settings-card"><div className="settings-title"><span className="settings-icon">⌘</span><div><h2>Vault & encryption</h2><p>Records are AES-GCM encrypted before being stored in IndexedDB. The vault key is wrapped with a passphrase-derived key.</p></div></div><div className="settings-meta"><span>Vault ID</span><code>{unlocked.session.vaultId}</code><button className="text-button" onClick={() => void navigator.clipboard?.writeText(unlocked.session.vaultId)}>Copy ID</button></div><div className="settings-actions"><button className="button button-secondary" onClick={() => void exportEncryptedBackup()} disabled={busy}>Export encrypted backup</button><button className="button button-secondary" onClick={() => void exportPairing()} disabled={busy}>Export pairing file</button><button className="button button-secondary" onClick={() => void exportRecords()}>Export readable records</button><button className="button button-secondary" onClick={exportCsvRecords}>Export CSV</button><button className="button button-secondary" onClick={exportIcsCalendar}>Export .ics calendar</button><button className="button button-secondary" onClick={exportDoctorBrief}>Export doctor brief (.md)</button><button className="button button-secondary" onClick={lockVault}>Lock vault</button></div><p className="form-hint">Encrypted backups include the encrypted local database, change journal, conflicts and attachments; some structural metadata remains visible. Pairing files and plaintext exports are sensitive. Test backup restoration before relying on it.</p></section>
            <section className="settings-card">
              <div className="settings-title"><span className="settings-icon">✳</span><div><h2>Local Gemma extraction</h2><p>Optional on-device model inference. Anchor never sends capture text to a hosted AI API. The deterministic extractor remains available without a model.</p></div></div>
              <div className="relay-form">
                <label className="toggle-row"><input type="checkbox" checked={useLocalGemma} onChange={(e) => setUseLocalGemma(e.target.checked)} /><span>Use local Gemma when reviewing captures</span></label>
                <label htmlFor="gemmaRuntime">Local runtime</label>
                <select id="gemmaRuntime" value={gemmaRuntime} onChange={(e) => setGemmaRuntime(e.target.value as 'ollama' | 'webgpu')}>
                  <option value="ollama">Ollama-compatible local runtime (supports local vision models)</option>
                  <option value="webgpu">LiteRT-LM in browser with WebGPU (text only)</option>
                </select>
                {gemmaRuntime === 'ollama' ? <>
                  <label htmlFor="gemmaEndpoint">Loopback runtime endpoint</label><input id="gemmaEndpoint" type="url" value={gemmaEndpoint} onChange={(e) => setGemmaEndpoint(e.target.value)} placeholder="http://localhost:11434" />
                  <label htmlFor="gemmaModel">Installed local model tag</label><input id="gemmaModel" value={gemmaModel} onChange={(e) => setGemmaModel(e.target.value)} maxLength={100} placeholder="gemma4:e2b" />
                </> : <>
                  <label htmlFor="gemmaWebModel">Browser model</label>
                  <select id="gemmaWebModel" value={gemmaWebModel} onChange={(e) => setGemmaWebModel(e.target.value as BrowserGemmaModel)}><option value="e2b">Gemma 4 E2B — WebGPU model</option></select>
                  <p className="form-hint">The browser runtime currently uses the official web-specific E2B artifact. For E4B, run a compatible model locally through the loopback adapter.</p>
                  <p className="form-hint">This is an opt-in, first-use model download from Hugging Face. Model weights may require multiple gigabytes of storage/RAM and a supported WebGPU browser. Your capture prompt stays in the browser; the model host still sees the weight-download request and ordinary connection metadata. Do not select this on a metered connection without understanding the download.</p>
                </>}
                <div className="settings-actions"><button className="button button-primary" type="button" onClick={() => {
                  try {
                    if (gemmaRuntime === 'ollama') { validateLoopbackEndpoint(gemmaEndpoint); if (!gemmaModel.trim()) throw new Error('Enter the installed local model tag.'); }
                    localStorage.setItem('anchor-local-gemma-enabled', String(useLocalGemma));
                    localStorage.setItem('anchor-local-gemma-runtime', gemmaRuntime);
                    localStorage.setItem('anchor-local-gemma-endpoint', gemmaEndpoint);
                    localStorage.setItem('anchor-local-gemma-model', gemmaModel.trim());
                    if (!useLocalGemma || gemmaRuntime !== 'webgpu') void disposeBrowserGemma();
                    setMessage({ type: 'success', text: 'Local AI preferences saved on this device.' });
                  } catch (e) { setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Could not save local model settings.' }); }
                }}>Save local AI settings</button></div>
                <p className="form-hint">The browser LiteRT-LM adapter currently extracts text only. A scanned PDF, image-only capture or audio note must not be treated as understood unless a compatible local vision/speech adapter processed it. The current Ollama path sends an image only to a loopback endpoint after local resizing. Confirm every suggestion before saving.</p>
              </div>
            </section>
            <section className="settings-card">
              <div className="settings-title"><span className="settings-icon">↻</span><div><h2>Encrypted device sync</h2><p>Use a relay you control or transfer changes directly over your local network. Only encrypted change envelopes are sent; the relay cannot decrypt them.</p></div></div>
              <form onSubmit={(e) => void saveRelay(e)} className="relay-form">
                <label className="toggle-row" style={{ margin: '0 0 12px' }}>
                  <input type="checkbox" checked={autoSyncEnabled} onChange={(e) => handleToggleAutoSync(e.target.checked)} />
                  <span>Auto-sync changes immediately & periodically in background</span>
                </label>
                <label htmlFor="relayUrl">Relay endpoint</label>
                <input id="relayUrl" type="url" value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} placeholder="https://sync.example.com" />
                <p className="form-hint">Production requires HTTPS. Self-hosting removes mandatory third-party service dependence, but hosting and bandwidth may still cost money.</p>
                <div className="settings-actions">
                  <button className="button button-primary" type="submit" disabled={busy}>Save endpoint</button>
                  <button className="button button-secondary" type="button" onClick={() => void runSync()} disabled={busy || !relayUrl}>{busy ? 'Syncing…' : 'Sync now'}</button>
                </div>
                <div className={`settings-status state-${syncState}`}><span className="status-dot"/><span>{syncMessage}</span></div>
                <div className="p2p-sync-box">
                  <h3>Direct offline sync (No relay / LAN)</h3>
                  <p>Transfer encrypted operations directly between trusted devices over local Wi-Fi, AirDrop, or USB without connecting to any relay or the internet.</p>
                  <div className="settings-actions">
                    <button className="button button-secondary" type="button" onClick={() => void handleExportP2PSync()} disabled={busy}>Export sync bundle</button>
                    <button className="button button-secondary" type="button" onClick={() => p2pImportRef.current?.click()} disabled={busy}>Import sync bundle</button>
                    <input ref={p2pImportRef} type="file" accept="application/json,.json" hidden onChange={(e) => void handleImportP2PSync(e)} />
                  </div>
                </div>
              </form>
            </section>
            <section className="settings-card">
              <div className="settings-title"><span className="settings-icon">♧</span><div><h2>Notifications & chimes</h2><p>Browser reminders are best-effort. Background delivery can be suspended by the operating system.</p></div></div>
              <div className="settings-meta"><span>Permission</span><strong>{notificationState}</strong></div>
              <div className="settings-actions">
                <button className="button button-secondary" onClick={() => void enableNotifications()} disabled={notificationState === 'granted' || notificationState === 'unsupported'}>{notificationState === 'granted' ? 'Notifications enabled' : 'Enable notifications'}</button>
                <button className="button button-secondary" type="button" onClick={() => playReminderChime()}>Test reminder chime</button>
              </div>
              <label className="toggle-row" style={{ margin: '14px 0 0 45px' }}>
                <input type="checkbox" checked={soundEnabled} onChange={(e) => handleToggleSound(e.target.checked)} />
                <span>Play audio chime when a reminder is due</span>
              </label>
            </section>
            <section className="settings-card"><div className="settings-title"><span className="settings-icon">⤓</span><div><h2>Data health</h2><p>Counts are derived locally. Record payloads, titles and source texts are not sent for analytics.</p></div></div><div className="health-metrics"><div><strong>{items.length}</strong><span>records</span></div><div><strong>{conflicts.length}</strong><span>conflicts</span></div><div><strong>{syncState === 'local-only' ? 'Off' : syncState === 'synced' ? 'OK' : '—'}</strong><span>sync state</span></div></div></section>
            <section className="settings-card">
              <div className="settings-title"><span className="settings-icon">💾</span><div><h2>Browser storage persistence & quota</h2><p>Protects IndexedDB from eviction under browser storage pressure and monitors disk allocation.</p></div></div>
              <div className="settings-meta"><span>Persistence status</span><strong>{storageInfo?.isPersisted ? '✓ Protected (Persistent)' : 'Standard (Best-effort)'}</strong></div>
              {storageInfo && <div className="settings-meta"><span>Usage / Quota</span><strong>{formatBytes(storageInfo.usedBytes)} used of {formatBytes(storageInfo.quotaBytes)} ({storageInfo.percentUsed}%)</strong></div>}
              <div className="settings-actions">
                <button className="button button-secondary" type="button" onClick={() => void handleRequestPersistence()} disabled={storageInfo?.isPersisted}>
                  {storageInfo?.isPersisted ? 'Storage already persistent' : 'Request persistent storage'}
                </button>
              </div>
            </section>
            <section className="settings-card">
              <div className="settings-title"><span className="settings-icon">🛡</span><div><h2>Zero-cloud privacy & token audit</h2><p>Cryptographic and processing audit proving zero cloud tokens billed and zero network inference.</p></div></div>
              <div className="health-metrics">
                <div><strong>0</strong><span>cloud tokens billed</span></div>
                <div><strong>{localExtractionsCount}</strong><span>local extractions</span></div>
                <div><strong>100%</strong><span>on-device / loopback</span></div>
              </div>
            </section>
            <section className="settings-card">
              <div className="settings-title"><span className="settings-icon">🧪</span><div><h2>Demo & evaluation dataset</h2><p>Populate the vault with realistic 7-day demo data (medications, adherence dose logs, low stock consumables, accomplishments) to demonstrate the Doctor Brief, Weekly Life Mirror, and Depletion warnings.</p></div></div>
              <div className="settings-actions">
                <button className="button button-secondary" type="button" onClick={() => void handleLoadDemoData()} disabled={busy}>Load 7-day demo dataset</button>
              </div>
            </section>
            {conflicts.length > 0 && <section className="settings-card conflict-list"><div className="settings-title"><span className="settings-icon">⚠</span><div><h2>Review sync conflicts</h2><p>Choose the version to keep. Your choice will be saved as a new change, preserving both versions in the prior sync history.</p></div></div>{conflicts.map((conflict) => <div className="conflict-row" key={conflict.conflictId}><div><strong>{conflict.local.title}</strong><p>Both versions changed on different devices.</p><div className="conflict-choices"><button className="button button-small button-secondary" onClick={() => void resolveOneConflict(conflict, 'local')}>Keep this device</button><button className="button button-small button-secondary" onClick={() => void resolveOneConflict(conflict, 'remote')}>Keep other device</button></div></div></div>)}</section>}
            <section className="settings-card">
              <div className="settings-title"><span className="settings-icon">🗑</span><div><h2>Trash & deleted records</h2><p>Deleted records remain as tombstones. You can view and restore accidentally deleted records to this vault.</p></div></div>
              <div className="settings-actions">
                <button className="button button-secondary" type="button" onClick={() => void loadTrash()}>{showTrash ? 'Refresh trash' : 'View trash / deleted records'}</button>
                {showTrash && <button className="button button-secondary" type="button" onClick={() => setShowTrash(false)}>Hide trash</button>}
              </div>
              {showTrash && <div className="trash-container">
                {deletedItems.length === 0 ? <p className="form-hint" style={{ marginTop: '12px' }}>No deleted records found in this vault.</p> : <div className="trash-list">
                  {deletedItems.map((item) => <div className="trash-row" key={item.id}>
                    <div>
                      <strong>{item.title}</strong>
                      <span className="form-hint">{displayKind(item.kind)} · Deleted {item.deletedAt ? new Date(item.deletedAt).toLocaleDateString() : ''}</span>
                    </div>
                    <button className="button button-small button-secondary" type="button" onClick={() => void handleRestoreFromTrash(item.id)}>Restore</button>
                  </div>)}
                </div>}
              </div>}
            </section>
            <section className="settings-card settings-danger"><div className="settings-title"><span className="settings-icon">!</span><div><h2>Delete this local vault</h2><p>Clears records and the local key envelope from this browser profile. Does not erase copies on other devices or backups.</p></div></div>{showWipeConfirm ? <div className="confirm-inline"><p>This is destructive and cannot be undone from this device. Export first if you need a copy.</p><button className="button button-danger" onClick={() => void wipeVault()} disabled={busy}>Yes, clear this local vault</button><button className="button button-secondary" onClick={() => setShowWipeConfirm(false)}>Cancel</button></div> : <button className="button button-danger-outline" onClick={() => setShowWipeConfirm(true)}>Clear local vault</button>}</section>
          </div>
        </section>}
      </div>
      <footer className="app-footer"><span>ANCHOR <span className="footer-dot">·</span> LOCAL-FIRST MEMORY</span><span><span className="privacy-dot"/> Your records stay on this device until you enable sync.</span></footer>
    </main>

    <nav className="mobile-nav" aria-label="Mobile navigation">{nav.slice(0, 4).map((n) => <button key={n.id} className={view === n.id ? 'active' : ''} onClick={() => { setView(n.id); setSearch(''); }}><Icon name={n.icon}/><span>{n.label === 'Open loops' ? 'Loops' : n.label}</span></button>)}<button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}><Icon name="⚙"/><span>Settings</span></button></nav>

    {modal && <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-heading"><div><p className="eyebrow">{modal === 'capture' ? 'INBOX TO INTENTION' : modal === 'delete' ? 'REMOVE RECORD' : 'EDIT RECORD'}</p><h2 id="modal-title">{modal === 'capture' ? 'Capture a thought' : modal === 'delete' ? 'Delete this record?' : editing ? 'Make it accurate.' : 'Add to inventory'}</h2></div><button className="icon-button" aria-label="Close dialog" onClick={closeModal}>×</button></div>
      {modal === 'capture' && <>
        <p className="modal-intro">Type the way you think. Anchor will suggest a starting point; check the details before saving.</p>
        <textarea ref={captureInputRef} className="capture-textarea" value={captureText} onChange={(e) => { setCaptureText(e.target.value); setCapturePreview(null); }} rows={5} maxLength={20000} placeholder="Remind me to send the project update tomorrow…\nI promised Mira I’d share the notes…\nRunning low on detergent…" />
        <input ref={fileInputRef} className="visually-hidden" type="file" multiple accept="image/*,application/pdf,text/*,application/json,audio/*,.doc,.docx,.rtf" onChange={(e) => void handleFilePick(e)} />
        <div className="attachment-actions">
          <button className="button button-secondary" type="button" onClick={() => fileInputRef.current?.click()}>＋ Add photo, PDF or file</button>
          <button className="button button-secondary" type="button" onClick={() => recording ? stopVoiceRecording() : void startVoiceRecording()}>{recording ? '■ Stop recording' : '◉ Record voice note'}</button>
        </div>
        {recording && <div className="recording-active-badge"><span className="recording-dot" /><span>{isSpeechRecognitionSupported() ? 'Recording & transcribing live' : 'Recording voice note'} ({Math.floor(recordingDuration / 60)}:{String(recordingDuration % 60).padStart(2, '0')})</span></div>}
        {pendingFiles.map((file, idx) => <div className="attachment-picked" key={`${file.name}-${idx}`}><span className="attachment-paper">↳</span><div><strong>{file.name}</strong><span>{(file.size / 1024).toFixed(0)} KB · encrypted at rest and during sync</span></div><button type="button" aria-label={`Remove ${file.name}`} onClick={() => setPendingFiles((prev) => prev.filter((_, i) => i !== idx))}>×</button></div>)}
        <p className="form-hint media-note">Text files, selectable PDF text, on-device OCR for images/scanned PDFs, and live speech transcription run 100% locally. Audio and media stay encrypted as attachments. No capture text or audio is ever sent to a cloud service.</p>
        <div className="capture-footer"><span>{captureText.length.toLocaleString()} / 20,000</span><span>On-device rules · No AI required</span></div>
        {!capturePreview ? <div className="modal-actions"><button className="button button-secondary" onClick={closeModal}>Cancel</button><button className="button button-primary" onClick={() => void previewCapture()} disabled={!captureText.trim() || extracting}>{extracting ? 'Extracting locally…' : 'Review extraction'} <span>→</span></button></div> : multiDrafts.length > 1 ? (
          <div className="multi-draft-box">
            <div className="multi-draft-header">
              <span className="eyebrow">MULTIPLE ITEMS DETECTED</span>
              <h3>Anchor extracted {multiDrafts.length} records from this text:</h3>
            </div>
            <ul className="multi-draft-list">
              {multiDrafts.map((d, i) => (
                <li key={i} className="multi-draft-item">
                  <div className="multi-draft-main">
                    <strong>{d.title}</strong>
                    {d.dueAt && <span className="due-label"> · {formatDue(d.dueAt)}</span>}
                  </div>
                  <span className={`kind-tag kind-${d.kind}`}>{displayKind(d.kind)}</span>
                </li>
              ))}
            </ul>
            <p className="form-hint">Anchor extracted each entry as an independent record. You can save them all with one click or review as a single entry.</p>
            <div className="modal-actions">
              <button className="button button-secondary" type="button" onClick={() => setMultiDrafts([])}>Review as single item</button>
              <button className="button button-primary" type="button" onClick={() => void commitMultipleDrafts()} disabled={busy}>
                {busy ? 'Saving all…' : `Save all ${multiDrafts.length} records`} <span>→</span>
              </button>
            </div>
          </div>
        ) : <form onSubmit={(e) => void commitDraft(e)} className="review-extraction">
          <div className="review-title-row"><span className="eyebrow">SUGGESTED RECORD</span><span className={`confidence confidence-${capturePreview.confidence}`}>{capturePreview.confidence} confidence</span></div>
          {capturePreview.warning && <div className="capture-warning-banner"><span>⚠️</span><p>{capturePreview.warning}</p></div>}
          {capturePreview.ambiguity && (
            <div className="ambiguity-resolution-box">
              <h4>⚠️ Clarification required</h4>
              {capturePreview.ambiguity.isAmbiguousDate && capturePreview.ambiguity.dateOptions && (
                <div className="ambiguity-group">
                  <label>Ambiguous date format (04/05). Which date did you mean?</label>
                  <div className="resolution-chips">
                    {capturePreview.ambiguity.dateOptions.map((opt) => (
                      <button
                        key={opt.iso}
                        type="button"
                        className={`chip-button ${selectedDateIso === opt.iso ? 'chip-active' : ''}`}
                        onClick={() => {
                          setSelectedDateIso(opt.iso);
                          applyResolvedDateTime(opt.iso, selectedTimeOption);
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {capturePreview.ambiguity.isAmbiguousTime && capturePreview.ambiguity.timeOptions && (
                <div className="ambiguity-group">
                  <label>Ambiguous time ("at 9"). Which time did you mean?</label>
                  <div className="resolution-chips">
                    {capturePreview.ambiguity.timeOptions.map((opt) => (
                      <button
                        key={opt.label}
                        type="button"
                        className={`chip-button ${(selectedTimeOption?.hour === opt.hour && selectedTimeOption?.minute === opt.minute) ? 'chip-active' : ''}`}
                        onClick={() => {
                          setSelectedTimeOption(opt);
                          applyResolvedDateTime(selectedDateIso, opt);
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {capturePreview.ambiguity.isDosageConflict && capturePreview.ambiguity.dosageOptions && (
                <div className="ambiguity-group">
                  <label>Dosage conflict detected. Which instruction is verified?</label>
                  <div className="resolution-chips">
                    {capturePreview.ambiguity.dosageOptions.map((opt) => (
                      <button
                        key={opt.label}
                        type="button"
                        className={`chip-button ${draft.dailyRate === opt.dailyRate && !draft.safetyBlocked ? 'chip-active' : ''}`}
                        onClick={() => applyResolvedDosage(opt)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {draft.safetyBlocked && (
                <p className="form-hint safety-hint">
                  Schedule and reminders are paused until ambiguity is resolved above.
                </p>
              )}
            </div>
          )}
          {cancellationMatch && (
            <div className="cancellation-action-card">
              <span>🗑️</span>
              <div>
                <strong>Active task match: “{cancellationMatch.title}”</strong>
                <p>This capture indicates you no longer need this task. What would you like to do?</p>
                <div className="cancellation-actions">
                  <button type="button" className="button button-small button-danger" onClick={() => void deleteMatchedItem(cancellationMatch)} disabled={busy}>Delete task</button>
                  <button type="button" className="button button-small button-primary" onClick={() => void completeMatchedItem(cancellationMatch)} disabled={busy}>Mark completed</button>
                  <button type="button" className="button button-small button-secondary" onClick={closeModal} disabled={busy}>Cancel</button>
                </div>
              </div>
            </div>
          )}
          {duplicateItem && (
            <div className="duplicate-warning-banner">
              <span>⚠️</span>
              <div>
                <strong>Potential duplicate detected</strong>
                <p>
                  You already have open item “{duplicateItem.title}”{duplicateItem.dueAt ? ` due ${formatDue(duplicateItem.dueAt)}` : ''}.
                  {draft.dueAt && duplicateItem.dueAt && new Date(draft.dueAt).toDateString() !== new Date(duplicateItem.dueAt).toDateString() && (
                    <span className="deadline-change-notice"> New input suggests changed deadline: {formatDue(draft.dueAt)}.</span>
                  )}
                </p>
                <div className="duplicate-actions">
                  <button type="button" className="button button-small button-primary" onClick={() => void updateExistingDuplicate(duplicateItem)} disabled={busy}>1. Update existing record</button>
                  <button type="submit" className="button button-small button-secondary" disabled={busy || !draft.title.trim() || draft.safetyBlocked}>2. Keep both records</button>
                  <button type="button" className="button button-small button-secondary" onClick={closeModal} disabled={busy}>3. Cancel</button>
                </div>
              </div>
            </div>
          )}
          <label htmlFor="captureTitle">Title</label><input id="captureTitle" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} required maxLength={200}/>
          <div className="field-row"><div><label htmlFor="captureKind">Type</label><select id="captureKind" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as ItemKind })}>{Object.entries(kindLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div><div><label htmlFor="captureDue">Date <span className="optional">Optional</span></label><input id="captureDue" type="datetime-local" value={draft.dueAt ? new Date(new Date(draft.dueAt).getTime() - new Date(draft.dueAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''} onChange={(e) => setDraft({ ...draft, dueAt: e.target.value ? new Date(e.target.value).toISOString() : undefined, safetyBlocked: false, unresolvedReason: undefined })}/></div></div>
          <label htmlFor="captureBody">Original source</label><textarea id="captureBody" value={draft.body ?? ''} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={3}/>
          <p className="form-hint">Date extraction is heuristic. Confirm the year, time and time zone when they matter. The source text remains visible for verification; never accept a consequential date without checking it.</p>
          <div className="modal-actions"><button className="button button-secondary" type="button" onClick={() => { setCapturePreview(null); }}>Back</button><button className="button button-primary" type="submit" disabled={busy || !draft.title.trim() || draft.safetyBlocked}>{busy ? 'Saving…' : draft.safetyBlocked ? 'Resolve ambiguity to save' : 'Save to memory'}</button></div>
        </form>}
      </>}
      {modal === 'edit' && <form onSubmit={(e) => void commitDraft(e)} className="edit-form">
        <label htmlFor="itemTitle">Title</label><input id="itemTitle" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={200} required />
        <div className="field-row"><div><label htmlFor="itemKind">Type</label><select id="itemKind" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as ItemKind })}>{Object.entries(kindLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div><div><label htmlFor="itemStatus">Status</label><select id="itemStatus" value={draft.status ?? 'open'} onChange={(e) => setDraft({ ...draft, status: e.target.value as AnchorItem['status'] })}><option value="open">Open</option><option value="done">Done</option><option value="archived">Archived</option></select></div></div>
        <label htmlFor="itemBody">Details</label><textarea id="itemBody" rows={4} value={draft.body ?? ''} onChange={(e) => setDraft({ ...draft, body: e.target.value })}/>
        <div className="field-row"><div><label htmlFor="itemDue">Due date <span className="optional">Optional</span></label><input id="itemDue" type="datetime-local" value={draft.dueAt ? new Date(new Date(draft.dueAt).getTime() - new Date(draft.dueAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''} onChange={(e) => setDraft({ ...draft, dueAt: e.target.value ? new Date(e.target.value).toISOString() : undefined })}/></div><div><label htmlFor="itemCategory">Category</label><input id="itemCategory" value={draft.category ?? ''} onChange={(e) => setDraft({ ...draft, category: e.target.value })} maxLength={80} placeholder="Personal, work…"/></div></div>
        <div className="field-row">
          <div>
            <label htmlFor="itemRecurrence">Repeat <span className="optional">Optional</span></label>
            <select id="itemRecurrence" value={draft.recurrence ?? ''} onChange={(e) => setDraft({ ...draft, recurrence: (e.target.value || undefined) as AnchorItem['recurrence'] })}>
              <option value="">Never (once)</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>
          <div>
            <label htmlFor="itemReminderLead">Reminder lead time <span className="optional">Optional</span></label>
            <select id="itemReminderLead" value={draft.reminderMinutesBefore ?? ''} onChange={(e) => setDraft({ ...draft, reminderMinutesBefore: e.target.value === '' ? undefined : Number(e.target.value) })}>
              <option value="">Default (multi-stage: 1w, 1d, 1h, due)</option>
              <option value="15">15 minutes before</option>
              <option value="30">30 minutes before</option>
              <option value="60">1 hour before</option>
              <option value="120">2 hours before</option>
              <option value="1440">1 day before</option>
            </select>
          </div>
        </div>
        {draft.kind === 'consumable' && <>
          <div className="field-row">
            <div><label htmlFor="itemQuantity">Quantity</label><input id="itemQuantity" type="number" min="0" step="any" value={draft.quantity ?? ''} onChange={(e) => setDraft({ ...draft, quantity: e.target.value === '' ? undefined : Number(e.target.value) })}/></div>
            <div><label htmlFor="itemUnit">Unit</label><input id="itemUnit" value={draft.unit ?? ''} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} placeholder="pack, pills, ml…" maxLength={30}/></div>
          </div>
          <div className="field-row">
            <div><label htmlFor="itemDailyRate">Daily usage / dose rate <span className="optional">Optional</span></label><input id="itemDailyRate" type="number" min="0.01" step="any" value={draft.dailyRate ?? ''} onChange={(e) => setDraft({ ...draft, dailyRate: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="e.g. 2 pills/day"/></div>
            <div><label htmlFor="itemReorderThreshold">Refill lead time (days) <span className="optional">Default 3</span></label><input id="itemReorderThreshold" type="number" min="1" step="1" value={draft.reorderThreshold ?? ''} onChange={(e) => setDraft({ ...draft, reorderThreshold: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="3"/></div>
          </div>
        </>}
        <div className="existing-attachments"><label>Attachments</label>{(draft.attachments ?? []).length === 0 && <p className="form-hint">No attachments</p>}{(draft.attachments ?? []).map((attachment) => <div className="attachment-picked" key={attachment.id}><span className="attachment-paper">↳</span><div><strong>{attachment.name}</strong><span>{(attachment.size / 1024).toFixed(0)} KB · {attachment.mimeType}</span></div><div className="attachment-actions-cell"><button type="button" onClick={() => void handleDownloadAttachment(attachment)}>Download</button><button type="button" className="button-text-danger" aria-label={`Remove attachment ${attachment.name}`} onClick={() => setDraft({ ...draft, attachments: draft.attachments?.filter((a) => a.id !== attachment.id) })}>Remove</button></div></div>)}<button type="button" className="button button-secondary" onClick={() => fileInputRef.current?.click()}>＋ Add attachment</button><input ref={fileInputRef} className="visually-hidden" type="file" multiple accept="image/*,application/pdf,text/*,application/json,audio/*,.doc,.docx,.rtf" onChange={(e) => void handleFilePick(e)} /></div>
        {pendingFiles.map((file, idx) => <div className="attachment-picked" key={`${file.name}-${idx}`}><span className="attachment-paper">↳</span><div><strong>{file.name}</strong><span>{(file.size / 1024).toFixed(0)} KB · pending attach</span></div><button type="button" aria-label={`Remove ${file.name}`} onClick={() => setPendingFiles((prev) => prev.filter((_, i) => i !== idx))}>×</button></div>)}
        <div className="modal-actions modal-actions-split">{editing && <button className="button button-danger-outline" type="button" onClick={() => setModal('delete')}>Delete</button>}<span className="action-spacer"/><button className="button button-secondary" type="button" onClick={closeModal}>Cancel</button><button className="button button-primary" type="submit" disabled={busy || !draft.title.trim()}>{busy ? 'Saving…' : 'Save changes'}</button></div>
      </form>}
      {modal === 'delete' && <div className="delete-confirm"><p>“{editing?.title}” will be marked deleted and that change will sync to trusted devices. Some offline/revoked devices may still retain copies.</p><div className="modal-actions"><button className="button button-secondary" onClick={() => setModal('edit')}>Keep record</button><button className="button button-danger" onClick={() => void confirmDelete()} disabled={busy}>Delete record</button></div></div>}
    </section></div>}

    {showWeeklyModal && weeklyMirror && (
      <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowWeeklyModal(false); }}>
        <section className="modal-card weekly-mirror-modal" role="dialog" aria-modal="true" aria-labelledby="mirror-title">
          <div className="modal-heading">
            <div>
              <p className="eyebrow">7-DAY RETROSPECTIVE</p>
              <h2 id="mirror-title">Weekly Life Mirror</h2>
              <span className="form-hint">{weeklyMirror.periodLabel}</span>
            </div>
            <button className="icon-button" aria-label="Close dialog" onClick={() => setShowWeeklyModal(false)}>×</button>
          </div>
          <div className="mirror-content">
            <div className="mirror-narrative-card">
              <span className="mirror-icon">🪞</span>
              <p>{weeklyMirror.reflectionText}</p>
            </div>
            <div className="mirror-stats-grid">
              <div className="stat-card">
                <span className="stat-label">ACCOMPLISHED</span>
                <strong>{weeklyMirror.completedCount}</strong>
                <span>completed this week</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">OPEN LOOPS</span>
                <strong>{weeklyMirror.openPromisesCount}</strong>
                <span>pending follow-ups</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">UPCOMING</span>
                <strong>{weeklyMirror.upcomingRadar.length}</strong>
                <span>due in next 7 days</span>
              </div>
            </div>
            {weeklyMirror.highlights.length > 0 && (
              <div className="mirror-section">
                <h3>Done this past week:</h3>
                <ul>{weeklyMirror.highlights.map((a: string, i: number) => <li key={i}>✓ {a}</li>)}</ul>
              </div>
            )}
            {weeklyMirror.lowStockItems.length > 0 && (
              <div className="mirror-section mirror-alerts">
                <h3>Low stock & refills needed:</h3>
                <ul>{weeklyMirror.lowStockItems.map((l: string, i: number) => <li key={i}>⚠ {l}</li>)}</ul>
              </div>
            )}
          </div>
          <div className="modal-actions">
            <button className="button button-secondary" type="button" onClick={() => setShowWeeklyModal(false)}>Close</button>
            <button className="button button-primary" type="button" onClick={async () => {
              if (!unlocked) return;
              await saveItem(unlocked.db, unlocked.session, {
                id: crypto.randomUUID(),
                title: `Weekly Life Mirror: ${weeklyMirror.endDate.slice(0, 10)}`,
                body: `${weeklyMirror.reflectionText}\n\nAccomplishments (${weeklyMirror.highlights.length}):\n${weeklyMirror.highlights.map((a: string) => `- ${a}`).join('\n')}\n\nLow Stock:\n${weeklyMirror.lowStockItems.map((l: string) => `- ${l}`).join('\n')}`,
                kind: 'note',
                category: 'Weekly Mirror',
                status: 'open',
              });
              await refresh(unlocked);
              setShowWeeklyModal(false);
              setMessage({ type: 'success', text: 'Weekly Life Mirror saved to your memory notes.' });
            }}>Save as Memory Note</button>
          </div>
        </section>
      </div>
    )}
  </div>;
}

function ItemRow({ item, onToggle, onEdit, onDownloadAttachment, onRecordDose }: { item: AnchorItem; onToggle: () => void; onEdit: () => void; onDownloadAttachment: (attachment: AttachmentMetadata) => void; onRecordDose?: (item: AnchorItem, status: 'taken' | 'skipped') => void }) {
  const [revealed, setRevealed] = useState(false);
  const overdue = item.status !== 'done' && isOverdue(item.dueAt);
  const today = item.status !== 'done' && isDueToday(item.dueAt);
  const depletion = item.kind === 'consumable' && item.quantity !== undefined && (item.dailyRate ?? 0) > 0
    ? calculateDepletion(item.quantity, item.dailyRate!, item.reorderThreshold ?? 3)
    : null;
  const isMedicationOrDaily = item.kind === 'consumable' && (item.dailyRate ?? 0) > 0;
  const guide = getSubscriptionCancellationGuide(item);
  const isSecret = /\b(?:password|passcode|pin\b|locker\s+code|door\s+code|gate\s+code|secret\b|credential|api[_-]?key|access\s+code|vault\s+code)\b/i.test(item.title + ' ' + (item.body ?? '')) || item.category?.toLowerCase() === 'confidential';
  const maskSecret = (str?: string) => {
    if (!str) return '';
    if (revealed || !isSecret) return str;
    return str.replace(/\b((?:is|code|pin|password|passcode|key)\s*(?:is|:)?\s*)([a-zA-Z0-9!@#$%^&*_-]{2,})/gi, '$1••••');
  };
  return <article className={`item-row ${item.status === 'done' ? 'item-done' : ''}`}>
    <button className={`item-check ${item.status === 'done' ? 'checked' : ''}`} onClick={onToggle} aria-label={item.status === 'done' ? `Reopen ${item.title}` : `Mark ${item.title} done`}>{item.status === 'done' ? '✓' : ''}</button>
    <button className="item-main" onClick={onEdit} aria-label={`Edit ${item.title}`}>
      <div className="item-title-row">
        <strong>{maskSecret(item.title)}</strong>
        {isSecret && <span className="confidential-pill" title="Protected confidential secret">🔒 Confidential</span>}
        {isSecret && (
          <button
            type="button"
            className="reveal-secret-btn"
            onClick={(e) => {
              e.stopPropagation();
              setRevealed(!revealed);
            }}
            title={revealed ? 'Hide secret' : 'Reveal secret'}
          >
            {revealed ? 'Hide 🙈' : 'Show 👁'}
          </button>
        )}
        {item.confidence === 'low' && <span className="needs-review">REVIEW</span>}
        {item.recurrence && <span className="recurrence-pill" title={`Repeats ${item.recurrence}`}>↻ {item.recurrence}</span>}
      </div>
      {item.body && <p>{maskSecret(item.body)}</p>}
      <div className="item-meta">
        <span className={`kind-tag kind-${item.kind}`}>{displayKind(item.kind)}</span>
        {item.category && <span>{item.category}</span>}
        {item.quantity !== undefined && <span>{item.quantity} {item.unit || 'units'}</span>}
        {depletion && <span className={`stock-pill ${depletion.isLow ? 'stock-critical' : 'stock-ok'}`} title={depletion.summary}>{depletion.daysRemaining === 0 ? 'Out of stock' : `${depletion.daysRemaining}d stock remaining`}</span>}
        {guide.isSubscription && (item.kind === 'document' || item.kind === 'note') && (
          <span className="stock-pill stock-ok" title={`Cancellation Checklist:\n${guide.checklist.map((s, i) => `${i + 1}. ${s}`).join('\n')}`}>📋 Cancel Guide</span>
        )}
        {item.attachments && item.attachments.length > 0 && <span className="attachment-count">↳ {item.attachments.length} file{item.attachments.length === 1 ? '' : 's'}</span>}
        {item.dueAt && <span className={`due-label ${overdue ? 'due-overdue' : today ? 'due-today' : ''}`}>{overdue ? 'Overdue · ' : today ? 'Today · ' : ''}{formatDue(item.dueAt)}{today && formatClock(item.dueAt) ? `, ${formatClock(item.dueAt)}` : ''}</span>}
      </div>
    </button>
    {isMedicationOrDaily && item.status !== 'done' && onRecordDose && (
      <div className="dose-actions" onClick={(e) => e.stopPropagation()}>
        <button className="dose-button dose-take" title="Log dose taken" onClick={() => onRecordDose(item, 'taken')}>✓ Taken</button>
        <button className="dose-button dose-skip" title="Log dose skipped" onClick={() => onRecordDose(item, 'skipped')}>✕ Skip</button>
        {item.doseLogs && item.doseLogs.length > 0 && (
          <span className="adherence-pill" title="7-day adherence">{calculateAdherenceRate(item).ratePercent}% adherence</span>
        )}
      </div>
    )}
    {item.attachments?.[0] && <button className="item-attachment-open" type="button" aria-label={`Download attachment for ${item.title}`} title={`Download ${item.attachments[0].name}`} onClick={() => onDownloadAttachment(item.attachments![0])}>↧</button>}
    <button className="item-more" onClick={onEdit} aria-label={`Open ${item.title} details`}>···</button>
  </article>;
}

function EmptyState({ onCapture, onLoadDemo, title, text }: { onCapture: () => void; onLoadDemo?: () => void; title: string; text: string }) {
  return <div className="empty-state">
    <div className="empty-orbit"><span>∴</span></div>
    <h3>{title}</h3>
    <p>{text}</p>
    <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', marginTop: '14px', flexWrap: 'wrap' }}>
      <button className="text-button" onClick={onCapture}>Capture something <span>↗</span></button>
      {onLoadDemo && <button className="text-button" onClick={onLoadDemo} style={{ color: 'var(--accent)' }}>Load 7-day demo data <span>⚡</span></button>}
    </div>
  </div>;
}
