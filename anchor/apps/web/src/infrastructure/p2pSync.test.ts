import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createP2PSyncBundle, applyP2PSyncBundle } from './p2pSync';
import * as dbModule from './database';
import * as repoModule from './repository';
import type { AnchorDatabase } from './database';
import type { StoredOperation, VaultSession } from '../domain/models';

describe('Direct P2P Offline Sync', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const dummySession: VaultSession = {
    vaultId: 'vault-uuid-1234',
    deviceId: 'device-id-5678',
    relayToken: 'token',
    relayUrl: '',
    key: {} as CryptoKey,
  };

  const dummyOps: StoredOperation[] = [
    {
      id: 'op-1',
      nonce: 'nonce-1',
      ciphertext: 'cipher-1',
      schemaVersion: 1,
      pushed: true,
      createdAt: '2026-10-25T00:00:00.000Z',
    },
    {
      id: 'op-2',
      nonce: 'nonce-2',
      ciphertext: 'cipher-2',
      schemaVersion: 1,
      pushed: true,
      createdAt: '2026-10-25T00:01:00.000Z',
    },
  ];

  it('exports an offline P2P sync bundle with correct metadata and operations', async () => {
    vi.spyOn(dbModule, 'getAllOperations').mockResolvedValue(dummyOps);

    const bundle = await createP2PSyncBundle({} as AnchorDatabase, dummySession);
    expect(bundle.kind).toBe('anchor-p2p-sync-bundle');
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.vaultId).toBe(dummySession.vaultId);
    expect(bundle.sourceDeviceId).toBe(dummySession.deviceId);
    expect(bundle.operations).toEqual(dummyOps);
  });

  it('applies a valid P2P sync bundle and reports applied operations', async () => {
    const applySpy = vi.spyOn(repoModule, 'applyRemoteOperation')
      .mockResolvedValueOnce('applied')
      .mockResolvedValueOnce('duplicate');

    const bundle = {
      schemaVersion: 1 as const,
      kind: 'anchor-p2p-sync-bundle' as const,
      vaultId: dummySession.vaultId,
      sourceDeviceId: 'device-other',
      exportedAt: new Date().toISOString(),
      operations: dummyOps,
    };

    const result = await applyP2PSyncBundle({} as AnchorDatabase, dummySession, bundle);

    expect(applySpy).toHaveBeenCalledTimes(2);
    expect(result.total).toBe(2);
    expect(result.applied).toBe(1);
    expect(result.duplicates).toBe(1);
  });

  it('rejects a sync bundle belonging to a different vault', async () => {
    const foreignBundle = {
      schemaVersion: 1 as const,
      kind: 'anchor-p2p-sync-bundle' as const,
      vaultId: 'foreign-vault-uuid',
      sourceDeviceId: 'foreign-device',
      exportedAt: new Date().toISOString(),
      operations: [],
    };

    await expect(applyP2PSyncBundle({} as AnchorDatabase, dummySession, foreignBundle))
      .rejects.toThrow(/different vault/i);
  });
});
