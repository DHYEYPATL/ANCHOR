import type { VaultMeta, VaultSecret, VaultSession } from '../domain/models';
import { base64ToBytes, randomToken } from './base64';
import { decryptJson, deriveWrappingKey, encryptJson, importVaultKey } from './crypto';
import { getVaultMeta, openDb, saveVaultMeta, saveVaultMetaIfEmpty, type AnchorDatabase } from './database';
import { normalizeRelayUrl } from './relayUrl';

export interface UnlockedVault { db: AnchorDatabase; meta: VaultMeta; session: VaultSession; }

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validateVaultMeta(value: unknown): asserts value is VaultMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Vault metadata is malformed.');
  const meta = value as Partial<VaultMeta>;
  if (meta.key !== 'active' || typeof meta.vaultId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(meta.vaultId) ||
      !isBoundedText(meta.salt, 100) || !isBoundedText(meta.wrapNonce, 100) || !isBoundedText(meta.wrappedVaultKey, 500) ||
      !isBoundedText(meta.secretNonce, 100) || !isBoundedText(meta.encryptedSecret, 500) ||
      typeof meta.deviceId !== 'string' || !/^device-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(meta.deviceId) ||
      typeof meta.relayUrl !== 'string' || meta.relayUrl.length > 2048 || !Number.isSafeInteger(meta.lastPulledCursor) || Number(meta.lastPulledCursor) < 0 ||
      typeof meta.createdAt !== 'string' || !Number.isFinite(Date.parse(meta.createdAt))) {
    throw new Error('Vault metadata is malformed or uses an unsupported schema. Do not delete the database; restore a verified export if available.');
  }
  normalizeRelayUrl(meta.relayUrl);
  try {
    if (base64ToBytes(meta.salt).length !== 16 || base64ToBytes(meta.wrapNonce).length !== 12 ||
        base64ToBytes(meta.secretNonce).length !== 12 || base64ToBytes(meta.wrappedVaultKey).length < 32 ||
        base64ToBytes(meta.encryptedSecret).length < 16) throw new Error();
  } catch { throw new Error('Vault cryptographic metadata is malformed. Do not delete the database; restore a verified export if available.'); }
}

export async function createVault(passphrase: string, relayUrl = ''): Promise<UnlockedVault> {
  if (!globalThis.crypto?.subtle) throw new Error('This browser does not provide WebCrypto. Use localhost or a secure HTTPS origin.');
  const normalizedRelay = normalizeRelayUrl(relayUrl);
  const db = await openDb();
  let succeeded = false;
  let vaultKeyRaw: Uint8Array | null = null;
  try {
    const current = await getVaultMeta(db);
    if (current) throw new Error('A local vault already exists. Unlock it or export it before creating another.');
    const vaultId = crypto.randomUUID();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    vaultKeyRaw = crypto.getRandomValues(new Uint8Array(32));
    const wrappingKey = await deriveWrappingKey(passphrase, salt);
    const wrapped = await encryptJson(wrappingKey, Array.from(vaultKeyRaw), `vault-key:${vaultId}`);
    const vaultKey = await importVaultKey(vaultKeyRaw);
    const secret: VaultSecret = { relayToken: randomToken(32) };
    const secretEnc = await encryptJson(vaultKey, secret, `vault-secret:${vaultId}`);
    const meta: VaultMeta = {
      key: 'active', vaultId, salt: btoa(String.fromCharCode(...salt)), wrapNonce: wrapped.nonce,
      wrappedVaultKey: wrapped.ciphertext, secretNonce: secretEnc.nonce, encryptedSecret: secretEnc.ciphertext,
      deviceId: `device-${crypto.randomUUID()}`, relayUrl: normalizedRelay,
      lastPulledCursor: 0, createdAt: new Date().toISOString(),
    };
    await saveVaultMetaIfEmpty(db, meta);
    succeeded = true;
    const session: VaultSession = { vaultId, deviceId: meta.deviceId, key: vaultKey, relayToken: secret.relayToken, relayUrl: meta.relayUrl };
    return { db, meta, session };
  } finally {
    vaultKeyRaw?.fill(0);
    if (!succeeded) db.close();
  }
}

export async function unlockVault(passphrase: string): Promise<UnlockedVault> {
  const db = await openDb();
  const meta = await getVaultMeta(db);
  if (!meta) { db.close(); throw new Error('No vault exists on this device. Create or import one first.'); }
  try {
    validateVaultMeta(meta);
    const wrappingKey = await deriveWrappingKey(passphrase, base64ToBytes(meta.salt));
    const rawArray = await decryptJson<number[]>(wrappingKey, meta.wrapNonce, meta.wrappedVaultKey, `vault-key:${meta.vaultId}`);
    if (!Array.isArray(rawArray) || rawArray.length !== 32 || rawArray.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      if (Array.isArray(rawArray)) rawArray.fill(0);
      throw new Error('Vault key material has an invalid length or encoding.');
    }
    const vaultKeyRaw = new Uint8Array(rawArray);
    try {
      const vaultKey = await importVaultKey(vaultKeyRaw);
      const secret = await decryptJson<VaultSecret>(vaultKey, meta.secretNonce, meta.encryptedSecret, `vault-secret:${meta.vaultId}`);
      if (!secret || typeof secret.relayToken !== 'string' || !/^[A-Za-z0-9_-]{40,100}$/.test(secret.relayToken)) {
        throw new Error('Vault relay credential is malformed.');
      }
      const session: VaultSession = { vaultId: meta.vaultId, deviceId: meta.deviceId, key: vaultKey, relayToken: secret.relayToken, relayUrl: meta.relayUrl };
      return { db, meta, session };
    } finally { vaultKeyRaw.fill(0); rawArray.fill(0); }
  } catch {
    db.close();
    throw new Error('Could not unlock the vault. Check the passphrase; it may be wrong or the local data may be damaged.');
  }
}

