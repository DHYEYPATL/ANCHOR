import { base64ToBytes, bytesToBase64 } from './base64';

const PBKDF2_ITERATIONS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export async function deriveWrappingKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  if (passphrase.length < 12) throw new Error('Use a passphrase with at least 12 characters.');
  if (passphrase.length > 1024) throw new Error('Passphrase is too long. Use at most 1,024 characters.');
  const passphraseBytes = encoder.encode(passphrase);
  let material: CryptoKey;
  try { material = await crypto.subtle.importKey('raw', passphraseBytes, 'PBKDF2', false, ['deriveKey']); }
  finally { passphraseBytes.fill(0); }
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export async function importVaultKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptBytes(key: CryptoKey, bytes: Uint8Array, aad: string): Promise<{ nonce: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad), tagLength: 128 }, key, bytes);
  return { nonce: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

export async function decryptBytes(key: CryptoKey, nonce: string, ciphertext: string, aad: string): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(nonce), additionalData: encoder.encode(aad), tagLength: 128 },
    key, base64ToBytes(ciphertext),
  );
  return new Uint8Array(plaintext);
}

export async function encryptJson<T>(key: CryptoKey, value: T, aad: string) {
  const bytes = encoder.encode(JSON.stringify(value));
  try { return await encryptBytes(key, bytes, aad); }
  finally { bytes.fill(0); }
}

export async function decryptJson<T>(key: CryptoKey, nonce: string, ciphertext: string, aad: string): Promise<T> {
  const bytes = await decryptBytes(key, nonce, ciphertext, aad);
  try { return JSON.parse(decoder.decode(bytes)) as T; }
  finally { bytes.fill(0); }
}

export function encodeRawKey(key: Uint8Array): string { return bytesToBase64(key); }
export function decodeRawKey(value: string): Uint8Array { return base64ToBytes(value); }

export function constantTimeTextEqual(a: string, b: string): boolean {
  // Used only for UI consistency checks, not as a replacement for server-side crypto.
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
