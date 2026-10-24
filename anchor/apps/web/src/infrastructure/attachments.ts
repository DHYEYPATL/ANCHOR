import type { AttachmentMetadata, AttachmentChunkOperationPayload, StoredAttachmentChunk, StoredOperation, VaultSession } from '../domain/models';
import { ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENT_BYTES } from '../domain/validation';
export { MAX_ATTACHMENT_BYTES };
import { decryptBytes, decryptJson, encryptBytes, encryptJson } from './crypto';
import { deleteAttachmentAndOperations, getAllOperations, getAttachmentChunks, putAttachmentChunkAndOperation, type AnchorDatabase } from './database';

const CHUNK_BYTES = ATTACHMENT_CHUNK_BYTES;

function cleanFileName(name: string): string {
  const leaf = name.split(/[\\/]/).pop() ?? 'attachment';
  const safe = leaf.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
  return safe || 'attachment';
}

function guessMime(file: File): string {
  if (file.type && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(file.type)) return file.type.toLowerCase();
  const ext = cleanFileName(file.name).split('.').pop()?.toLowerCase();
  const known: Record<string, string> = {
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg',
  };
  return (ext && known[ext]) || 'application/octet-stream';
}

function newOperationId() { return `op-${crypto.randomUUID()}`; }

/** Encrypt one file locally into bounded chunks, then queue each chunk as an encrypted sync operation. */
export async function saveAttachmentFile(db: AnchorDatabase, session: VaultSession, file: File, relatedItemId: string): Promise<AttachmentMetadata> {
  if (file.size <= 0) throw new Error('The attachment is empty. Choose a non-empty file.');
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`This attachment is ${Math.ceil(file.size / 1024 / 1024)} MiB. The current per-file limit is 10 MiB.`);
  const attachmentId = crypto.randomUUID();
  const chunkCount = Math.ceil(file.size / CHUNK_BYTES);
  const operationIds: string[] = [];
  try {
    // Slice the File instead of reading all bytes at once; this keeps peak memory bounded on phones.
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const start = chunkIndex * CHUNK_BYTES;
      const plainChunk = new Uint8Array(await file.slice(start, Math.min(start + CHUNK_BYTES, file.size)).arrayBuffer());
      let inner: { nonce: string; ciphertext: string };
      try { inner = await encryptBytes(session.key, plainChunk, `attachment:${attachmentId}:${chunkIndex}`); }
      finally { plainChunk.fill(0); }
      const operationId = newOperationId(); operationIds.push(operationId);
      const payload: AttachmentChunkOperationPayload = {
        schemaVersion: 1, operationId, deviceId: session.deviceId, kind: 'attachment-chunk',
        attachmentId, chunkIndex, chunkCount, chunkNonce: inner.nonce, chunkCiphertext: inner.ciphertext,
        plaintextSize: plainChunk.length, relatedItemId,
      };
      const outer = await encryptJson(session.key, payload, `change:${operationId}`);
      const chunk: StoredAttachmentChunk = {
        id: `${attachmentId}:${chunkIndex}`, attachmentId, chunkIndex, chunkCount,
        nonce: inner.nonce, ciphertext: inner.ciphertext, plaintextSize: plainChunk.length,
      };
      const op: StoredOperation = {
        id: operationId, nonce: outer.nonce, ciphertext: outer.ciphertext, schemaVersion: 1,
        pushed: false, createdAt: new Date().toISOString(),
      };
      // The local encrypted chunk and the outbox change are committed atomically.
      await putAttachmentChunkAndOperation(db, chunk, op);
    }
    // Do not expose internal file bytes outside this module. Best-effort clear the JS copy.
    return {
      id: attachmentId, name: cleanFileName(file.name), mimeType: guessMime(file), size: file.size,
      chunkCount, createdAt: new Date().toISOString(),
    };
  } catch (error) {
    // Roll back all chunks/outbox records committed by this upload.
    await deleteAttachmentAndOperations(db, attachmentId, operationIds).catch(() => undefined);
    throw error;
  }
}

/** Remove a just-created attachment if the parent record cannot be committed. Only unpublished operations are eligible. */
export async function rollbackUnpublishedAttachment(db: AnchorDatabase, session: VaultSession, attachmentId: string): Promise<void> {
  const operations = await getAllOperations(db);
  const ids: string[] = [];
  for (const operation of operations) {
    if (operation.pushed) continue;
    try {
      const payload = await decryptJson<Partial<AttachmentChunkOperationPayload>>(session.key, operation.nonce, operation.ciphertext, `change:${operation.id}`);
      if (payload.kind === 'attachment-chunk' && payload.attachmentId === attachmentId) ids.push(operation.id);
    } catch { /* A different operation schema or damaged op is not removed. */ }
  }
  await deleteAttachmentAndOperations(db, attachmentId, ids);
}