export async function updateRelayConfig(db: AnchorDatabase, meta: VaultMeta, session: VaultSession, relayUrl: string) {
  const normalized = normalizeRelayUrl(relayUrl);
  const enc = await encryptJson(session.key, { relayToken: session.relayToken } satisfies VaultSecret, `vault-secret:${meta.vaultId}`);
  const updated = { ...meta, relayUrl: normalized, secretNonce: enc.nonce, encryptedSecret: enc.ciphertext };
  await saveVaultMeta(db, updated);
  return { meta: updated, session: { ...session, relayUrl: normalized } };
}

export interface PairingBundle {
  format: 'anchor-pairing-v1';
  warning: string;
  vault: Omit<VaultMeta, 'deviceId' | 'lastPulledCursor'>;
  relayUrl: string;
}

export function exportPairingBundle(meta: VaultMeta): PairingBundle {
  return {
    format: 'anchor-pairing-v1',
    warning: 'Contains relay access credentials and a passphrase-wrapped vault key. Protect this file; unlock still requires your passphrase.',
    vault: {
      key: 'active', vaultId: meta.vaultId, salt: meta.salt, wrapNonce: meta.wrapNonce,
      wrappedVaultKey: meta.wrappedVaultKey, secretNonce: meta.secretNonce, encryptedSecret: meta.encryptedSecret,
      relayUrl: meta.relayUrl, createdAt: meta.createdAt,
    },
    relayUrl: meta.relayUrl,
  };
}

export async function importPairingBundle(bundle: PairingBundle): Promise<void> {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || bundle.format !== 'anchor-pairing-v1' ||
      typeof bundle.warning !== 'string' || bundle.warning.length > 1000 || !bundle.vault || typeof bundle.vault !== 'object' || Array.isArray(bundle.vault) ||
      typeof bundle.relayUrl !== 'string' || bundle.relayUrl.length > 2048) {
    throw new Error('This is not a valid Anchor pairing file.');
  }
  const rootKeys = ['format', 'warning', 'vault', 'relayUrl'];
  if (Object.keys(bundle).some((key) => !rootKeys.includes(key))) throw new Error('Pairing file contains unsupported fields. Nothing was imported.');
  const source = bundle.vault as Partial<VaultMeta>;
  const sourceKeys = ['key', 'vaultId', 'salt', 'wrapNonce', 'wrappedVaultKey', 'secretNonce', 'encryptedSecret', 'relayUrl', 'createdAt'];
  if (Object.keys(bundle.vault).some((key) => !sourceKeys.includes(key)) || sourceKeys.some((key) => !(key in bundle.vault)) ||
      source.key !== 'active' || typeof source.vaultId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(source.vaultId) ||
      typeof source.salt !== 'string' || source.salt.length > 100 || typeof source.wrapNonce !== 'string' || source.wrapNonce.length > 100 ||
      typeof source.wrappedVaultKey !== 'string' || source.wrappedVaultKey.length > 500 ||
      typeof source.secretNonce !== 'string' || source.secretNonce.length > 100 || typeof source.encryptedSecret !== 'string' || source.encryptedSecret.length > 500 ||
      typeof source.createdAt !== 'string' || !Number.isFinite(Date.parse(source.createdAt)) || typeof source.relayUrl !== 'string' || source.relayUrl.length > 2048) {
    throw new Error('Pairing file fields are incomplete or invalid. Nothing was imported.');
  }
  const relayUrl = normalizeRelayUrl(bundle.relayUrl || source.relayUrl || '');
  const db = await openDb();
  try {
    const existing = await getVaultMeta(db);
    if (existing) throw new Error('This device already has a vault. Export or wipe the current vault before importing another.');
    const meta: VaultMeta = {
      key: 'active', vaultId: source.vaultId, salt: source.salt, wrapNonce: source.wrapNonce,
      wrappedVaultKey: source.wrappedVaultKey, secretNonce: source.secretNonce, encryptedSecret: source.encryptedSecret,
      createdAt: source.createdAt, deviceId: `device-${crypto.randomUUID()}`, relayUrl, lastPulledCursor: 0,
    };
    // Verify that base64-encoded key material has plausible lengths before persistence.
    const encoded = [meta.salt, meta.wrapNonce, meta.wrappedVaultKey, meta.secretNonce, meta.encryptedSecret];
    if (encoded.some((part) => !/^[A-Za-z0-9+/]+={0,2}$/.test(part)) ||
        base64ToBytes(meta.salt).length !== 16 || base64ToBytes(meta.wrapNonce).length !== 12 ||
        base64ToBytes(meta.secretNonce).length !== 12 || base64ToBytes(meta.wrappedVaultKey).length < 32 ||
        base64ToBytes(meta.encryptedSecret).length < 16) {
      throw new Error('Pairing file cryptographic fields are malformed. Nothing was imported.');
    }
    await saveVaultMetaIfEmpty(db, meta);
  } finally { db.close(); }
}

export function importTextBundle(text: string): PairingBundle {
  if (text.length > 1_000_000) throw new Error('Pairing file is too large.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Pairing file is not valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).format !== 'anchor-pairing-v1') {
    throw new Error('Unsupported or malformed pairing file version.');
  }
  return value as PairingBundle;
}

export function exportEncryptedBackupText(meta: VaultMeta) {
  return JSON.stringify({ format: 'anchor-encrypted-pairing-backup-v1', exportedAt: new Date().toISOString(), bundle: exportPairingBundle(meta) }, null, 2);
}

export function isSecureContextAvailable() { return window.isSecureContext && !!crypto?.subtle; }
