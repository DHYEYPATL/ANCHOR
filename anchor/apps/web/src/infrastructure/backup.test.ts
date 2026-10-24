import { describe, expect, it } from 'vitest';
import { validateEncryptedBackup } from './backup';

function base64OfLength(length: number) {
  const bytes = new Uint8Array(length);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function validBackup() {
  const vaultId = '05f4e9a2-2ce5-4c42-a194-49f4ed5a22a7';
  return {
    format: 'anchor-encrypted-backup-v1', schemaVersion: 1,
    exportedAt: '2026-10-25T00:00:00.000Z', note: 'test backup',
    vault: {
      key: 'active', vaultId, salt: base64OfLength(16), wrapNonce: base64OfLength(12),
      wrappedVaultKey: base64OfLength(48), secretNonce: base64OfLength(12), encryptedSecret: base64OfLength(32),
      deviceId: `device-${vaultId}`, relayUrl: '', lastPulledCursor: 0, createdAt: '2026-10-25T00:00:00.000Z',
    },
    items: [] as unknown[], operations: [] as unknown[], conflicts: [] as unknown[], attachments: [] as unknown[],
  };
}

describe('encrypted backup validation', () => {
  it('accepts a structurally valid empty backup', () => {
    expect(() => validateEncryptedBackup(validBackup())).not.toThrow();
  });
  it('rejects unsupported formats before restore', () => {
    expect(() => validateEncryptedBackup({ ...validBackup(), format: 'other' })).toThrow(/unsupported|malformed/i);
  });
  it('rejects unknown root and vault metadata fields', () => {
    const root = { ...validBackup(), unexpected: 'payload' };
    expect(() => validateEncryptedBackup(root)).toThrow(/unsupported|malformed/i);
    const backup = validBackup();
    (backup.vault as Record<string, unknown>).unexpected = 'payload';
    expect(() => validateEncryptedBackup(backup)).toThrow(/vault metadata/i);
  });
  it('rejects impossible calendar dates instead of allowing date normalization', () => {
    expect(() => validateEncryptedBackup({ ...validBackup(), exportedAt: '2026-02-31T00:00:00.000Z' })).toThrow(/unsupported|malformed/i);
  });
  it('rejects invalid key material lengths', () => {
    const backup = validBackup();
    backup.vault.salt = base64OfLength(15);
    expect(() => validateEncryptedBackup(backup)).toThrow(/key material/i);
  });
  it('rejects malformed attachment objects without throwing a raw TypeError', () => {
    const backup = validBackup();
    backup.attachments = [{ attachmentId: '05f4e9a2-2ce5-4c42-a194-49f4ed5a22a7', id: undefined }];
    expect(() => validateEncryptedBackup(backup)).toThrow(/attachment chunk/i);
  });
  it('rejects extra cleartext fields on encrypted item envelopes', () => {
    const backup = validBackup();
    backup.items = [{ id: '05f4e9a2-2ce5-4c42-a194-49f4ed5a22a7', nonce: base64OfLength(12), ciphertext: base64OfLength(32), schemaVersion: 1, title: 'must never be cleartext here' }];
    expect(() => validateEncryptedBackup(backup)).toThrow(/encrypted record envelope/i);
  });
  it('rejects duplicate item IDs rather than overwriting on restore', () => {
    const backup = validBackup();
    const row = { id: '05f4e9a2-2ce5-4c42-a194-49f4ed5a22a7', nonce: base64OfLength(12), ciphertext: base64OfLength(32), schemaVersion: 1 };
    backup.items = [row, row];
    expect(() => validateEncryptedBackup(backup)).toThrow(/duplicate item/i);
  });
  it('rejects relay URLs that cannot be safely configured', () => {
    const backup = validBackup();
    backup.vault.relayUrl = 'http://public.example.com';
    expect(() => validateEncryptedBackup(backup)).toThrow(/HTTPS/i);
  });
});
