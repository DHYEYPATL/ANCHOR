import type { StoredAttachmentChunk, StoredConflict, StoredItem, StoredOperation, VaultMeta } from '../domain/models';
import { base64ToBytes } from './base64';
import { getAllConflicts, getAllItems, getAllOperations, getAllStoredAttachmentChunks, getVaultMeta, openDb, restoreEncryptedStores, type AnchorDatabase } from './database';
import { normalizeRelayUrl } from './relayUrl';

const BACKUP_FORMAT = 'anchor-encrypted-backup-v1' as const;
export const MAX_BACKUP_FILE_BYTES = 64 * 1024 * 1024;

export interface EncryptedBackup {
  format: typeof BACKUP_FORMAT;
  schemaVersion: 1;
  exportedAt: string;
  vault: VaultMeta;
  items: StoredItem[];
  operations: StoredOperation[];
  conflicts: StoredConflict[];
  attachments: StoredAttachmentChunk[];
  note: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function bounded(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour <= 23 && minute <= 59 && second <= 59;
}
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function validId(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function validateEncryptedBlob(value: unknown, idField: 'id' | 'conflictId', idPattern: RegExp, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!object(value) || !hasOnlyKeys(value, keys) || typeof value[idField] !== 'string' || !idPattern.test(String(value[idField])) ||
      !bounded(value.nonce, 100) || !bounded(value.ciphertext, 20_000_000) || value.schemaVersion !== 1) {
    throw new Error('Backup contains an invalid encrypted record envelope. Nothing was restored.');
  }
  try {
    if (base64ToBytes(value.nonce).length !== 12 || base64ToBytes(value.ciphertext).length < 16) throw new Error();
  } catch { throw new Error('Backup has malformed encrypted bytes. Nothing was restored.'); }
}

export function validateEncryptedBackup(value: unknown): asserts value is EncryptedBackup {
  if (!object(value) || !hasOnlyKeys(value, ['format', 'schemaVersion', 'exportedAt', 'vault', 'items', 'operations', 'conflicts', 'attachments', 'note']) ||
      value.format !== BACKUP_FORMAT || value.schemaVersion !== 1 || !validDate(value.exportedAt) || !object(value.vault)) {
    throw new Error('Unsupported or malformed Anchor backup file.');
  }
  const v = value.vault as Record<string, unknown>;
  if (!hasOnlyKeys(v, ['key', 'vaultId', 'salt', 'wrapNonce', 'wrappedVaultKey', 'secretNonce', 'encryptedSecret', 'deviceId', 'relayUrl', 'lastPulledCursor', 'createdAt']) ||
      v.key !== 'active' || !validId(v.vaultId) || !bounded(v.salt, 100) || !bounded(v.wrapNonce, 100) ||
      !bounded(v.wrappedVaultKey, 500) || !bounded(v.secretNonce, 100) || !bounded(v.encryptedSecret, 500) ||
      typeof v.deviceId !== 'string' || !/^device-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.deviceId) || typeof v.relayUrl !== 'string' || v.relayUrl.length > 2048 ||
      !validDate(v.createdAt) || !Number.isSafeInteger(v.lastPulledCursor) || Number(v.lastPulledCursor) < 0) {
    throw new Error('Backup vault metadata is malformed. Nothing was restored.');
  }
  if (typeof value.note !== 'string' || value.note.length > 2000) throw new Error('Backup note field is malformed. Nothing was restored.');
  normalizeRelayUrl(v.relayUrl as string);
  try {
    if (base64ToBytes(v.salt as string).length !== 16 || base64ToBytes(v.wrapNonce as string).length !== 12 ||
        base64ToBytes(v.secretNonce as string).length !== 12 || base64ToBytes(v.wrappedVaultKey as string).length < 32 ||
        base64ToBytes(v.encryptedSecret as string).length < 16) throw new Error();
  } catch { throw new Error('Backup key material is malformed. Nothing was restored.'); }
  for (const field of ['items', 'operations', 'conflicts', 'attachments'] as const) {
    if (!Array.isArray(value[field])) throw new Error(`Backup ${field} collection is missing.`);
    if (value[field].length > 1_000_000) throw new Error(`Backup ${field} collection exceeds safety limits.`);
  }
  const itemIds = new Set<string>();
  for (const raw of value.items as unknown[]) {
    validateEncryptedBlob(raw, 'id', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, ['id', 'nonce', 'ciphertext', 'schemaVersion']);
    const item = raw as Record<string, unknown>;
    if (itemIds.has(String(item.id))) throw new Error('Backup contains duplicate item IDs.');
    itemIds.add(String(item.id));
  }
  const operationIds = new Set<string>();
  for (const raw of value.operations as unknown[]) {
    validateEncryptedBlob(raw, 'id', /^op-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, ['id', 'nonce', 'ciphertext', 'schemaVersion', 'pushed', 'createdAt']);
    const op = raw as Record<string, unknown>;
    if (!hasOnlyKeys(op, ['id', 'nonce', 'ciphertext', 'schemaVersion', 'pushed', 'createdAt']) || operationIds.has(String(op.id)) || typeof op.pushed !== 'boolean' || !validDate(op.createdAt)) throw new Error('Backup contains duplicate or malformed operations.');
    operationIds.add(String(op.id));
  }
  const conflictIds = new Set<string>();
  for (const raw of value.conflicts as unknown[]) {
    validateEncryptedBlob(raw, 'conflictId', /^conflict-op-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, ['id', 'conflictId', 'itemId', 'nonce', 'ciphertext', 'schemaVersion', 'createdAt']);
    const conflict = raw as Record<string, unknown>;
    if (!hasOnlyKeys(conflict, ['id', 'conflictId', 'itemId', 'nonce', 'ciphertext', 'schemaVersion', 'createdAt']) || conflictIds.has(String(conflict.conflictId)) || !validId(conflict.itemId) || !validDate(conflict.createdAt) || conflict.id !== conflict.conflictId) throw new Error('Backup contains malformed conflicts.');
    conflictIds.add(String(conflict.conflictId));
  }
  const chunkIds = new Set<string>();
  for (const raw of value.attachments as unknown[]) {
    if (!object(raw) || !hasOnlyKeys(raw, ['id', 'attachmentId', 'chunkIndex', 'chunkCount', 'nonce', 'ciphertext', 'plaintextSize']) ||
        !validId(raw.attachmentId) || typeof raw.id !== 'string' || raw.id.length > 80 ||
        !Number.isSafeInteger(raw.chunkIndex) || Number(raw.chunkIndex) < 0 || !Number.isSafeInteger(raw.chunkCount) ||
        Number(raw.chunkCount) < 1 || Number(raw.chunkCount) > 40 || Number(raw.chunkIndex) >= Number(raw.chunkCount) ||
        !Number.isSafeInteger(raw.plaintextSize) || Number(raw.plaintextSize) < 1 || Number(raw.plaintextSize) > 256 * 1024 ||
        !bounded(raw.nonce, 100) || !bounded(raw.ciphertext, 400_000)) throw new Error('Backup contains a malformed attachment chunk.');
    const expectedId = `${raw.attachmentId}:${raw.chunkIndex}`;
    if (raw.id !== expectedId || chunkIds.has(expectedId)) throw new Error('Backup contains a duplicate or inconsistent attachment chunk ID.');
    chunkIds.add(expectedId);
    try { if (base64ToBytes(raw.nonce as string).length !== 12 || base64ToBytes(raw.ciphertext as string).length < 16) throw new Error(); }
    catch { throw new Error('Backup has malformed attachment bytes. Nothing was restored.'); }
  }
}

