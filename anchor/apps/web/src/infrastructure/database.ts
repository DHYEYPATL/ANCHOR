import type { StoredAttachmentChunk, StoredConflict, StoredItem, StoredOperation, VaultMeta } from '../domain/models';

const DB_NAME = 'anchor-local-v1';
const DB_VERSION = 3;

export interface AnchorDatabase extends IDBDatabase {
  // Structural typing only; IndexedDB object stores are defined by openDb().
}

function makeTransaction(db: AnchorDatabase, stores: string | string[], mode: IDBTransactionMode): IDBTransaction {
  try { return db.transaction(stores, mode, { durability: 'strict' }); }
  catch { return db.transaction(stores, mode); }
}

export function openDb(): Promise<AnchorDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('vault')) db.createObjectStore('vault', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
      const operations = db.objectStoreNames.contains('operations')
        ? request.transaction!.objectStore('operations')
        : db.createObjectStore('operations', { keyPath: 'id' });
      if (!operations.indexNames.contains('byPushedCreatedAt')) operations.createIndex('byPushedCreatedAt', ['pushed', 'createdAt'], { unique: false });
      if (!db.objectStoreNames.contains('conflicts')) db.createObjectStore('conflicts', { keyPath: 'conflictId' });
      const attachments = db.objectStoreNames.contains('attachments')
        ? request.transaction!.objectStore('attachments')
        : db.createObjectStore('attachments', { keyPath: 'id' });
      if (!attachments.indexNames.contains('byAttachmentId')) attachments.createIndex('byAttachmentId', 'attachmentId', { unique: false });
    };
    request.onsuccess = () => {
      const db = request.result as AnchorDatabase;
      // Let other tabs close their old connection before a future schema migration.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open local database'));
    request.onblocked = () => reject(new Error('Database upgrade is blocked by another open Anchor tab. Close other tabs and retry.'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Database transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('Database transaction failed'));
  });
}

export async function getVaultMeta(db: AnchorDatabase): Promise<VaultMeta | undefined> {
  return requestResult(makeTransaction(db, 'vault', 'readonly').objectStore('vault').get('active'));
}

export async function saveVaultMeta(db: AnchorDatabase, meta: VaultMeta): Promise<void> {
  const tx = makeTransaction(db, 'vault', 'readwrite');
  tx.objectStore('vault').put(meta);
  await transactionDone(tx);
}

/** Persist the first vault metadata only if every store is empty, in one atomic transaction. */
export async function saveVaultMetaIfEmpty(db: AnchorDatabase, meta: VaultMeta): Promise<void> {
  const names = ['vault', 'items', 'operations', 'conflicts', 'attachments'];
  const tx = makeTransaction(db, names, 'readwrite');
  const done = transactionDone(tx);
  let remaining = names.length;
  let queued = false;
  let validationError: Error | null = null;
  const fail = (message: string) => {
    validationError = new Error(message);
    try { tx.abort(); } catch { /* Transaction already completed or aborted. */ }
  };
  for (const name of names) {
    const request = tx.objectStore(name).count();
    request.onsuccess = () => {
      if (request.result !== 0) {
        fail('This browser profile already contains Anchor data. Unlock it, export it, or explicitly wipe it before creating or importing another vault. No data was overwritten.');
        return;
      }
      remaining -= 1;
      if (remaining !== 0 || queued || validationError) return;
      queued = true;
      // IndexedDB transactions remain active while this synchronous callback runs.
      tx.objectStore('vault').put(meta);
    };
    request.onerror = () => fail('Could not inspect the local database safely. No vault was written.');
  }
  try { await done; } catch (error) { throw validationError ?? error; }
}

export async function putItem(db: AnchorDatabase, item: StoredItem): Promise<void> {
  const tx = makeTransaction(db, 'items', 'readwrite');
  tx.objectStore('items').put(item);
  await transactionDone(tx);
}

export async function getItem(db: AnchorDatabase, id: string): Promise<StoredItem | undefined> {
  return requestResult(makeTransaction(db, 'items', 'readonly').objectStore('items').get(id));
}

export async function getAllItems(db: AnchorDatabase): Promise<StoredItem[]> {
  return requestResult(makeTransaction(db, 'items', 'readonly').objectStore('items').getAll());
}

export async function putOperation(db: AnchorDatabase, op: StoredOperation): Promise<void> {
  const tx = makeTransaction(db, 'operations', 'readwrite');
  tx.objectStore('operations').put(op);
  await transactionDone(tx);
}

export async function getOperation(db: AnchorDatabase, id: string): Promise<StoredOperation | undefined> {
  return requestResult(makeTransaction(db, 'operations', 'readonly').objectStore('operations').get(id));
}

export async function getAllOperations(db: AnchorDatabase): Promise<StoredOperation[]> {
  return requestResult(makeTransaction(db, 'operations', 'readonly').objectStore('operations').getAll());
}

