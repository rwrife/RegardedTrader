import { TickerProfile, type PartialTickerProfile } from '../schemas/ticker.js';
import type { TickerSource } from './source.js';

/**
 * Per-source result captured by the resolver. Useful for diagnostics on
 * failure and for tests asserting which sources contributed.
 */
export interface SourceOutcome {
  source: string;
  ok: boolean;
  /** Reason the source did not contribute, if `ok` is false. */
  reason?: 'missing' | 'timeout' | 'error';
  error?: string;
  /** The partial returned by the source, if any. */
  partial?: PartialTickerProfile;
}

export class TickerResolutionError extends Error {
  readonly input: string;
  readonly outcomes: SourceOutcome[];
  constructor(message: string, input: string, outcomes: SourceOutcome[]) {
    super(message);
    this.name = 'TickerResolutionError';
    this.input = input;
    this.outcomes = outcomes;
  }
}

export interface TickerResolverOptions {
  /** Per-resolve global timeout, in milliseconds. Default 4000. */
  timeoutMs?: number;
}

const SYMBOL_RE = /^[A-Za-z.\-]{1,10}$/;

function isLikelySymbol(input: string): boolean {
  return SYMBOL_RE.test(input);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Reconcile a set of per-source partials into a single `TickerProfile`.
 *
 * Strategy:
 *  - Symbol: most common canonical symbol across partials, tie-break by
 *    summed source weight.
 *  - String fields (name, exchange, sector, industry, description): pick the
 *    value from the highest-weight source that supplied a non-empty value.
 *  - sourceUrls: union, de-duplicated, preserving first-seen order.
 *  - confidence: sum(weight of contributing sources) / sum(weight of all
 *    sources that were *consulted*), clamped to [0, 1].
 */
export function reconcile(
  partials: ReadonlyArray<{ partial: PartialTickerProfile; weight: number; sourceName: string }>,
  totalWeight: number,
  validatedAt: string,
): TickerProfile {
  if (partials.length === 0) {
    throw new Error('reconcile: no partials');
  }

  // Pick canonical symbol by weighted vote.
  const symbolVotes = new Map<string, number>();
  for (const { partial, weight } of partials) {
    symbolVotes.set(partial.symbol, (symbolVotes.get(partial.symbol) ?? 0) + weight);
  }
  let symbol = partials[0]!.partial.symbol;
  let bestVote = -1;
  for (const [sym, vote] of symbolVotes) {
    if (vote > bestVote) {
      bestVote = vote;
      symbol = sym;
    }
  }

  // Highest weight first for string-field selection.
  const ordered = [...partials].sort((a, b) => b.weight - a.weight);

  const pickString = (key: 'name' | 'exchange' | 'sector' | 'industry' | 'description'): string | null => {
    for (const { partial } of ordered) {
      const value = partial[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }
    return null;
  };

  const urls: string[] = [];
  const seenUrls = new Set<string>();
  for (const { partial } of ordered) {
    for (const u of partial.sourceUrls ?? []) {
      if (!seenUrls.has(u)) {
        seenUrls.add(u);
        urls.push(u);
      }
    }
  }

  const contributingWeight = partials.reduce((s, p) => s + p.weight, 0);
  const denom = totalWeight > 0 ? totalWeight : contributingWeight;
  const confidence = denom > 0 ? Math.max(0, Math.min(1, contributingWeight / denom)) : 0;

  const name = pickString('name');
  const exchange = pickString('exchange');
  if (name === null || exchange === null) {
    throw new Error('reconcile: missing required field (name or exchange)');
  }

  return TickerProfile.parse({
    symbol,
    name,
    exchange,
    sector: pickString('sector'),
    industry: pickString('industry'),
    description: pickString('description'),
    sourceUrls: urls,
    validatedAt,
    confidence,
    sources: partials.map((p) => p.sourceName),
  });
}

/**
 * Orchestrates a set of `TickerSource`s in parallel with a global timeout,
 * then reconciles their partials into a single `TickerProfile`.
 *
 * Throws `TickerResolutionError` if no source produced a usable partial.
 */
export class TickerResolver {
  private readonly sources: ReadonlyArray<TickerSource>;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(sources: ReadonlyArray<TickerSource>, opts: TickerResolverOptions & { now?: () => Date } = {}) {
    this.sources = sources;
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Resolve free-text input (a symbol or a company-name-ish query) into a
   * single `TickerProfile`. Runs every configured source in parallel; the
   * whole call is bounded by `timeoutMs`.
   */
  async resolve(input: string): Promise<TickerProfile> {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      throw new TickerResolutionError('empty input', input, []);
    }
    if (this.sources.length === 0) {
      throw new TickerResolutionError('no sources configured', input, []);
    }

    const symbolMode = isLikelySymbol(trimmed);
    const normalizedSymbol = symbolMode ? trimmed.toUpperCase() : null;

    const totalWeight = this.sources.reduce((s, src) => s + src.weight, 0);
    const outcomes: SourceOutcome[] = [];
    const contributors: { partial: PartialTickerProfile; weight: number; sourceName: string }[] = [];

    const tasks = this.sources.map(async (src): Promise<void> => {
      try {
        const result = await withTimeout<PartialTickerProfile | PartialTickerProfile[] | null>(
          normalizedSymbol !== null ? src.fetch(normalizedSymbol) : src.search(trimmed).then((rs) => rs[0] ?? null),
          this.timeoutMs,
        );
        if (result === null || (Array.isArray(result) && result.length === 0)) {
          outcomes.push({ source: src.name, ok: false, reason: 'missing' });
          return;
        }
        const partial = Array.isArray(result) ? result[0]! : result;
        outcomes.push({ source: src.name, ok: true, partial });
        contributors.push({ partial, weight: src.weight, sourceName: src.name });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const reason: SourceOutcome['reason'] = msg === 'timeout' ? 'timeout' : 'error';
        outcomes.push({ source: src.name, ok: false, reason, error: msg });
      }
    });

    await Promise.all(tasks);

    if (contributors.length === 0) {
      throw new TickerResolutionError(
        `no source could resolve "${input}"`,
        input,
        outcomes,
      );
    }

    try {
      return reconcile(contributors, totalWeight, this.now().toISOString());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TickerResolutionError(`reconciliation failed: ${msg}`, input, outcomes);
    }
  }
}
