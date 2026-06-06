/**
 * Scheduler — periodic job runner for RegardedTrader's polling subsystem.
 *
 * Per issue #20:
 *   - Register named jobs `{ id, run(ctx), cadence, singleFlight? }`
 *   - Cadence is a function of `MarketClock.state` returning a ms interval
 *   - Per-job mutex so a slow run never overlaps itself
 *   - Per-job state machine: idle | running | backing-off | paused
 *   - Global pause/resume API
 *   - ±10% jitter baked into every interval
 *
 * The Scheduler is intentionally framework-free: it talks to a `MarketClock`,
 * a clock-injector for tests (`now`/`setTimeout`/`clearTimeout`), and the Job
 * objects themselves. No transport / no disk / no logger.
 */

import { BackoffPolicy, type RetryHint } from './backoff.js';
import type { MarketClock, MarketState } from './market-clock.js';

export type JobStatus = 'idle' | 'running' | 'backing-off' | 'paused';

export type CadencePolicy = (state: MarketState) => number;

export interface JobContext {
  readonly id: string;
  readonly state: MarketState;
  readonly attempt: number;
  readonly now: Date;
}

export interface Job {
  readonly id: string;
  readonly cadence: CadencePolicy;
  readonly singleFlight?: boolean;
  readonly backoff?: BackoffPolicy;
  run(ctx: JobContext): Promise<void> | void;
}

export interface JobError extends Error {
  /** Optional `Retry-After` hint (seconds, numeric string, or HTTP-date). */
  readonly retryAfter?: string | number;
}

export interface SchedulerOptions {
  readonly clock: MarketClock;
  /** Time source. Default: `() => new Date()`. */
  readonly now?: () => Date;
  /** Default ±jitter ratio applied to every cadence interval. Default: 0.1. */
  readonly jitterRatio?: number;
  /** RNG for jitter (deterministic in tests). Default: Math.random. */
  readonly random?: () => number;
  /**
   * Timer hooks. Defaults to global `setTimeout`/`clearTimeout`. Tests pass
   * vitest's fake-timer-aware implementations or a custom scheduler.
   */
  readonly setTimeout?: (cb: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** Optional error hook for diagnostics; never thrown. */
  readonly onError?: (jobId: string, err: unknown) => void;
}

interface JobRecord {
  readonly job: Job;
  status: JobStatus;
  /** Status before pause(); restored by resume(). */
  resumeTo: Exclude<JobStatus, 'paused'>;
  inflight: boolean;
  timer: unknown;
  backoff: BackoffPolicy;
  /** Monotonic counter for safely cancelling stale timers. */
  generation: number;
}

const DEFAULT_JITTER = 0.1;
const MIN_INTERVAL_MS = 1; // setTimeout(0) can starve the loop on some platforms

export class Scheduler {
  private readonly clock: MarketClock;
  private readonly now: () => Date;
  private readonly jitterRatio: number;
  private readonly random: () => number;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly onError?: (jobId: string, err: unknown) => void;
  private readonly jobs = new Map<string, JobRecord>();
  private globallyPaused = false;
  private started = false;
  private unsubscribeCalendar: (() => void) | null = null;

