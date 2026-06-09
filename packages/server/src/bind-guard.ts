import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';

/**
 * Defence-in-depth runtime guard that the server only binds to a loopback
 * address (AGENTS.md Hard Rule #1). The config layer rejects non-loopback
 * `server.host` values, but env-var overrides, programmatic callers in tests,
 * or a future bug in config validation could otherwise silently expose the
 * server on a public interface. This module is the last line of defence
 * before `server.listen(...)`.
 */

const LOOPBACK_NAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);

/** True if a literal IP string is in `127.0.0.0/8` or is `::1`. */
export function isLoopbackAddress(addr: string): boolean {
  // Strip an IPv6 zone identifier (e.g. `fe80::1%eth0`) before classifying.
  const cleaned = addr.replace(/%.*$/, '');
  if (cleaned === '::1') return true;
  // IPv4-mapped IPv6 (`::ffff:127.0.0.1`) — peel and re-check.
  if (cleaned.toLowerCase().startsWith('::ffff:')) {
    return isLoopbackAddress(cleaned.slice('::ffff:'.length));
  }
  if (isIP(cleaned) === 4) return cleaned.startsWith('127.');
  return false;
}

/** True if an `Origin` header (a full URL) points at a loopback host. */
export function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // Node's `URL.hostname` keeps the brackets for IPv6 literals
  // (`http://[::1]:3000` → `[::1]`); strip them before classifying.
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  if (LOOPBACK_NAMES.has(host)) return true;
  if (isIP(host)) return isLoopbackAddress(host);
  return false;
}

/**
 * Resolve `host` and throw a clear error if any resolved address is not a
 * loopback address. Names like `localhost` are accepted by name (we don't
 * trust /etc/hosts to point them anywhere weird — but we still verify via
 * DNS that they don't resolve to a public IP).
 *
 * The error message points the user at `regard config`, per AGENTS.md.
 */
export async function assertLoopbackHost(
  host: string,
  lookup: (h: string) => Promise<Array<{ address: string }>> = (h) =>
    dnsPromises.lookup(h, { all: true }),
): Promise<void> {
  if (typeof host !== 'string' || host.length === 0) {
    throw new Error(
      'Refusing to bind: server.host is empty. Set it to 127.0.0.1 via `regard config`.',
    );
  }
  const lowered = host.toLowerCase();

  if (isIP(lowered)) {
    if (isLoopbackAddress(lowered)) return;
    throw new Error(
      `Refusing to bind to non-loopback host "${host}". RegardedTrader is local-only — fix it with \`regard config\`.`,
    );
  }

  // Hostname path: must resolve, and every resolved address must be loopback.
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(lowered);
  } catch (e) {
    throw new Error(
      `Refusing to bind: could not resolve host "${host}" (${(e as Error).message}). Set server.host to 127.0.0.1 via \`regard config\`.`,
    );
  }
  if (addrs.length === 0) {
    throw new Error(
      `Refusing to bind: host "${host}" did not resolve. Set server.host to 127.0.0.1 via \`regard config\`.`,
    );
  }
  for (const a of addrs) {
    if (!isLoopbackAddress(a.address)) {
      throw new Error(
        `Refusing to bind to non-loopback host "${host}" (resolves to ${a.address}). RegardedTrader is local-only — fix it with \`regard config\`.`,
      );
    }
  }
}
