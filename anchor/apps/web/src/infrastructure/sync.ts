import type { StoredOperation, SyncState, VaultMeta, VaultSession } from '../domain/models';
import { getVaultMeta } from './database';
import { normalizeRelayUrl } from './relayUrl';
import type { AnchorDatabase } from './database';
import { applyRemoteOperation, getPendingOperationsForSync, markOperationSynced } from './repository';

interface RelayChange { cursor: number; change_id: string; nonce: string; ciphertext: string; schema_version: 1; created_at: number; }
interface PullResponse { changes: RelayChange[]; next_cursor: number; has_more: boolean; }

// A relay page contains at most ten changes. The body reader imposes a hard memory ceiling
// even if a hostile or misconfigured relay ignores the expected response shape.
export const MAX_RELAY_RESPONSE_BYTES = 16 * 1024 * 1024;
export const RELAY_PAGE_SIZE = 10;

export async function readBoundedJson<T>(response: Response, maxBytes = MAX_RELAY_RESPONSE_BYTES): Promise<T> {
  const header = response.headers.get('content-length');
  if (header !== null && /^\d+$/.test(header) && Number(header) > maxBytes) {
    throw new Error('Relay response exceeds the safety limit. No oversized response was parsed.');
  }
  if (!response.body) throw new Error('Relay returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Relay response exceeds the safety limit. No oversized response was parsed.');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T; }
    catch { throw new Error('Relay returned malformed JSON. No changes from that response were applied.'); }
    finally { bytes.fill(0); }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    try { reader.releaseLock(); } catch { /* The reader may have been canceled. */ }
  }
}

export interface SyncResult { state: SyncState; uploaded: number; downloaded: number; conflicts: number; cursor: number; message: string; }
export type SyncProgress = (state: SyncState, message: string) => void;

function safeRelayUrl(value: string): string {
  return normalizeRelayUrl(value);
}

async function relayFetch<T>(url: string, token: string, init: RequestInit = {}, timeoutMs = 12_000): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init, signal: controller.signal,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      cache: 'no-store',
    });
    if (!response.ok) {
      let detail = `Relay returned HTTP ${response.status}.`;
      try { const body = await readBoundedJson<{ detail?: string }>(response, 8 * 1024); if (typeof body.detail === 'string' && body.detail.length <= 1000) detail = body.detail; } catch { /* Keep generic status; error bodies are untrusted too. */ }
      throw new Error(detail);
    }
    return await readBoundedJson<T>(response);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('The sync relay timed out. Local data is safe; retry when the network is available.');
    if (error instanceof TypeError) throw new Error('Could not reach the sync relay. Check the network, endpoint URL and CORS configuration.');
    throw error;
  } finally { window.clearTimeout(timeout); }
}

function toStoredOperation(change: RelayChange): StoredOperation {
  return { id: change.change_id, nonce: change.nonce, ciphertext: change.ciphertext, schemaVersion: change.schema_version, pushed: true, createdAt: new Date(change.created_at * 1000).toISOString() };
}

