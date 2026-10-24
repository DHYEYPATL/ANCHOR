const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isPrivateIPv4(host: string): boolean {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return false;
  const [a, b] = octets;
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

function isLocalOrPrivateHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  // Match actual IPv6 address prefixes only. A hostname such as `fd-sync.example.com`
  // must not be classified as private merely because its DNS name begins with `fd`.
  const uniqueLocalIPv6 = /^f[cd][0-9a-f]{2}:/i.test(normalized); // fc00::/7
  const linkLocalIPv6 = /^fe[89ab][0-9a-f]:/i.test(normalized); // fe80::/10
  return LOOPBACK.has(host.toLowerCase()) || normalized === '::1' || normalized.endsWith('.localhost') ||
    isPrivateIPv4(normalized) || uniqueLocalIPv6 || linkLocalIPv6;
}

/** Normalize and constrain the relay destination before saving it or sending a request. */
export function normalizeRelayUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length > 2048) throw new Error('Relay URL is too long.');
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new Error('Enter a valid relay URL.'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('Relay URL cannot contain credentials, query parameters or fragments.');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('Relay must be configured at an origin root (for example, https://sync.example.com).');
  const local = isLocalOrPrivateHost(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Use HTTPS for public relays. HTTP is allowed only for localhost or private-network development.');
  }
  if (!url.hostname) throw new Error('Relay host is missing.');
  return url.origin.replace(/\/$/, '');
}
