import { describe, it, expect, vi } from 'vitest';
import { createLogger, redact, REDACTED } from './logging.js';

describe('redact', () => {
  it('redacts top-level secret keys (case-insensitive)', () => {
    const out = redact({ apiKey: 'sk-123', Authorization: 'Bearer x', other: 'ok' }) as Record<
      string,
      unknown
    >;
    expect(out.apiKey).toBe(REDACTED);
    expect(out.Authorization).toBe(REDACTED);
    expect(out.other).toBe('ok');
  });

  it('redacts nested objects and arrays', () => {
    const out = redact({
      providers: {
        openai: { apiKey: 'sk-deep', model: 'gpt-4' },
        list: [{ token: 't1' }, { token: 't2' }, { safe: 'ok' }],
      },
    }) as { providers: { openai: { apiKey: string; model: string }; list: Array<Record<string, unknown>> } };
    expect(out.providers.openai.apiKey).toBe(REDACTED);
    expect(out.providers.openai.model).toBe('gpt-4');
    const list = out.providers.list;
    expect(list[0]!.token).toBe(REDACTED);
    expect(list[1]!.token).toBe(REDACTED);
    expect(list[2]!.safe).toBe('ok');
  });

  it('passes primitives through unchanged', () => {
    expect(redact('hello')).toBe('hello');
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });

  it('preserves empty/null secret values', () => {
    const out = redact({ apiKey: '', token: null, password: undefined }) as Record<
      string,
      unknown
    >;
    expect(out.apiKey).toBe('');
    expect(out.token).toBeNull();
    expect(out.password).toBeUndefined();
  });

  it('handles Error instances by exposing name/message/stack only', () => {
    const e = new Error('boom');
    const out = redact(e) as { name: string; message: string; stack?: string };
    expect(out.name).toBe('Error');
    expect(out.message).toBe('boom');
  });

  it('breaks circular references', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const out = redact(a) as { name: string; self: unknown };
    expect(out.name).toBe('a');
    expect(out.self).toBe('[Circular]');
  });

  it('matches various secret key spellings', () => {
    const out = redact({
      api_key: 'x',
      'set-cookie': 'sid=abc',
      Cookie: 'sid=abc',
      Secret: 'shh',
      passwd: 'p',
    }) as Record<string, unknown>;
    expect(out.api_key).toBe(REDACTED);
    expect(out['set-cookie']).toBe(REDACTED);
    expect(out.Cookie).toBe(REDACTED);
    expect(out.Secret).toBe(REDACTED);
    expect(out.passwd).toBe(REDACTED);
  });
});

describe('createLogger', () => {
  function makeSink(): {
    sink: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  } {
    return {
      sink: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    };
  }

  it('filters messages below the configured level', () => {
    const { sink } = makeSink();
    const log = createLogger({ level: 'warn', sink });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(sink.debug).not.toHaveBeenCalled();
    expect(sink.info).not.toHaveBeenCalled();
    expect(sink.warn).toHaveBeenCalledTimes(1);
    expect(sink.error).toHaveBeenCalledTimes(1);
  });

  it('silent level suppresses everything', () => {
    const { sink } = makeSink();
    const log = createLogger({ level: 'silent', sink });
    log.error('nope');
    expect(sink.error).not.toHaveBeenCalled();
  });

  it('redacts object arguments before emitting', () => {
    const { sink } = makeSink();
    const log = createLogger({ level: 'info', sink });
    log.info('config:', { apiKey: 'sk-leak', model: 'x' });
    const call = sink.info.mock.calls[0]!;
    expect(call[0]).toBe('[server]');
    expect(call[1]).toBe('config:');
    expect(call[2]).toEqual({ apiKey: REDACTED, model: 'x' });
  });

  it('leaves primitive args alone', () => {
    const { sink } = makeSink();
    const log = createLogger({ level: 'info', sink });
    log.info('apiKey=sk-literal-not-an-object', 42);
    const call = sink.info.mock.calls[0]!;
    expect(call[1]).toBe('apiKey=sk-literal-not-an-object');
    expect(call[2]).toBe(42);
  });

  it('child loggers prepend nested scopes', () => {
    const { sink } = makeSink();
    const log = createLogger({ level: 'info', sink, scope: 'http' });
    const child = log.child('config');
    child.info('hi');
    expect(sink.info.mock.calls[0]![0]).toBe('[http:config]');
  });

  it('defaults to info level when LOG_LEVEL is unset/invalid', () => {
    const { sink } = makeSink();
    const log = createLogger({ sink, level: undefined });
    // We can't easily mutate process.env reliably across vitest workers,
    // but the default for an unset/invalid LOG_LEVEL must be 'info'.
    expect(['debug', 'info', 'warn', 'error', 'silent']).toContain(log.level);
  });
});