export async function syncNow(db: AnchorDatabase, metaInitial: VaultMeta, session: VaultSession, onProgress: SyncProgress = () => {}): Promise<{ meta: VaultMeta; result: SyncResult }> {
  if (!session.relayUrl) return { meta: metaInitial, result: { state: 'local-only', uploaded: 0, downloaded: 0, conflicts: 0, cursor: metaInitial.lastPulledCursor, message: 'Local-only mode. Add an encrypted relay endpoint to sync devices.' } };
  const baseUrl = safeRelayUrl(session.relayUrl);
  let meta = (await getVaultMeta(db)) ?? metaInitial;
  let uploaded = 0;
  let downloaded = 0;
  let conflicts = 0;
  onProgress('syncing', 'Connecting securely to relay…');
  await relayFetch<{ registered: boolean }>(`${baseUrl}/v1/rooms`, session.relayToken, { method: 'POST', body: JSON.stringify({ vault_id: session.vaultId, access_token: session.relayToken }) });

  const pull = async () => {
    let cursor = meta.lastPulledCursor;
    let pages = 0;
    while (pages < 100) {
      const page = await relayFetch<PullResponse>(`${baseUrl}/v1/rooms/${encodeURIComponent(session.vaultId)}/changes?after=${cursor}&limit=${RELAY_PAGE_SIZE}`, session.relayToken, { method: 'GET', headers: {} });
      if (!Array.isArray(page.changes) || page.changes.length > RELAY_PAGE_SIZE || !Number.isSafeInteger(page.next_cursor) || page.next_cursor < cursor || typeof page.has_more !== 'boolean') throw new Error('Relay returned an invalid sync response.');
      if (page.changes.length === 0) {
        if (page.has_more || page.next_cursor !== cursor) throw new Error('Relay returned inconsistent pagination metadata. Sync paused without applying an empty malformed page.');
        break;
      }
      for (const change of page.changes) {
        if (change.schema_version !== 1 || typeof change.change_id !== 'string' || !/^op-[0-9a-f-]{36}$/i.test(change.change_id) ||
            typeof change.nonce !== 'string' || change.nonce.length > 100 || typeof change.ciphertext !== 'string' || change.ciphertext.length > Math.ceil((1024 * 1024) * 4 / 3) + 8 ||
            !Number.isSafeInteger(change.cursor) || change.cursor <= cursor || change.cursor > page.next_cursor || !Number.isSafeInteger(change.created_at) || change.created_at <= 0) {
          throw new Error('Relay returned a malformed change. It has not been applied.');
        }
        const outcome = await applyRemoteOperation(db, session, toStoredOperation(change));
        if (outcome === 'applied' || outcome === 'conflict') downloaded += 1;
        if (outcome === 'conflict') conflicts += 1;
        cursor = change.cursor;
        meta = { ...meta, lastPulledCursor: Math.max(meta.lastPulledCursor, cursor) };
        // Persist cursor after each successfully authenticated/applied change. A crash
        // replays at most one operation, which the operation ID deduplicates safely.
        const { saveVaultMeta } = await import('./database');
        await saveVaultMeta(db, meta);
      }
      if (page.next_cursor !== cursor) throw new Error('Relay pagination cursor did not match the last returned change. Sync stopped safely.');
      if (!page.has_more) break;
      pages += 1;
    }
    if (pages >= 100) throw new Error('Sync is catching up through many changes. Retry to continue safely.');
    await relayFetch(`${baseUrl}/v1/rooms/${encodeURIComponent(session.vaultId)}/ack`, session.relayToken, {
      method: 'POST', body: JSON.stringify({ device_id: session.deviceId, cursor: meta.lastPulledCursor }),
    });
  };

  // Pull before push to avoid advancing the local pull cursor past a concurrent write.
  await pull();
  onProgress('syncing', 'Uploading encrypted changes…');
  // Drain the outbox in bounded batches so a long-offline device does not load every
  // attachment chunk into memory at once. Each acknowledged op is marked in IndexedDB;
  // if the app crashes mid-batch, retrying is safe because the relay is idempotent.
  for (let batchNumber = 0; batchNumber < 10_000; batchNumber += 1) {
    const pending = await getPendingOperationsForSync(db);
    if (pending.length === 0) break;
    for (const op of pending) {
      const response = await relayFetch<{ cursor: number; duplicate: boolean }>(`${baseUrl}/v1/rooms/${encodeURIComponent(session.vaultId)}/changes`, session.relayToken, {
        method: 'POST', body: JSON.stringify({ change_id: op.id, nonce: op.nonce, ciphertext: op.ciphertext, schema_version: 1 }),
      });
      if (!Number.isSafeInteger(response.cursor) || response.cursor < 1) throw new Error('Relay did not acknowledge the encrypted change. It remains queued locally.');
      await markOperationSynced(db, op.id);
      uploaded += 1;
    }
    if (batchNumber === 9_999) throw new Error('There are too many queued changes to send in one sync session. Local data is safe; sync again to continue.');
  }
  onProgress('syncing', 'Checking for changes made by your other devices…');
  await pull();
  const finalMeta = (await getVaultMeta(db)) ?? meta;
  onProgress('synced', `Sync complete · ${uploaded} sent · ${downloaded} received${conflicts ? ` · ${conflicts} conflict${conflicts === 1 ? '' : 's'} to review` : ''}`);
  return { meta: finalMeta, result: { state: 'synced', uploaded, downloaded, conflicts, cursor: finalMeta.lastPulledCursor, message: `Sync complete · ${uploaded} sent · ${downloaded} received${conflicts ? ` · ${conflicts} conflict${conflicts === 1 ? '' : 's'} to review` : ''}` } };
}
