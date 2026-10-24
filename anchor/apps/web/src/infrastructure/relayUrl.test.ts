import { describe, expect, it } from 'vitest';
import { normalizeRelayUrl } from './relayUrl';

describe('relay URL guard', () => {
  it('normalizes a public HTTPS relay origin', () => {
    expect(normalizeRelayUrl(' https://sync.example.com/ ')).toBe('https://sync.example.com');
  });
  it('allows loopback and RFC1918 HTTP development endpoints', () => {
    expect(normalizeRelayUrl('http://localhost:8080/')).toBe('http://localhost:8080');
    expect(normalizeRelayUrl('http://192.168.1.8:8080')).toBe('http://192.168.1.8:8080');
    expect(normalizeRelayUrl('http://[::1]:8080')).toBe('http://[::1]:8080');
    expect(normalizeRelayUrl('http://[fd12:3456::1]:8080')).toBe('http://[fd12:3456::1]:8080');
  });
  it('rejects plaintext internet endpoints', () => {
    expect(() => normalizeRelayUrl('http://sync.example.com')).toThrow(/HTTPS/i);
  });
  it('does not mistake public hostnames beginning with IPv6-private prefixes for private IP addresses', () => {
    expect(() => normalizeRelayUrl('http://fd-sync.example.com')).toThrow(/HTTPS/i);
    expect(() => normalizeRelayUrl('http://fc-evil.example.com')).toThrow(/HTTPS/i);
  });
  it('rejects credential-bearing and non-root URLs', () => {
    expect(() => normalizeRelayUrl('https://user:pass@sync.example.com')).toThrow(/credentials/i);
    expect(() => normalizeRelayUrl('https://sync.example.com/path')).toThrow(/origin root/i);
    expect(() => normalizeRelayUrl('https://sync.example.com/?token=abc')).toThrow(/query/i);
  });
  it('bounds the input and supports local-only mode', () => {
    expect(normalizeRelayUrl('')).toBe('');
    expect(() => normalizeRelayUrl('https://a.com/' + 'x'.repeat(2048))).toThrow(/too long/i);
  });
});
