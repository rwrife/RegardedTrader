/**
 * BackoffPolicy — capped exponential backoff with jitter and Retry-After
 * support. Pure / no I/O. Used by the polling scheduler when a job throws or
 * a transport surfaces a server-side rate-limit hint.
 */

export interface BackoffOptions {
  /** Initial delay in ms. Default: 1_000 */
  readonly baseMs?: number;
  /** Cap for any single delay in ms. Default: 60_000 */
  readonly maxMs?: number;
  /** Exponential factor. Default: 2 */
  readonly factor?: number;
  /** ±jitterRatio (e.g. 0.1 = ±10%). Default: 0.2 */
  readonly jitterRatio?: number;
  /** RNG hook for deterministic tests. Default: Math.random */
  readonly random?: () => number;
}

export interface RetryHint {
  /** Honour an HTTP `Retry-After` header. May be a delta-seconds number, a
   *  numeric string, or an HTTP-date string. */
  readonly retryAfter?: string | number;
}

export class BackoffPolicy {
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly factor: number;
  private readonly jitterRatio: number;
  private readonly random: () => number;
  private attempt = 0;

  constructor(options: BackoffOptions = {}) {
    this.baseMs = options.baseMs ?? 1_000;
    this.maxMs = options.maxMs ?? 60_000;
    this.factor = options.factor ?? 2;
    this.jitterRatio = options.jitterRatio ?? 0.2;
    this.random = options.random ?? Math.random;
  }

  /** How many failures we've recorded since the last reset. */
  get attempts(): number {
    return this.attempt;
  }

  /** Reset the failure counter (call on success). */
  reset(): void {
    this.attempt = 0;
  }

  /** Compute the next delay in ms, optionally honouring a server hint. Each
   *  call increments the attempt counter. */
  nextDelay(hint?: RetryHint, now: Date = new Date()): number {
    this.attempt += 1;
    const hintMs = parseRetryAfter(hint?.retryAfter, now);
    if (hintMs !== null) {
      // Always clamp so a misbehaving server can't pin us forever.
      return Math.min(hintMs, this.maxMs);
    }
    const exp = Math.min(
      this.maxMs,
      this.baseMs * Math.pow(this.factor, this.attempt - 1),
    );
    const jitter = 1 + (this.random() * 2 - 1) * this.jitterRatio;
    return Math.max(0, Math.min(this.maxMs, Math.round(exp * jitter)));
  }
}

/**
 * Parse an HTTP `Retry-After` value into ms. Accepts:
 *   - numeric (seconds)
 *   - numeric string (seconds)
 *   - HTTP-date string
 * Returns null when the value is missing or unparseable.
 */
export function parseRetryAfter(
  value: string | number | undefined,
  now: Date = new Date(),
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value * 1000));
  }
  const trimmed = String(value).trim();
  if (trimmed === '') return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.round(Number.parseFloat(trimmed) * 1000));
  }
  const ts = Date.parse(trimmed);
  if (!Number.isNaN(ts)) {
    return Math.max(0, ts - now.getTime());
  }
  return null;
}
