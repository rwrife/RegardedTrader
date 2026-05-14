/**
 * Tiny robots.txt checker for HTML scrapes.
 *
 * Not a full RFC9309 implementation: we only support the directives we need
 * (User-agent, Allow, Disallow) with longest-match precedence and a
 * `User-agent: *` fallback. Per-host responses are cached in-memory.
 *
 * `politeFetch` for first-party JSON endpoints (e.g. EDGAR `submissions`,
 * Yahoo's `query2.finance.yahoo.com`) should bypass this check via
 * `RobotsCache.skip(host)`; the resolver layer is responsible for the policy
 * decision per source. This module just answers "is path X allowed?".
 */

import type { FetchLike } from './http.js';
import { DEFAULT_USER_AGENT } from './http.js';

export interface RobotsCacheOptions {
  fetchImpl?: FetchLike;
  userAgent?: string;
  /** TTL for cached robots.txt in ms. Default 1h. */
  ttlMs?: number;
  now?: () => number;
}

interface Rule {
  type: 'allow' | 'disallow';
  path: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

interface CacheEntry {
  groups: Group[];
  fetchedAt: number;
  /** True if we couldn't fetch robots.txt — treat as allow-all. */
  unreachable: boolean;
}

export class RobotsCache {
  private readonly fetchImpl: FetchLike;
  private readonly ua: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly skipped = new Set<string>();

  constructor(opts: RobotsCacheOptions = {}) {
    const f = opts.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new Error('RobotsCache: no global fetch available; pass fetchImpl');
    this.fetchImpl = f;
    this.ua = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Mark a host as exempt from robots.txt checks (first-party documented JSON APIs). */
  skip(host: string): void {
    this.skipped.add(host.toLowerCase());
  }

  /**
   * Check whether `url` is allowed for our User-Agent.
   * Returns `true` if robots.txt is missing/unreachable (fail-open is the
   * common-practice default and matches major crawlers).
   */
  async isAllowed(url: string): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.host.toLowerCase();
    if (this.skipped.has(host)) return true;

    const entry = await this.load(parsed.protocol, host);
    if (entry.unreachable) return true;

    const path = parsed.pathname + (parsed.search || '');
    const group = matchGroup(entry.groups, this.ua) ?? matchGroup(entry.groups, '*');
    if (!group) return true;

    const decision = decide(group.rules, path);
    return decision;
  }

  private async load(protocol: string, host: string): Promise<CacheEntry> {
    const cached = this.cache.get(host);
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) return cached;

    const url = `${protocol}//${host}/robots.txt`;
    let entry: CacheEntry;
    try {
      const resp = await this.fetchImpl(url, {
        headers: { 'User-Agent': this.ua, Accept: 'text/plain, */*' },
        redirect: 'follow',
      });
      if (resp.status >= 200 && resp.status < 300) {
        const body = await resp.text();
        entry = { groups: parseRobots(body), fetchedAt: this.now(), unreachable: false };
      } else if (resp.status >= 400 && resp.status < 500) {
        entry = { groups: [], fetchedAt: this.now(), unreachable: true };
      } else {
        entry = { groups: [], fetchedAt: this.now(), unreachable: true };
      }
    } catch {
      entry = { groups: [], fetchedAt: this.now(), unreachable: true };
    }
    this.cache.set(host, entry);
    return entry;
  }
}

export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let pendingAgents: string[] = [];
  let inAgentBlock = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (inAgentBlock && current) {
        // Starting a new contiguous block of agents — push any in-progress group.
        groups.push(current);
        current = null;
      }
      pendingAgents.push(value);
      inAgentBlock = false;
      continue;
    }

    if (field === 'allow' || field === 'disallow') {
      if (!current) {
        if (pendingAgents.length === 0) pendingAgents = ['*'];
        current = { agents: pendingAgents.map((a) => a.toLowerCase()), rules: [] };
        pendingAgents = [];
      }
      inAgentBlock = true;
      // An empty Disallow means "allow all" — treat as no-op rule.
      if (field === 'disallow' && value === '') continue;
      current.rules.push({ type: field, path: value });
    }
    // Other fields (Crawl-delay, Sitemap, ...) are ignored.
  }
  if (current) groups.push(current);
  return groups;
}

function matchGroup(groups: Group[], ua: string): Group | null {
  const lower = ua.toLowerCase();
  // Pick the most-specific agent token that appears in our UA string.
  let best: Group | null = null;
  let bestLen = -1;
  for (const g of groups) {
    for (const agent of g.agents) {
      if (agent === '*') {
        if (best === null && bestLen < 0) best = g;
        continue;
      }
      if (lower.includes(agent) && agent.length > bestLen) {
        best = g;
        bestLen = agent.length;
      }
    }
  }
  return best;
}

function decide(rules: Rule[], path: string): boolean {
  // Longest-match wins; on equal length, Allow wins (per Google's spec).
  let bestLen = -1;
  let bestAllow = true;
  for (const r of rules) {
    if (!matchPath(r.path, path)) continue;
    if (r.path.length > bestLen || (r.path.length === bestLen && r.type === 'allow')) {
      bestLen = r.path.length;
      bestAllow = r.type === 'allow';
    }
  }
  return bestLen < 0 ? true : bestAllow;
}

function matchPath(pattern: string, path: string): boolean {
  if (!pattern) return true;
  // Support `*` wildcard and `$` end-of-string anchor.
  const hasWildcard = pattern.includes('*') || pattern.endsWith('$');
  if (!hasWildcard) return path.startsWith(pattern);
  const anchorEnd = pattern.endsWith('$');
  const body = anchorEnd ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split('*')
    .map((seg) => seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const re = new RegExp('^' + escaped + (anchorEnd ? '$' : ''));
  return re.test(path);
}
