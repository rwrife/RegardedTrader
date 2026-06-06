import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MarketClock } from './market-clock.js';
import { Scheduler, type Job } from './scheduler.js';
import { BackoffPolicy } from './backoff.js';

function constantClock(state: 'rth' | 'pre' | 'post' | 'closed' | 'holiday' = 'rth'): MarketClock {
  return {
    state: () => state,
    isOpen: () => state === 'rth',
    isHoliday: () => state === 'holiday',
    closeTimeFor: () => '16:00',
    getCalendar: () => ({
      timezone: 'America/New_York',
      regularHours: { open: '09:30', close: '16:00' },
      holidays: new Set<string>(),
      earlyCloses: new Map<string, string>(),
    }),
  } as unknown as MarketClock;
}

function makeScheduler(overrides: Partial<ConstructorParameters<typeof Scheduler>[0]> = {}) {
  return new Scheduler({
    clock: constantClock(),
    jitterRatio: 0, // deterministic
    random: () => 0.5,
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Scheduler', () => {
  it('runs a registered job on its cadence after start()', async () => {
    const calls: number[] = [];
    const job: Job = {
      id: 'tick',
      cadence: () => 1_000,
      run: () => {
        calls.push(Date.now());
      },
    };
    const sched = makeScheduler();
    sched.register(job);
    sched.start();

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(calls.length).toBe(3);
    sched.stop();
  });

  it('cadence reads from MarketClock.state', async () => {
    let state: 'rth' | 'closed' = 'closed';
    const clock = {
      state: () => state,
    } as unknown as MarketClock;
    let counter = 0;
    const sched = new Scheduler({
      clock,
      jitterRatio: 0,
      random: () => 0.5,
    });
    sched.register({
      id: 'cadence-aware',
      cadence: (s) => (s === 'rth' ? 100 : 10_000),
      run: () => {
        counter += 1;
      },
    });
    sched.start();

    await vi.advanceTimersByTimeAsync(150);
    expect(counter).toBe(0); // closed → 10s cadence

    state = 'rth';
    sched.pauseAll();
    sched.resumeAll();
    await vi.advanceTimersByTimeAsync(105);
    expect(counter).toBe(1);

    sched.stop();
  });

  it('single-flight prevents overlapping runs', async () => {
    let active = 0;
    let maxActive = 0;
    let completed = 0;
    const sched = makeScheduler();
    sched.register({
      id: 'slow',
      cadence: () => 50,
      singleFlight: true,
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 200));
        active -= 1;
        completed += 1;
      },
    });
    sched.start();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(maxActive).toBe(1);
    expect(completed).toBeGreaterThan(0);
    sched.stop();
  });

  it('exposes a per-job state machine: idle → running → idle', async () => {
    let release: (() => void) | null = null;
    const sched = makeScheduler();
    sched.register({
      id: 'gated',
      cadence: () => 10,
      run: () =>
        new Promise<void>((resolve) => {
          release = resolve as () => void;
        }),
    });
    sched.start();

    await vi.advanceTimersByTimeAsync(15);
    expect(sched.statusOf('gated')).toBe('running');
    (release as (() => void) | null)?.();
    // Let the resolved promise + scheduleNext settle.
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(sched.statusOf('gated')).toBe('idle');
    sched.stop();
  });

  it('moves to backing-off on errors and uses BackoffPolicy', async () => {
    let attempts = 0;
    const sched = makeScheduler();
    sched.register({
      id: 'flaky',
      cadence: () => 1_000,
      backoff: new BackoffPolicy({ baseMs: 200, maxMs: 5_000, jitterRatio: 0 }),
      run: () => {
        attempts += 1;
        throw new Error('boom');
      },
    });
    sched.start();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(1);
    expect(sched.statusOf('flaky')).toBe('backing-off');

    // First backoff = 200ms.
    await vi.advanceTimersByTimeAsync(200);
    expect(attempts).toBe(2);
    // Second backoff = 400ms.
    await vi.advanceTimersByTimeAsync(400);
    expect(attempts).toBe(3);
    sched.stop();
  });

  it('honours Retry-After on thrown errors', async () => {
    let attempts = 0;
    const sched = makeScheduler();
    sched.register({
      id: 'rate-limited',
      cadence: () => 1_000,
      backoff: new BackoffPolicy({ baseMs: 100, jitterRatio: 0 }),
      run: () => {
        attempts += 1;
        const err = Object.assign(new Error('429'), { retryAfter: 3 });
        throw err;
      },
    });
    sched.start();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(1);
    // baseMs (100) would fire at 100ms; Retry-After of 3s should win.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(2);
    sched.stop();
  });

  it('global pause/resume halts and restarts every job', async () => {
    let count = 0;
    const sched = makeScheduler();
    sched.register({
      id: 'a',
      cadence: () => 100,
      run: () => {
        count += 1;
      },
    });
    sched.start();

    await vi.advanceTimersByTimeAsync(250);
    const before = count;
    expect(before).toBeGreaterThan(0);

    sched.pauseAll();
    expect(sched.isPaused).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(count).toBe(before);

    sched.resumeAll();
    await vi.advanceTimersByTimeAsync(150);
    expect(count).toBeGreaterThan(before);
    sched.stop();
  });

  it('per-job pause/resume only affects the targeted job', async () => {
    let a = 0;
    let b = 0;
    const sched = makeScheduler();
    sched.register({ id: 'a', cadence: () => 50, run: () => { a += 1; } });
    sched.register({ id: 'b', cadence: () => 50, run: () => { b += 1; } });
    sched.start();

    await vi.advanceTimersByTimeAsync(120);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);

    sched.pause('a');
    expect(sched.statusOf('a')).toBe('paused');
    const aBefore = a;
    const bBefore = b;
    await vi.advanceTimersByTimeAsync(200);
    expect(a).toBe(aBefore);
    expect(b).toBeGreaterThan(bBefore);

    sched.resume('a');
    await vi.advanceTimersByTimeAsync(120);
    expect(a).toBeGreaterThan(aBefore);
    sched.stop();
  });

  it('unregister cancels future runs', async () => {
    let count = 0;
    const sched = makeScheduler();
    sched.register({ id: 'temp', cadence: () => 50, run: () => { count += 1; } });
    sched.start();

    await vi.advanceTimersByTimeAsync(120);
    const before = count;
    expect(before).toBeGreaterThan(0);

    expect(sched.unregister('temp')).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(count).toBe(before);
    sched.stop();
  });

  it('jitter stays within the configured ratio', async () => {
    const intervals: number[] = [];
    let last = 0;
    const sched = makeScheduler({ jitterRatio: 0.1, random: () => 0 }); // -10%
    sched.register({
      id: 'jit',
      cadence: () => 1_000,
      run: () => {
        const now = Date.now();
        if (last !== 0) intervals.push(now - last);
        last = now;
      },
    });
    sched.start();

    await vi.advanceTimersByTimeAsync(5_000);
    sched.stop();
    for (const i of intervals) {
      expect(i).toBeGreaterThanOrEqual(900);
      expect(i).toBeLessThanOrEqual(1_100);
    }
  });

  it('snapshot returns the current status of every job', () => {
    const sched = makeScheduler();
    sched.register({ id: 'a', cadence: () => 1_000, run: () => undefined });
    sched.register({ id: 'b', cadence: () => 1_000, run: () => undefined });
    const snap = sched.snapshot().sort((x, y) => x.id.localeCompare(y.id));
    expect(snap).toEqual([
      { id: 'a', status: 'idle' },
      { id: 'b', status: 'idle' },
    ]);
  });

  it('onError hook receives thrown errors without escaping', async () => {
    const errors: unknown[] = [];
    const sched = makeScheduler({
      onError: (id, err) => errors.push({ id, err }),
    });
    sched.register({
      id: 'oops',
      cadence: () => 50,
      run: () => {
        throw new Error('nope');
      },
    });
    sched.start();
    await vi.advanceTimersByTimeAsync(80);
    expect(errors.length).toBe(1);
    sched.stop();
  });

  it('reapplyCadences reschedules idle jobs to the current cadence', async () => {
    let state: 'rth' | 'closed' = 'rth';
    let listener: (() => void) | null = null;
    const clock = {
      state: () => state,
      isOpen: () => state === 'rth',
      isHoliday: () => false,
      closeTimeFor: () => '16:00',
      getCalendar: () => ({
        timezone: 'America/New_York',
        regularHours: { open: '09:30', close: '16:00' },
        holidays: new Set<string>(),
        earlyCloses: new Map<string, string>(),
      }),
      onCalendarUpdate: (cb: () => void) => {
        listener = cb;
        return () => {
          listener = null;
        };
      },
      _trigger(): void {
        const cb = listener;
        if (cb) cb();
      },
    };

    const calls: number[] = [];
    const sched = new Scheduler({
      clock: clock as unknown as MarketClock,
      jitterRatio: 0,
      random: () => 0.5,
    });
    sched.register({
      id: 'cadence-swap',
      // 1s while RTH; 60s when closed. After a calendar update flips state,
      // reapplyCadences should reschedule the next tick to the closed cadence.
      cadence: (s) => (s === 'rth' ? 1_000 : 60_000),
      run: () => {
        calls.push(Date.now());
      },
    });
    sched.start();

    // Two RTH ticks at 1s cadence.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(calls.length).toBe(2);

    // Flip state and fire the calendar-update listener; the scheduler should
    // reapply cadences and the next tick should NOT fire within 1s.
    state = 'closed';
    clock._trigger();

    const before = calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.length).toBe(before);

    // ...but it should fire by the new 60s cadence.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(before + 1);

    sched.stop();
  });
});
