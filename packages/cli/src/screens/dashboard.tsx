import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { spawn } from 'node:child_process';

/**
 * Compute the URL the `regard dashboard` command should open.
 *
 * In production (the common case — Express serves the built web bundle on
 * the same port as the API), this is just `serverUrl`. Hard-coding the Vite
 * dev port `5173` is wrong because nothing is listening there outside of
 * `npm run dev:web`.
 *
 * In development, if the caller passes an explicit dev URL (or
 * `REGARDEDTRADER_WEB_DEV_URL` is set), prefer it. Otherwise we still fall
 * back to the running server URL so the screen never opens a dead port.
 *
 * Exported for tests; pure (no I/O).
 */
export function resolveDashboardUrl(opts: {
  serverUrl: string;
  nodeEnv?: string | undefined;
  devUrl?: string | undefined;
}): string {
  const { serverUrl } = opts;
  const env = opts.nodeEnv ?? 'production';
  if (env !== 'production') {
    const dev = opts.devUrl?.trim();
    if (dev) return dev;
  }
  return serverUrl;
}

/**
 * Minimal `/version` payload shape (issue #179). Kept as a local interface
 * so the CLI doesn't pull the core Zod schema for a display-only string.
 */
export interface ServerVersionInfo {
  server: string;
  core: string;
  node: string;
  api: number;
  startedAt: string;
}

/**
 * Format the one-line "connected to server X (core Y, api Z)" banner shown
 * before `regard dashboard` opens the browser (issue #179). Falls back to a
 * gentle "connecting to <url>" message when `/version` is missing/malformed
 * so a stale server never blocks the dashboard launcher.
 *
 * Exported for tests; pure.
 */
export function formatConnectLine(
  serverUrl: string,
  info: ServerVersionInfo | null,
): string {
  if (!info) return `connecting to ${serverUrl}`;
  return `connected to server ${info.server} (core ${info.core}, api ${info.api})`;
}

/**
 * Structural guard for the `/version` payload. Duplicated in the web
 * TopBar for the same "don't drag node-only modules into the browser"
 * reason. Server-side, the payload is validated with the shared Zod schema
 * from `@regardedtrader/core`.
 */
function isServerVersion(raw: unknown): raw is ServerVersionInfo {
  return (
    raw !== null &&
    typeof raw === 'object' &&
    typeof (raw as { server?: unknown }).server === 'string' &&
    typeof (raw as { core?: unknown }).core === 'string' &&
    typeof (raw as { node?: unknown }).node === 'string' &&
    typeof (raw as { api?: unknown }).api === 'number' &&
    typeof (raw as { startedAt?: unknown }).startedAt === 'string'
  );
}

/**
 * Fetch `/version` from the running server with a short timeout. Exported
 * for tests. Never throws — returns `null` on any failure so the CLI can
 * still open the browser instead of blocking on a stale/absent server.
 */
export async function fetchServerVersion(
  serverUrl: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<ServerVersionInfo | null> {
  const impl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 1500;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await impl(`${serverUrl.replace(/\/$/, '')}/version`, {
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const raw = (await r.json()) as unknown;
    return isServerVersion(raw) ? raw : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function DashboardScreen({
  serverUrl,
  onDone,
}: {
  serverUrl: string;
  onDone?: () => void;
}) {
  const { exit } = useApp();
  const webUrl = useMemo(
    () =>
      resolveDashboardUrl({
        serverUrl,
        nodeEnv: process.env.NODE_ENV,
        devUrl: process.env.REGARDEDTRADER_WEB_DEV_URL,
      }),
    [serverUrl],
  );
  const [version, setVersion] = useState<ServerVersionInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const v = await fetchServerVersion(serverUrl);
      if (!cancelled) setVersion(v);
    })();
    return () => {
      cancelled = true;
    };
  }, [serverUrl]);

  useEffect(() => {
    const opener =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    try {
      spawn(opener, [webUrl], { stdio: 'ignore', detached: true }).unref();
    } catch {
      /* ignore */
    }
    if (!onDone) setTimeout(() => exit(), 100);
  }, [exit, onDone, webUrl]);

  useInput(
    (input, key) => {
      if (!onDone) return;
      if (input === 'q' || key.escape) exit();
      else onDone();
    },
    { isActive: !!onDone },
  );

  return (
    <Box flexDirection="column">
      <Text dimColor>{formatConnectLine(serverUrl, version)}</Text>
      <Text>Opening dashboard: <Text color="cyan">{webUrl}</Text></Text>
      <Text dimColor>(server: {serverUrl})</Text>
      <Text dimColor>If it doesn't open, run `npm run dev:web` and visit the URL.</Text>
      {onDone && (
        <Box marginTop={1}>
          <Text dimColor>↵ any key to return · q/esc to quit</Text>
        </Box>
      )}
    </Box>
  );
}