export async function createEncryptedBackupText(db: AnchorDatabase): Promise<string> {
  const vault = await getVaultMeta(db);
  if (!vault) throw new Error('Vault metadata is missing.');
  const [items, operations, conflicts, attachments] = await Promise.all([
    getAllItems(db), getAllOperations(db), getAllConflicts(db), getAllStoredAttachmentChunks(db),
  ]);
  // Estimate serialized size before allocating another full JSON copy. This matters on
  // memory-constrained phones, where the stored rows, JSON string and download blob coexist.
  const estimate = JSON.stringify(vault).length + 2048 +
    items.reduce((n, row) => n + row.id.length + row.nonce.length + row.ciphertext.length + 100, 0) +
    operations.reduce((n, row) => n + row.id.length + row.nonce.length + row.ciphertext.length + row.createdAt.length + 120, 0) +
    conflicts.reduce((n, row) => n + row.conflictId.length + row.itemId.length + row.nonce.length + row.ciphertext.length + row.createdAt.length + 140, 0) +
    attachments.reduce((n, row) => n + row.id.length + row.attachmentId.length + row.nonce.length + row.ciphertext.length + 100, 0);
  if (estimate > MAX_BACKUP_FILE_BYTES) {
    throw new Error('Encrypted backup exceeds the 64 MiB in-memory export limit. Use a smaller export or a device with more available memory. No partial backup was downloaded.');
  }
  const backup: EncryptedBackup = {
    format: BACKUP_FORMAT, schemaVersion: 1, exportedAt: new Date().toISOString(), vault,
    items, operations, conflicts, attachments,
    note: 'Record content and attachment bytes remain AES-GCM ciphertext. IDs, timestamps, counts, vector-independent metadata, and wrapped key material are visible. Unlock with your vault passphrase. Treat this file as sensitive.',
  };
  const text = JSON.stringify(backup);
  // Ciphertext and structural fields are ASCII; text length is a conservative-enough bound
  // here without allocating a second 64 MiB UTF-8 buffer solely to count bytes.
  if (text.length > MAX_BACKUP_FILE_BYTES) {
    throw new Error('Encrypted backup exceeds the 64 MiB in-memory export limit. No partial backup was downloaded.');
  }
  return text;
}

export async function restoreEncryptedBackupValue(value: unknown): Promise<void> {
  validateEncryptedBackup(value);
  const source = value.vault;
  const meta: VaultMeta = {
    ...source,
    deviceId: `device-${crypto.randomUUID()}`,
    relayUrl: normalizeRelayUrl(source.relayUrl),
    // Replay from the beginning. Stable operation IDs make this idempotent against
    // an existing relay and also recover if previously-acknowledged relay history was purged.
    lastPulledCursor: 0,
  };
  const db = await openDb();
  try {
    const requeuedOperations = value.operations.map((operation) => ({ ...operation, pushed: false }));
    await restoreEncryptedStores(db, meta, value.items, requeuedOperations, value.conflicts, value.attachments);
  } finally { db.close(); }
}

export async function restoreEncryptedBackupText(text: string): Promise<void> {
  if (text.length > MAX_BACKUP_FILE_BYTES) throw new Error('Backup file exceeds the 64 MiB safety limit.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Backup file is not valid JSON.'); }
  await restoreEncryptedBackupValue(value);
}