export async function getPendingOperations(db: AnchorDatabase): Promise<StoredOperation[]> {
  return getPendingOperationsBatch(db, 500);
}

export async function markOperationPushed(db: AnchorDatabase, id: string): Promise<void> {
  const tx = makeTransaction(db, 'operations', 'readwrite');
  const store = tx.objectStore('operations');
  const done = transactionDone(tx);
  const request = store.get(id);
  request.onsuccess = () => {
    const op = request.result as StoredOperation | undefined;
    if (op && !op.pushed) store.put({ ...op, pushed: true });
  };
  request.onerror = () => { try { tx.abort(); } catch { /* Already complete. */ } };
  await done;
}

/** Bounded outbox read, indexed by pushed state then creation time. */
export async function getPendingOperationsBatch(db: AnchorDatabase, limit = 100): Promise<StoredOperation[]> {
  const tx = makeTransaction(db, 'operations', 'readonly');
  const index = tx.objectStore('operations').index('byPushedCreatedAt');
  const range = IDBKeyRange.bound([false, ''], [false, '\uffff']);
  const result: StoredOperation[] = [];
  const done = transactionDone(tx);
  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor(range, 'next');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || result.length >= Math.max(1, Math.min(limit, 500))) { resolve(); return; }
      result.push(cursor.value as StoredOperation);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('Could not read the sync outbox.'));
  });
  await done;
  return result;
}

export async function putConflict(db: AnchorDatabase, conflict: StoredConflict): Promise<void> {
  const tx = makeTransaction(db, 'conflicts', 'readwrite');
  tx.objectStore('conflicts').put(conflict);
  await transactionDone(tx);
}

export async function getAllConflicts(db: AnchorDatabase): Promise<StoredConflict[]> {
  return requestResult(makeTransaction(db, 'conflicts', 'readonly').objectStore('conflicts').getAll());
}

export async function deleteConflict(db: AnchorDatabase, id: string): Promise<void> {
  const tx = makeTransaction(db, 'conflicts', 'readwrite');
  tx.objectStore('conflicts').delete(id);
  await transactionDone(tx);
}

export async function clearAllUserData(db: AnchorDatabase): Promise<void> {
  const tx = makeTransaction(db, ['vault', 'items', 'operations', 'conflicts', 'attachments'], 'readwrite');
  tx.objectStore('vault').clear();
  tx.objectStore('items').clear();
  tx.objectStore('operations').clear();
  tx.objectStore('conflicts').clear();
  tx.objectStore('attachments').clear();
  await transactionDone(tx);
}

export async function getAllDecryptedStoreStats(db: AnchorDatabase) {
  const [items, ops, conflicts] = await Promise.all([
    getAllItems(db), getAllOperations(db), getAllConflicts(db),
  ]);
  return { itemCount: items.length, operationCount: ops.length, pendingOperationCount: ops.filter((op) => !op.pushed).length, conflictCount: conflicts.length };
}

/** Atomically persist a user's item and the encrypted outbox operation that syncs it. */
export async function putItemAndOperation(db: AnchorDatabase, item: StoredItem, operation: StoredOperation): Promise<void> {
  const tx = makeTransaction(db, ['items', 'operations'], 'readwrite');
  tx.objectStore('items').put(item);
  tx.objectStore('operations').put(operation);
  await transactionDone(tx);
}

/** Atomic optimistic write: detect same-origin tabs changing a record during encryption. */
export async function putItemAndOperationIfUnchanged(
  db: AnchorDatabase, item: StoredItem, operation: StoredOperation, expected: StoredItem | undefined,
): Promise<void> {
  const tx = makeTransaction(db, ['items', 'operations'], 'readwrite');
  const done = transactionDone(tx);
  let validationError: Error | null = null;
  const request = tx.objectStore('items').get(item.id);
  request.onsuccess = () => {
    const current = request.result as StoredItem | undefined;
    const unchanged = expected
      ? !!current && current.nonce === expected.nonce && current.ciphertext === expected.ciphertext && current.schemaVersion === expected.schemaVersion
      : current === undefined;
    if (!unchanged) {
      validationError = new Error('This record changed in another Anchor tab while you were saving. Nothing was overwritten; refresh and review the latest version.');
      try { tx.abort(); } catch { /* Already aborted or finished. */ }
      return;
    }
    tx.objectStore('items').put(item);
    tx.objectStore('operations').put(operation);
  };
  request.onerror = () => {
    validationError = new Error('Could not verify the record before writing. Nothing was overwritten.');
    try { tx.abort(); } catch { /* Already aborted or finished. */ }
  };
  try { await done; } catch (error) { throw validationError ?? error; }
}

/** Atomically apply a remote item and record its operation so replay is idempotent after crashes. */
export async function putRemoteItemAndOperation(db: AnchorDatabase, item: StoredItem, operation: StoredOperation): Promise<void> {
  await putItemAndOperation(db, item, operation);
}

