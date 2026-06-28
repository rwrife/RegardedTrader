/**
 * Tiny typed logger for the server. Wraps `console.*` and applies recursive
 * redaction to any object/array argument so we cannot accidentally leak
 * provider API keys, bearer tokens, or other secrets via logs.
 *
 * AGENTS.md Hard Rule #3: "No secrets in the repo … the server is the only
 * consumer." Logs are an obvious leak channel for those secrets — this module
 * makes the safe path the easy path.
 *
 * Level is controlled by the `LOG_LEVEL` env var (`debug|info|warn|error|silent`,
 * default `info`). The level value itself is never logged.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** Keys whose values must be redacted in logs, case-insensitive substring match. */
const REDACT_KEY_PATTERNS = [
  'apikey',
  'api_key',
  'authorization',
  'token',
  'secret',
  'password',
  'passwd',
  'cookie',
  'set-cookie',
];

export const REDACTED = '[REDACTED]';

function shouldRedactKey(key: string): boolean {
  const k = key.toLowerCase();
  return REDACT_KEY_PATTERNS.some((p) => k.includes(p));
}

/**
 * Recursively redact secret-bearing fields in `value`. Returns a new value;
 * the input is never mutated. Cycles are broken with `[Circular]`.
 */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen));
  }

  // Preserve Error shape so messages still surface in logs.
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (shouldRedactKey(k)) {
      out[k] = v === null || v === undefined || v === '' ? v : REDACTED;
    } else {
      out[k] = redact(v, seen);
    }
  }
  return out;
}

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  /** Returns a new logger that prepends `[scope]` to every message. */
  child: (scope: string) => Logger;
  /** Test-only / runtime access. */
  level: LogLevel;
}

export interface LoggerOptions {
  level?: LogLevel;
  scope?: string;
  /** Override the underlying sink. Defaults to console. */
  sink?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

function parseLevel(raw: string | undefined): LogLevel {
  const v = (raw ?? '').toLowerCase().trim();
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error' || v === 'silent') {
    return v;
  }
  return 'info';
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level: LogLevel = opts.level ?? parseLevel(process.env.LOG_LEVEL);
  const sink = opts.sink ?? console;
  const scopeTag = opts.scope ? `[${opts.scope}]` : '[server]';
  const threshold = LEVEL_ORDER[level];

  function emit(target: LogLevel, args: unknown[]): void {
    if (LEVEL_ORDER[target] < threshold) return;
    const cleaned = args.map((a) => (typeof a === 'object' && a !== null ? redact(a) : a));
    const head = `${scopeTag}`;
    const fn =
      target === 'debug'
        ? sink.debug
        : target === 'info'
          ? sink.info
          : target === 'warn'
            ? sink.warn
            : sink.error;
    fn.call(sink, head, ...cleaned);
  }

  const logger: Logger = {
    level,
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    child: (scope) =>
      createLogger({
        level,
        sink,
        scope: opts.scope ? `${opts.scope}:${scope}` : scope,
      }),
  };
  return logger;
}

/** Process-wide default logger used by server modules. */
export const logger: Logger = createLogger();
