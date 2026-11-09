/**
 * Outbound request safety (SSRF protection for webhooks).
 *
 * URLs are checked when a webhook is saved, and — because DNS answers can change between then and
 * delivery (DNS rebinding) — the resolved address is checked again at connect time via a custom
 * `lookup` for node:http(s).
 */
import dns from 'node:dns';
import net from 'node:net';
import { badRequest } from './errors.js';

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata endpoints)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

function inV4Block(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

/** Expand an IPv6 address into 8 16-bit groups. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4)
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = v4ToInt(v4[1]);
    s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = s.includes('::') ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(fill).fill('0'), ...t].map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => Number.isFinite(g)) ? groups : null;
}

/** True for loopback, private, link-local, unique-local, multicast and otherwise non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return inV4Block(ip);
  if (!net.isIPv6(ip)) return true; // not an IP: treat as unsafe
  const g = v6Groups(ip);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d)
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return inV4Block(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0064 && g[1] === 0xff9b) return true; // NAT64 (maps to IPv4, possibly private)
  return false;
}

const hostOf = (u: URL) => u.hostname.replace(/^\[|\]$/g, '');

/**
 * Validate a webhook target URL. Rejects non-http(s) URLs and, unless private targets are allowed,
 * hosts that are or resolve to non-public addresses. Unresolvable hosts are allowed here (DNS may be
 * temporarily unavailable) because delivery re-checks at connect time.
 */
export async function assertSafeWebhookUrl(raw: string, allowPrivate: boolean): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('Webhook url must be an absolute http(s) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw badRequest('Webhook url must use http or https.');
  if (url.username || url.password) throw badRequest('Webhook url must not contain credentials.');
  if (allowPrivate) return;
  const host = hostOf(url).toLowerCase();
  const reject = () =>
    badRequest(
      'Webhook url points to a private or local network address.',
      'Use a publicly reachable URL, or ask your administrator to set WEBHOOK_ALLOW_PRIVATE=true.',
    );
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw reject();
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw reject();
    return;
  }
  let addrs: dns.LookupAddress[] = [];
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    return;
  }
  if (addrs.some((a) => isPrivateAddress(a.address))) throw reject();
}

/** A `lookup` for node:http(s) that refuses to connect to non-public addresses. */
export function guardedLookup(allowPrivate: boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
      if (err) return (callback as any)(err);
      const list = addresses as unknown as dns.LookupAddress[];
      const allowed = allowPrivate ? list : list.filter((a) => !isPrivateAddress(a.address));
      if (!allowed.length) {
        const e = Object.assign(new Error(`Refusing to connect to non-public address for ${hostname}`), { code: 'EBLOCKED' });
        return (callback as any)(e);
      }
      if ((options as any).all) return (callback as any)(null, allowed);
      return (callback as any)(null, allowed[0].address, allowed[0].family);
    });
  };
}
