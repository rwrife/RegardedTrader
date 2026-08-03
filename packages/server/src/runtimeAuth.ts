import { logger } from './logging.js';

export type RuntimeAuth =
  | { mode: 'required'; token: string; dashboardOrigin: string }
  | { mode: 'allow-no-auth' };

export interface ParseRuntimeAuthOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}

export function parseRuntimeAuth(
  opts: ParseRuntimeAuthOptions = {},
): RuntimeAuth {
  const argv = opts.argv ?? process.argv.slice(2);
  const env = opts.env ?? process.env;

  let token = env.REGARDEDTRADER_AUTH_TOKEN?.trim() || '';
  let allowNoAuth = false;
  let dashboardOrigin = env.REGARDEDTRADER_DASHBOARD_ORIGIN?.trim() || '';

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--allow-no-auth') {
      allowNoAuth = true;
      continue;
    }
    if (a === '--auth-token') {
      token = (argv[i + 1] ?? '').trim();
      i += 1;
      continue;
    }
    if (a === '--dashboard-origin') {
      dashboardOrigin = (argv[i + 1] ?? '').trim();
      i += 1;
      continue;
    }
  }

  if (!token) {
    if (!allowNoAuth) {
      throw new Error(
        'Run via `regard dashboard` instead of starting the server directly.',
      );
    }
    logger.warn(
      '[security] unauthenticated mode enabled via --allow-no-auth (local development only).',
    );
    return { mode: 'allow-no-auth' };
  }

  if (!dashboardOrigin) dashboardOrigin = 'http://127.0.0.1:5173';
  return { mode: 'required', token, dashboardOrigin };
}
