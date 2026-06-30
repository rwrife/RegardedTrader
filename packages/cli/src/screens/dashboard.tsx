import React, { useEffect, useMemo } from 'react';
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