export async function getAttachmentBlob(db: AnchorDatabase, session: VaultSession, metadata: AttachmentMetadata): Promise<Blob> {
  if (!metadata || !/^[0-9a-f-]{36}$/i.test(metadata.id) || !Number.isSafeInteger(metadata.size) ||
      metadata.size < 1 || metadata.size > MAX_ATTACHMENT_BYTES || !Number.isSafeInteger(metadata.chunkCount) ||
      metadata.chunkCount !== Math.ceil(metadata.size / CHUNK_BYTES)) {
    throw new Error('Attachment metadata is invalid or exceeds the local safety limit.');
  }
  const rows = await getAttachmentChunks(db, metadata.id);
  if (rows.length !== metadata.chunkCount || rows.some((row, index) => row.chunkIndex !== index || row.chunkCount !== metadata.chunkCount)) {
    throw new Error('This attachment is not fully available on this device yet. Sync again when the other device is online.');
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (const row of rows) {
      let part: Uint8Array;
      try { part = await decryptBytes(session.key, row.nonce, row.ciphertext, `attachment:${metadata.id}:${row.chunkIndex}`); }
      catch { throw new Error(`Attachment integrity check failed for ${metadata.name}. The file was not opened.`); }
      const expectedChunkSize = row.chunkIndex < rows.length - 1 ? CHUNK_BYTES : metadata.size - CHUNK_BYTES * (rows.length - 1);
      if (part.length !== row.plaintextSize || part.length !== expectedChunkSize) {
        part.fill(0);
        throw new Error(`Attachment length check failed for ${metadata.name}.`);
      }
      total += part.length;
      parts.push(part);
    }
    if (total !== metadata.size) throw new Error(`Attachment size check failed for ${metadata.name}.`);
    return new Blob(parts, { type: metadata.mimeType || 'application/octet-stream' });
  } finally {
    // Blob copies its parts; clear the mutable plaintext copies as soon as it is constructed.
    for (const part of parts) part.fill(0);
  }
}

export async function downloadAttachment(db: AnchorDatabase, session: VaultSession, metadata: AttachmentMetadata): Promise<void> {
  const blob = await getAttachmentBlob(db, session, metadata);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = metadata.name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function applyRemoteAttachmentChunk(
  db: AnchorDatabase, session: VaultSession, payload: AttachmentChunkOperationPayload, operation: StoredOperation,
): Promise<void> {
  const maxEncodedChunk = Math.ceil((CHUNK_BYTES + 16) * 4 / 3) + 8;
  if (!payload || !/^[0-9a-f-]{36}$/i.test(payload.attachmentId) || !/^[0-9a-f-]{36}$/i.test(payload.relatedItemId) ||
      !Number.isSafeInteger(payload.chunkIndex) || !Number.isSafeInteger(payload.chunkCount) ||
      payload.chunkCount < 1 || payload.chunkCount > Math.ceil(MAX_ATTACHMENT_BYTES / CHUNK_BYTES) || payload.chunkIndex < 0 || payload.chunkIndex >= payload.chunkCount ||
      !Number.isSafeInteger(payload.plaintextSize) || payload.plaintextSize < 1 || payload.plaintextSize > CHUNK_BYTES ||
      (payload.chunkIndex < payload.chunkCount - 1 && payload.plaintextSize !== CHUNK_BYTES) ||
      typeof payload.chunkNonce !== 'string' || payload.chunkNonce.length !== 16 || !/^[A-Za-z0-9+/]+=*$/.test(payload.chunkNonce) ||
      typeof payload.chunkCiphertext !== 'string' || payload.chunkCiphertext.length > maxEncodedChunk || !/^[A-Za-z0-9+/]+=*$/.test(payload.chunkCiphertext)) {
    throw new Error('A received attachment chunk has invalid metadata. It was rejected.');
  }
  // Authenticate the inner chunk before persisting it. No file is ever opened automatically.
  let plain: Uint8Array;
  try { plain = await decryptBytes(session.key, payload.chunkNonce, payload.chunkCiphertext, `attachment:${payload.attachmentId}:${payload.chunkIndex}`); }
  catch { throw new Error('A received attachment chunk failed authentication and was rejected.'); }
  if (plain.length !== payload.plaintextSize) { plain.fill(0); throw new Error('A received attachment chunk failed its size check.'); }
  plain.fill(0);
  const previousChunks = await getAttachmentChunks(db, payload.attachmentId);
  const previous = previousChunks.find((row) => row.chunkIndex === payload.chunkIndex);
  if (previous && (previous.chunkCount !== payload.chunkCount || previous.nonce !== payload.chunkNonce || previous.ciphertext !== payload.chunkCiphertext || previous.plaintextSize !== payload.plaintextSize)) {
    throw new Error('Two different encrypted chunks claim the same attachment position. Sync paused to avoid corrupting the file.');
  }
  const chunk: StoredAttachmentChunk = {
    id: `${payload.attachmentId}:${payload.chunkIndex}`, attachmentId: payload.attachmentId,
    chunkIndex: payload.chunkIndex, chunkCount: payload.chunkCount, nonce: payload.chunkNonce,
    ciphertext: payload.chunkCiphertext, plaintextSize: payload.plaintextSize,
  };
  await putAttachmentChunkAndOperation(db, chunk, { ...operation, pushed: true });
}
