import net from "node:net";
import dns from "node:dns";

export const SAFE_URL_SCHEMES = new Set(["http:", "https:"]);
export const SAFE_RENDER_SCHEMES = new Set([
  "http:",
  "https:",
  "mailto:",
  "tel:",
]);

const IPV4_BLOCKED_RANGES: Array<{ start: number; end: number }> = [
  { start: 0x00000000, end: 0x00ffffff }, // 0.0.0.0/8 this network
  { start: 0x0a000000, end: 0x0affffff }, // 10.0.0.0/8 private
  { start: 0x64400000, end: 0x647fffff }, // 100.64.0.0/10 shared/CGNAT
  { start: 0x7f000000, end: 0x7fffffff }, // 127.0.0.0/8 loopback
  { start: 0xa9fe0000, end: 0xa9feffff }, // 169.254.0.0/16 link-local
  { start: 0xac100000, end: 0xac1fffff }, // 172.16.0.0/12 private
  { start: 0xc0000000, end: 0xc00000ff }, // 192.0.0.0/24 protocol
  { start: 0xc0000200, end: 0xc00002ff }, // 192.0.2.0/24 TEST-NET-1
  { start: 0xc0a80000, end: 0xc0a8ffff }, // 192.168.0.0/16 private
  { start: 0xc6120000, end: 0xc633ffff }, // 198.18.0.0/15 benchmarking
  { start: 0xc6336400, end: 0xc63364ff }, // 198.51.100.0/24 TEST-NET-2
  { start: 0xcb007100, end: 0xcb0071ff }, // 203.0.113.0/24 TEST-NET-3
  { start: 0xe0000000, end: 0xefffffff }, // 224.0.0.0/4 multicast
  { start: 0xf0000000, end: 0xffffffff }, // 240.0.0.0/4 reserved
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "host.docker.internal",
  "gateway.docker.internal",
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const segment = Number(part);
    if (!Number.isInteger(segment) || segment < 0 || segment > 255) return null;
    value = value * 256 + segment;
  }
  return value >>> 0;
}

export function isBlockedIpv4(ip: string): boolean {
  const numeric = ipv4ToInt(ip);
  if (numeric === null) return false;
  return IPV4_BLOCKED_RANGES.some(
    (range) => numeric >= range.start && numeric <= range.end,
  );
}

export function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) embedded v4.
  const mappedMatch = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedMatch && isBlockedIpv4(mappedMatch[1])) return true;
  const nat64Match = lower.match(/^64:ff9b::(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (nat64Match && isBlockedIpv4(nat64Match[1])) return true;

  if (lower === "::") return true; // unspecified
  if (lower === "::1") return true; // loopback
  if (/^f[c-d][0-9a-f]{2}:/i.test(lower)) return true; // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true; // fe80::/10 link-local
  if (/^ff:/i.test(lower)) return true; // ff00::/8 multicast
  if (lower.startsWith("2001:db8:")) return true; // documentation
  if (/^2001:1[0-9a-f]:/i.test(lower)) return true; // 2001:10::/28 ORCHID
  if (lower.startsWith("2002:")) return true; // 6to4
  if (lower.startsWith("2001::")) return true; // Teredo tunnel

  return false;
}

export function isBlockedIpLiteral(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  return false;
}

export function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (isBlockedIpLiteral(lower)) return true;
  if (BLOCKED_HOSTNAMES.has(lower)) return true;
  if (
    lower.endsWith(".local") ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".internal") ||
    lower.endsWith(".localdomain") ||
    lower.endsWith(".test")
  ) {
    return true;
  }
  // Single-label hostnames (no TLD) are only reachable on private networks.
  if (!lower.includes(".")) return true;
  return false;
}

export function isSafeUrlScheme(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return SAFE_URL_SCHEMES.has(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Validates that a URL uses an allowed scheme and points at a public,
 * non-reserved address. Throws an {@link UnsafeUrlError} when the URL is
 * unsafe.
 */
export async function assertSafeFetchUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("Malformed URL.");
  }
  if (!SAFE_URL_SCHEMES.has(parsed.protocol)) {
    throw new UnsafeUrlError("Unsupported URL scheme.");
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new UnsafeUrlError("Host is reserved or non-public.");
  }
  if (net.isIP(parsed.hostname)) return;

  let address: dns.LookupAddress;
  try {
    address = await dns.promises.lookup(parsed.hostname);
  } catch {
    throw new UnsafeUrlError("Host could not be resolved.");
  }

  if (isBlockedIpLiteral(address.address)) {
    throw new UnsafeUrlError("Host resolves to a non-public address.");
  }
}

export function isSafeSiteUrl(rawUrl: string): Promise<boolean> {
  return assertSafeFetchUrl(rawUrl)
    .then(() => true)
    .catch(() => false);
}

/**
 * Returns true if href is safe to render as a link: relative paths, fragment
 * links and whitelisted schemes only. Blocks javascript:, data:, vbscript:
 * and similar schemes.
 */
export function isSafeRenderHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("#")) return true;
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../")
  ) {
    return true;
  }
  const schemeMatch = trimmed.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:/);
  if (!schemeMatch) return false;
  return SAFE_RENDER_SCHEMES.has(schemeMatch[0].toLowerCase());
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}