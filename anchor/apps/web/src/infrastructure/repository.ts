import type { AnchorItem, AttachmentChunkOperationPayload, ItemOperationPayload, OperationPayload, StoredConflict, StoredItem, StoredOperation, VaultMeta, VaultSession, VersionVector } from '../domain/models';
import { assertValidAnchorItem, isDeviceId, isOperationId } from '../domain/validation';
import { decryptJson, encryptJson } from './crypto';
import {
  deleteConflict, getAllConflicts, getAllItems, getItem, getOperation, getPendingOperationsBatch,
  putConflictAndOperation, putItemAndOperationIfUnchanged, putOperation, type AnchorDatabase,
} from './database';

function vectorRelation(a: VersionVector, b: VersionVector): 'a-newer' | 'b-newer' | 'equal' | 'concurrent' {
  let aGreater = false;
  let bGreater = false;
  const devices = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const device of devices) {
    const av = a[device] ?? 0;
    const bv = b[device] ?? 0;
    if (av > bv) aGreater = true;
    if (bv > av) bGreater = true;
  }
  if (aGreater && bGreater) return 'concurrent';
  if (aGreater) return 'a-newer';
  if (bGreater) return 'b-newer';
  return 'equal';
}

function mergeAndIncrement(vectors: VersionVector[], deviceId: string): VersionVector {
  const merged = Object.create(null) as VersionVector;
  for (const vector of vectors) {
    for (const [device, counter] of Object.entries(vector)) {
      if (counter > (merged[device] ?? 0)) merged[device] = counter;
    }
  }
  const next = (merged[deviceId] ?? 0) + 1;
  if (!Number.isSafeInteger(next)) throw new Error('This record has reached its version limit. Export a backup and contact support before editing it.');
  merged[deviceId] = next;
  return merged;
}

function newOperationId() { return `op-${crypto.randomUUID()}`; }

async function readStoredItemSnapshot(db: AnchorDatabase, session: VaultSession, id: string): Promise<{ item?: AnchorItem; stored?: StoredItem }> {
  const stored = await getItem(db, id);
  if (!stored) return {};
  try {
    const item = await decryptJson<AnchorItem>(session.key, stored.nonce, stored.ciphertext, `item:${id}`);
    assertValidAnchorItem(item);
    if (item.id !== id) throw new Error('Stored record identity does not match its envelope.');
    return { item, stored };
  } catch { throw new Error(`Could not authenticate or validate local record ${id}. Your vault may be damaged; avoid wiping it and restore from a verified backup.`); }
}

async function readStoredItem(db: AnchorDatabase, session: VaultSession, id: string): Promise<AnchorItem | undefined> {
  return (await readStoredItemSnapshot(db, session, id)).item;
}

async function writeStoredItemAndOperation(
  db: AnchorDatabase, session: VaultSession, item: AnchorItem, operation: StoredOperation, expected: StoredItem | undefined,
): Promise<void> {
  const enc = await encryptJson(session.key, item, `item:${item.id}`);
  const stored: StoredItem = { id: item.id, nonce: enc.nonce, ciphertext: enc.ciphertext, schemaVersion: 1 };
  await putItemAndOperationIfUnchanged(db, stored, { ...operation, pushed: true }, expected);
}

export async function listItems(db: AnchorDatabase, session: VaultSession): Promise<AnchorItem[]> {
  const rows = await getAllItems(db);
  const items: AnchorItem[] = [];
  for (const row of rows) {
    try {
      const item = await decryptJson<AnchorItem>(session.key, row.nonce, row.ciphertext, `item:${row.id}`);
      assertValidAnchorItem(item);
      if (item.id !== row.id) throw new Error('Stored record identity does not match its envelope.');
      if (!item.deletedAt) items.push(item);
    } catch {
      // Fail the entire read rather than silently hiding corrupted records.
      throw new Error(`A local record could not be decrypted (${row.id}). Stop editing and restore a verified backup if available.`);
    }
  }
  return items.sort((a, b) => {
    const ad = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    const bd = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    return ad - bd || b.updatedAt.localeCompare(a.updatedAt);
  });
}