export async function putConflictAndOperation(db: AnchorDatabase, conflict: StoredConflict, operation: StoredOperation): Promise<void> {
  const tx = makeTransaction(db, ['conflicts', 'operations'], 'readwrite');
  tx.objectStore('conflicts').put(conflict);
  tx.objectStore('operations').put(operation);
  await transactionDone(tx);
}


export async function putAttachmentChunk(db: AnchorDatabase, chunk: StoredAttachmentChunk): Promise<void> {
  const tx = makeTransaction(db, 'attachments', 'readwrite');
  tx.objectStore('attachments').put(chunk);
  await transactionDone(tx);
}

export async function getAttachmentChunks(db: AnchorDatabase, attachmentId: string): Promise<StoredAttachmentChunk[]> {
  const store = makeTransaction(db, 'attachments', 'readonly').objectStore('attachments');
  const rows = await requestResult(store.index('byAttachmentId').getAll(attachmentId)) as StoredAttachmentChunk[];
  return rows.sort((a, b) => a.chunkIndex - b.chunkIndex);
}

/** Return encrypted chunks for backup/export; call only while the vault is unlocked. */
export async function getAllStoredAttachmentChunks(db: AnchorDatabase): Promise<StoredAttachmentChunk[]> {
  return requestResult(makeTransaction(db, 'attachments', 'readonly').objectStore('attachments').getAll());
}

export async function deleteAttachmentChunks(db: AnchorDatabase, attachmentId: string): Promise<void> {
  const tx = makeTransaction(db, 'attachments', 'readwrite');
  const store = tx.objectStore('attachments');
  const done = transactionDone(tx);
  const request = store.index('byAttachmentId').getAll(attachmentId);
  request.onsuccess = () => { for (const row of request.result as StoredAttachmentChunk[]) store.delete(row.id); };
  request.onerror = () => { try { tx.abort(); } catch { /* Already complete. */ } };
  await done;
}

export async function putAttachmentChunkAndOperation(db: AnchorDatabase, chunk: StoredAttachmentChunk, operation: StoredOperation): Promise<void> {
  const tx = makeTransaction(db, ['attachments', 'operations'], 'readwrite');
  tx.objectStore('attachments').put(chunk);
  tx.objectStore('operations').put(operation);
  await transactionDone(tx);
}



export async function deleteAttachmentAndOperations(db: AnchorDatabase, attachmentId: string, operationIds: string[]): Promise<void> {
  const tx = makeTransaction(db, ['attachments', 'operations'], 'readwrite');
  const attachments = tx.objectStore('attachments');
  const done = transactionDone(tx);
  const request = attachments.index('byAttachmentId').getAll(attachmentId);
  request.onsuccess = () => {
    for (const row of request.result as StoredAttachmentChunk[]) attachments.delete(row.id);
    const operations = tx.objectStore('operations');
    for (const id of operationIds) operations.delete(id);
  };
  request.onerror = () => { try { tx.abort(); } catch { /* Already complete. */ } };
  await done;
}

export async function deleteOperation(db: AnchorDatabase, id: string): Promise<void> {
  const tx = makeTransaction(db, 'operations', 'readwrite');
  tx.objectStore('operations').delete(id);
  await transactionDone(tx);
}

/** Restore a validated encrypted backup only into a completely empty vault database. */
export async function restoreEncryptedStores(
  db: AnchorDatabase,
  meta: VaultMeta,
  items: StoredItem[],
  operations: StoredOperation[],
  conflicts: StoredConflict[],
  attachments: StoredAttachmentChunk[],
): Promise<void> {
  const stores = ['vault', 'items', 'operations', 'conflicts', 'attachments'];
  const tx = makeTransaction(db, stores, 'readwrite');
  const done = transactionDone(tx);
  let remaining = stores.length;
  let scheduled = false;
  let validationError: Error | null = null;
  const abort = (error: Error) => {
    validationError = error;
    try { tx.abort(); } catch { /* Already completed or aborted. */ }
  };
  for (const name of stores) {
    const request = tx.objectStore(name).count();
    request.onsuccess = () => {
      if (request.result !== 0) {
        abort(new Error('This browser profile already contains Anchor data. Export or explicitly wipe it before restoring a backup.'));
        return;
      }
      remaining -= 1;
      if (remaining !== 0 || scheduled || validationError) return;
      scheduled = true;
      // Queue all writes synchronously in the final count callback while the transaction is active.
      tx.objectStore('vault').put(meta);
      for (const row of items) tx.objectStore('items').put(row);
      for (const row of operations) tx.objectStore('operations').put(row);
      for (const row of conflicts) tx.objectStore('conflicts').put(row);
      for (const row of attachments) tx.objectStore('attachments').put(row);
    };
    request.onerror = () => { try { tx.abort(); } catch { /* Already completed. */ } };
  }
  try { await done; } catch (error) { throw validationError ?? error; }
}