  constructor(options: SchedulerOptions) {
    this.clock = options.clock;
    this.now = options.now ?? (() => new Date());
    this.jitterRatio = options.jitterRatio ?? DEFAULT_JITTER;
    this.random = options.random ?? Math.random;
    this.setTimeoutFn =
      options.setTimeout ??
      ((cb, ms) => setTimeout(cb, ms) as unknown);
    this.clearTimeoutFn =
      options.clearTimeout ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      });
    this.onError = options.onError;
    if (typeof (this.clock as { onCalendarUpdate?: unknown }).onCalendarUpdate === 'function') {
      this.unsubscribeCalendar = this.clock.onCalendarUpdate(() => {
        this.reapplyCadences();
      });
    }
  }

  /**
   * Reschedule the next tick for every idle / backing-off job using the
   * current `MarketClock.state`. Inflight runs are left alone (they'll
   * reschedule themselves when they complete). Paused jobs stay paused.
   *
   * Wired automatically to `MarketClock.onCalendarUpdate` when the clock
   * exposes one, so a `calendar.update` (e.g. early close at 13:00 ET
   * lands mid-session) reapplies cadences across the boundary.
   */
  reapplyCadences(): void {
    if (!this.started || this.globallyPaused) return;
    for (const rec of this.jobs.values()) {
      if (rec.status === 'paused') continue;
      if (rec.inflight) continue;
      this.scheduleNext(rec);
    }
  }

  /** Add a job to the registry. Idempotent on `id`: re-registering replaces. */
  register(job: Job): void {
    const existing = this.jobs.get(job.id);
    if (existing) {
      this.cancelTimer(existing);
    }
    const record: JobRecord = {
      job,
      status: 'idle',
      resumeTo: 'idle',
      inflight: false,
      timer: null,
      backoff: job.backoff ?? new BackoffPolicy(),
      generation: existing ? existing.generation + 1 : 0,
    };
    this.jobs.set(job.id, record);
    if (this.started && !this.globallyPaused) {
      this.scheduleNext(record);
    }
  }

  /** Remove a job from the registry, cancelling any pending timer. */
  unregister(id: string): boolean {
    const rec = this.jobs.get(id);
    if (!rec) return false;
    this.cancelTimer(rec);
    rec.status = 'idle';
    this.jobs.delete(id);
    return true;
  }

  /** Begin scheduling. No-op if already started. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.globallyPaused) return;
    for (const rec of this.jobs.values()) {
      if (rec.status !== 'paused') this.scheduleNext(rec);
    }
  }

  /** Stop scheduling and cancel all timers. Inflight runs finish naturally. */
  stop(): void {
    this.started = false;
    for (const rec of this.jobs.values()) {
      this.cancelTimer(rec);
    }
    if (this.unsubscribeCalendar) {
      this.unsubscribeCalendar();
      this.unsubscribeCalendar = null;
    }
  }

  /** Pause everything (global). Inflight runs are NOT aborted. */
  pauseAll(): void {
    this.globallyPaused = true;
    for (const rec of this.jobs.values()) {
      this.cancelTimer(rec);
    }
  }

  /** Resume everything (global). */
  resumeAll(): void {
    if (!this.globallyPaused) return;
    this.globallyPaused = false;
    if (!this.started) return;
    for (const rec of this.jobs.values()) {
      if (rec.status !== 'paused') this.scheduleNext(rec);
    }
  }

  /** Pause a single job. */
  pause(id: string): boolean {
    const rec = this.jobs.get(id);
    if (!rec) return false;
    if (rec.status === 'paused') return true;
    rec.resumeTo = rec.status === 'running' ? 'idle' : rec.status;
    rec.status = 'paused';
    this.cancelTimer(rec);
    return true;
  }

  /** Resume a single job. */
  resume(id: string): boolean {
    const rec = this.jobs.get(id);
    if (!rec) return false;
    if (rec.status !== 'paused') return true;
    rec.status = rec.resumeTo;
    if (this.started && !this.globallyPaused) {
      this.scheduleNext(rec);
    }
    return true;
  }

  /** Inspect the current status of a job. */
  statusOf(id: string): JobStatus | undefined {
    return this.jobs.get(id)?.status;
  }

  /** Snapshot of every registered job's status. */
  snapshot(): { id: string; status: JobStatus }[] {
    return [...this.jobs.values()].map((r) => ({ id: r.job.id, status: r.status }));
  }

  /** True if any global pause is in effect. */
  get isPaused(): boolean {
    return this.globallyPaused;
  }

  private cancelTimer(rec: JobRecord): void {
    if (rec.timer !== null && rec.timer !== undefined) {
      this.clearTimeoutFn(rec.timer);
      rec.timer = null;
    }
    rec.generation += 1;
  }

  private scheduleNext(rec: JobRecord, overrideMs?: number): void {
    if (!this.started || this.globallyPaused) return;
    if (rec.status === 'paused') return;
    this.cancelTimer(rec);
    const baseMs =
      overrideMs ?? this.applyJitter(rec.job.cadence(this.clock.state(this.now())));
    const ms = Math.max(MIN_INTERVAL_MS, Math.round(baseMs));
    const generation = rec.generation;
    rec.timer = this.setTimeoutFn(() => {
      // Stale timer guard.
      if (rec.generation !== generation) return;
      void this.fire(rec);
    }, ms);
  }

  private applyJitter(intervalMs: number): number {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return MIN_INTERVAL_MS;
    if (this.jitterRatio <= 0) return intervalMs;
    const factor = 1 + (this.random() * 2 - 1) * this.jitterRatio;
    return intervalMs * factor;
  }

  private async fire(rec: JobRecord): Promise<void> {
    if (!this.started || this.globallyPaused) return;
    if (rec.status === 'paused') return;

    const singleFlight = rec.job.singleFlight !== false; // default on
    if (singleFlight && rec.inflight) {
      // Skip this tick; reschedule based on cadence.
      this.scheduleNext(rec);
      return;
    }

    rec.inflight = true;
    rec.status = 'running';
    const ctx: JobContext = {
      id: rec.job.id,
      state: this.clock.state(this.now()),
      attempt: rec.backoff.attempts + 1,
      now: this.now(),
    };

    try {
      await rec.job.run(ctx);
      rec.backoff.reset();
      rec.inflight = false;
      if ((rec.status as JobStatus) === 'paused') return; // paused mid-run
      rec.status = 'idle';
      this.scheduleNext(rec);
    } catch (err) {
      rec.inflight = false;
      this.onError?.(rec.job.id, err);
      if ((rec.status as JobStatus) === 'paused') return;
      const hint: RetryHint = {
        retryAfter: (err as JobError | undefined)?.retryAfter,
      };
      const delay = rec.backoff.nextDelay(hint, this.now());
      rec.status = 'backing-off';
      this.scheduleNext(rec, delay);
    }
  }
}