export async function saveItem(db: AnchorDatabase, session: VaultSession, draft: Partial<AnchorItem> & Pick<AnchorItem, 'title' | 'kind'>): Promise<AnchorItem> {
  if (typeof draft.title !== 'string' || typeof draft.kind !== 'string') throw new Error('A title and record type are required.');
  const now = new Date().toISOString();
  const id = draft.id ?? crypto.randomUUID();
  const snapshot = await readStoredItemSnapshot(db, session, id);
  const current = snapshot.item;
  if (current && draft.versionVector) {
    const relation = vectorRelation(draft.versionVector, current.versionVector);
    if (relation === 'b-newer' || relation === 'concurrent') {
      throw new Error('This record changed on another device while you were editing. Refresh the record, review the latest version, and try again.');
    }
  }
  const baseVector = draft.versionVector ?? current?.versionVector ?? {};
  const nextVector = mergeAndIncrement([baseVector, current?.versionVector ?? {}], session.deviceId);
  const item: AnchorItem = {
    id, kind: draft.kind, title: draft.title.trim(), body: draft.body?.trim() ?? '',
    status: draft.status ?? current?.status ?? 'open', createdAt: current?.createdAt ?? draft.createdAt ?? now,
    updatedAt: now, dueAt: draft.dueAt || undefined, category: draft.category || undefined,
    sourceText: draft.sourceText || undefined, sourceLabel: draft.sourceLabel || undefined,
    confidence: draft.confidence ?? 'medium', quantity: draft.quantity, unit: draft.unit,
    dailyRate: draft.dailyRate ?? current?.dailyRate,
    reorderThreshold: draft.reorderThreshold ?? current?.reorderThreshold,
    recurrence: draft.recurrence ?? current?.recurrence,
    doseLogs: draft.doseLogs ?? current?.doseLogs,
    versionVector: nextVector, deletedAt: draft.deletedAt, reminderMinutesBefore: draft.reminderMinutesBefore,
    attachments: draft.attachments ?? current?.attachments ?? [],
  };
  assertValidAnchorItem(item);
  const operationId = newOperationId();
  const op: ItemOperationPayload = { schemaVersion: 1, operationId, deviceId: session.deviceId, kind: 'item', operation: item.deletedAt ? 'delete' : 'upsert', item };
  const itemEnc = await encryptJson(session.key, item, `item:${item.id}`);
  const opEnc = await encryptJson(session.key, op, `change:${op.operationId}`);
  const storedItem: StoredItem = { id: item.id, nonce: itemEnc.nonce, ciphertext: itemEnc.ciphertext, schemaVersion: 1 };
  const storedOperation: StoredOperation = { id: op.operationId, nonce: opEnc.nonce, ciphertext: opEnc.ciphertext, schemaVersion: 1, pushed: false, createdAt: now };
  await putItemAndOperationIfUnchanged(db, storedItem, storedOperation, snapshot.stored);
  return item;
}

export async function deleteItem(db: AnchorDatabase, session: VaultSession, id: string): Promise<void> {
  const item = await readStoredItem(db, session, id);
  if (!item || item.deletedAt) return;
  await saveItem(db, session, { ...item, deletedAt: new Date().toISOString() });
}

export async function restoreItem(db: AnchorDatabase, session: VaultSession, id: string): Promise<AnchorItem> {
  const item = await readStoredItem(db, session, id);
  if (!item) throw new Error('Record not found.');
  return saveItem(db, session, { ...item, deletedAt: undefined });
}

