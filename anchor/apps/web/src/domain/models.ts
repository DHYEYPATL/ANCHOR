export type ItemKind = 'task' | 'event' | 'promise' | 'note' | 'consumable' | 'document';
export type ItemStatus = 'open' | 'done' | 'archived';
export type VersionVector = Record<string, number>;

export interface AttachmentMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  chunkCount: number;
  createdAt: string;
}

export interface AnchorItem {
  id: string;
  kind: ItemKind;
  title: string;
  body: string;
  status: ItemStatus;
  createdAt: string;
  updatedAt: string;
  dueAt?: string;
  category?: string;
  sourceText?: string;
  sourceLabel?: string;
  confidence?: 'high' | 'medium' | 'low';
  quantity?: number;
  unit?: string;
  dailyRate?: number;
  reorderThreshold?: number;
  versionVector: VersionVector;
  deletedAt?: string;
  reminderMinutesBefore?: number;
  recurrence?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  doseLogs?: { timestamp: string; status: 'taken' | 'skipped' }[];
  attachments?: AttachmentMetadata[];
}

export interface EncryptedBlob {
  id: string;
  nonce: string;
  ciphertext: string;
  schemaVersion: 1;
}

export interface VaultMeta {
  key: 'active';
  vaultId: string;
  salt: string;
  wrapNonce: string;
  wrappedVaultKey: string;
  secretNonce: string;
  encryptedSecret: string;
  deviceId: string;
  relayUrl: string;
  lastPulledCursor: number;
  createdAt: string;
}

export interface VaultSecret {
  relayToken: string;
}

export interface VaultSession {
  vaultId: string;
  deviceId: string;
  key: CryptoKey;
  relayToken: string;
  relayUrl: string;
}

export interface StoredItem extends EncryptedBlob { id: string; }
export interface StoredOperation extends EncryptedBlob {
  pushed: boolean;
  createdAt: string;
}

export type OperationPayload = ItemOperationPayload | AttachmentChunkOperationPayload;

export interface ItemOperationPayload {
  schemaVersion: 1;
  operationId: string;
  deviceId: string;
  kind: 'item';
  operation: 'upsert' | 'delete';
  item: AnchorItem;
}

export interface AttachmentChunkOperationPayload {
  schemaVersion: 1;
  operationId: string;
  deviceId: string;
  kind: 'attachment-chunk';
  attachmentId: string;
  chunkIndex: number;
  chunkCount: number;
  chunkNonce: string;
  chunkCiphertext: string;
  plaintextSize: number;
  relatedItemId: string;
}

export interface StoredAttachmentChunk {
  id: string;
  attachmentId: string;
  chunkIndex: number;
  chunkCount: number;
  nonce: string;
  ciphertext: string;
  plaintextSize: number;
}

export interface StoredConflict extends EncryptedBlob {
  conflictId: string;
  itemId: string;
  createdAt: string;
}

export type SyncState = 'local-only' | 'idle' | 'syncing' | 'synced' | 'offline' | 'error';
