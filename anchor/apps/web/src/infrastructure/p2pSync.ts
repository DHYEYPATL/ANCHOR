/**
 * Direct Offline Peer-to-Peer (P2P) Synchronization module.
 * Enables syncing between devices over local Wi-Fi, hotspot, AirDrop, or local file transfer
 * without requiring any internet connection or hosted relay server.
 * All transferred operations are AES-GCM encrypted and authenticated using the vault's session key.
 */

import type { StoredOperation, VaultSession } from '../domain/models';
import type { AnchorDatabase } from './database';
import { getAllOperations } from './database';
import { applyRemoteOperation } from './repository';

export interface P2PSyncBundle {
  schemaVersion: 1;
  kind: 'anchor-p2p-sync-bundle';
  vaultId: string;
  sourceDeviceId: string;
  exportedAt: string;
  operations: StoredOperation[];
}

export interface P2PSyncResult {
  total: number;
  applied: number;
  duplicates: number;
  conflicts: number;
  ignored: number;
}

/**
 * Creates an encrypted offline sync bundle containing the latest operations from this device.
 */
export async function createP2PSyncBundle(
  db: AnchorDatabase,
  session: VaultSession,
  maxOperations = 300,
): Promise<P2PSyncBundle> {
  const allOps = await getAllOperations(db);
  // Take the most recent operations
  const slice = allOps.slice(-maxOperations);

  return {
    schemaVersion: 1,
    kind: 'anchor-p2p-sync-bundle',
    vaultId: session.vaultId,
    sourceDeviceId: session.deviceId,
    exportedAt: new Date().toISOString(),
    operations: slice,
  };
}

/**
 * Imports and applies a direct P2P sync bundle onto this device.
 */
export async function applyP2PSyncBundle(
  db: AnchorDatabase,
  session: VaultSession,
  bundle: unknown,
): Promise<P2PSyncResult> {
  if (!bundle || typeof bundle !== 'object') {
    throw new Error('Invalid sync bundle format.');
  }

  const b = bundle as Partial<P2PSyncBundle>;
  if (b.kind !== 'anchor-p2p-sync-bundle' || b.schemaVersion !== 1) {
    throw new Error('Unsupported sync bundle format or version.');
  }

  if (b.vaultId !== session.vaultId) {
    throw new Error('This sync bundle belongs to a different vault. Devices must share the same vault passphrase.');
  }

  if (!Array.isArray(b.operations)) {
    throw new Error('Sync bundle does not contain a valid operations list.');
  }

  let applied = 0;
  let duplicates = 0;
  let conflicts = 0;
  let ignored = 0;

  for (const op of b.operations) {
    if (!op || typeof op.id !== 'string' || typeof op.ciphertext !== 'string' || typeof op.nonce !== 'string') {
      continue;
    }

    try {
      const outcome = await applyRemoteOperation(db, session, {
        id: op.id,
        nonce: op.nonce,
        ciphertext: op.ciphertext,
        schemaVersion: op.schemaVersion || 1,
        pushed: true,
        createdAt: op.createdAt || new Date().toISOString(),
      });

      if (outcome === 'applied') applied += 1;
      else if (outcome === 'duplicate') duplicates += 1;
      else if (outcome === 'conflict') conflicts += 1;
      else ignored += 1;
    } catch {
      // Individual operation decryption failure (e.g. invalid auth tag or corruption)
      ignored += 1;
    }
  }

  return {
    total: b.operations.length,
    applied,
    duplicates,
    conflicts,
    ignored,
  };
}