export async function listDeletedItems(db: AnchorDatabase, session: VaultSession): Promise<AnchorItem[]> {
  const rows = await getAllItems(db);
  const items: AnchorItem[] = [];
  for (const row of rows) {
    try {
      const item = await decryptJson<AnchorItem>(session.key, row.nonce, row.ciphertext, `item:${row.id}`);
      assertValidAnchorItem(item);
      if (item.deletedAt) items.push(item);
    } catch {
      // Ignore unreadable items in trash query
    }
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getPendingOperationsForSync(db: AnchorDatabase) {
  return getPendingOperationsBatch(db, 200);
}

export async function markOperationSynced(db: AnchorDatabase, operationId: string) {
  const operation = await getOperation(db, operationId);
  if (operation && !operation.pushed) await putOperation(db, { ...operation, pushed: true });
}

export async function applyRemoteOperation(db: AnchorDatabase, session: VaultSession, op: StoredOperation): Promise<'applied' | 'duplicate' | 'conflict' | 'ignored'> {
  const already = await getOperation(db, op.id);
  if (already) {
    // A stable ID is only idempotent if the exact authenticated envelope is the same.
    // Corrupt local data or a broken trusted peer must not make us skip a different change.
    if (already.nonce !== op.nonce || already.ciphertext !== op.ciphertext || already.schemaVersion !== op.schemaVersion) {
      throw new Error(`Sync operation ID collision or local corruption detected (${op.id}). The incoming change was not applied.`);
    }
    return 'duplicate';
  }
  let payload: OperationPayload;
  try { payload = await decryptJson<OperationPayload>(session.key, op.nonce, op.ciphertext, `change:${op.id}`); }
  catch { throw new Error(`A received sync change failed authentication (${op.id}). It was not applied.`); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.schemaVersion !== 1 ||
      payload.operationId !== op.id || !isOperationId(payload.operationId) || !isDeviceId(payload.deviceId)) {
    throw new Error('A received sync change uses an unsupported or invalid schema. It was not applied.');
  }
  const commonKeys = ['schemaVersion', 'operationId', 'deviceId', 'kind'];
  const operationKeys = payload.kind === 'item' ? [...commonKeys, 'operation', 'item'] :
    payload.kind === 'attachment-chunk' ? [...commonKeys, 'attachmentId', 'chunkIndex', 'chunkCount', 'chunkNonce', 'chunkCiphertext', 'plaintextSize', 'relatedItemId'] : [];
  if (operationKeys.length === 0 || Object.keys(payload).some((key) => !operationKeys.includes(key)) ||
      operationKeys.some((key) => !(key in payload))) {
    throw new Error('A received sync change contains unsupported fields or an invalid operation kind. It was not applied.');
  }
  if (payload.kind === 'attachment-chunk') {
    const { applyRemoteAttachmentChunk } = await import('./attachments');
    await applyRemoteAttachmentChunk(db, session, payload as AttachmentChunkOperationPayload, op);
    return 'applied';
  }
  if (payload.kind !== 'item' || !payload.item || !['upsert', 'delete'].includes(payload.operation)) {
    throw new Error('A received sync change uses an unsupported or invalid record schema. It was not applied.');
  }
  assertValidAnchorItem(payload.item);
  if ((payload.item.versionVector[payload.deviceId] ?? 0) < 1) throw new Error('The received item version vector does not include the originating device. It was not applied.');
  if ((payload.operation === 'delete') !== Boolean(payload.item.deletedAt)) throw new Error('The received delete marker does not match the record payload.');
  const incoming = payload.item;
  const snapshot = await readStoredItemSnapshot(db, session, incoming.id);
  const current = snapshot.item;
  let outcome: 'applied' | 'conflict' | 'ignored' = 'applied';
  if (!current) {
    await writeStoredItemAndOperation(db, session, incoming, op, snapshot.stored);
    return 'applied';
  } else {
    const relation = vectorRelation(incoming.versionVector, current.versionVector);
    if (relation === 'a-newer') {
      await writeStoredItemAndOperation(db, session, incoming, op, snapshot.stored);
      return 'applied';
    } else if (relation === 'b-newer') {
      // The local record causally contains changes newer than this operation.
      // Persist the operation ID so a repeated pull remains idempotent.
      outcome = 'ignored';
      await putOperation(db, { ...op, pushed: true });
    } else if (relation === 'equal' && JSON.stringify(incoming) === JSON.stringify(current)) {
      outcome = 'ignored';
      await putOperation(db, { ...op, pushed: true });
    } else {
      // Concurrent vectors and divergent payloads with equal vectors both require
      // review. Equal clocks with different contents indicate a broken or malicious
      // trusted replica; never silently choose a winner.
      const conflictId = `conflict-${op.id}`;
      const conflictEnc = await encryptJson(session.key, { local: current, remote: incoming }, `conflict:${conflictId}`);
      const conflict: StoredConflict = { id: conflictId, conflictId, itemId: incoming.id, nonce: conflictEnc.nonce, ciphertext: conflictEnc.ciphertext, schemaVersion: 1, createdAt: new Date().toISOString() };
      await putConflictAndOperation(db, conflict, { ...op, pushed: true });
      outcome = 'conflict';
    }
  }
  return outcome;
}

export interface ConflictView { conflictId: string; itemId: string; createdAt: string; local: AnchorItem; remote: AnchorItem; }

export async function listConflicts(db: AnchorDatabase, session: VaultSession): Promise<ConflictView[]> {
  const rows = await getAllConflicts(db);
  const result: ConflictView[] = [];
  for (const row of rows) {
    try {
      const pair = await decryptJson<{ local: AnchorItem; remote: AnchorItem }>(session.key, row.nonce, row.ciphertext, `conflict:${row.conflictId}`);
      result.push({ conflictId: row.conflictId, itemId: row.itemId, createdAt: row.createdAt, ...pair });
    } catch { throw new Error(`Could not decrypt conflict ${row.conflictId}.`); }
  }
  return result;
}

export async function resolveConflict(db: AnchorDatabase, session: VaultSession, conflictId: string, pick: 'local' | 'remote'): Promise<AnchorItem> {
  const conflicts = await listConflicts(db, session);
  const conflict = conflicts.find((c) => c.conflictId === conflictId);
  if (!conflict) throw new Error('This conflict no longer exists. Refresh and try again.');
  const latestLocal = await readStoredItem(db, session, conflict.itemId);
  const localVersion = latestLocal ?? conflict.local;
  const merged = mergeAndIncrement([localVersion.versionVector, conflict.local.versionVector, conflict.remote.versionVector], session.deviceId);
  const chosen = pick === 'local' ? localVersion : conflict.remote;
  const saved = await saveItem(db, session, { ...chosen, versionVector: merged, updatedAt: new Date().toISOString() });
  await deleteConflict(db, conflictId);
  return saved;
}

export async function updatePullCursor(db: AnchorDatabase, meta: VaultMeta, cursor: number): Promise<VaultMeta> {
  const { saveVaultMeta } = await import('./database');
  const updated = { ...meta, lastPulledCursor: Math.max(meta.lastPulledCursor, cursor) };
  await saveVaultMeta(db, updated);
  return updated;
}

export async function readOperationPayload(session: VaultSession, op: StoredOperation): Promise<OperationPayload> {
  return decryptJson<OperationPayload>(session.key, op.nonce, op.ciphertext, `change:${op.id}`);
}
