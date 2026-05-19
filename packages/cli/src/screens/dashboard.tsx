import React, { useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { spawn } from 'node:child_process';

export function DashboardScreen({
  serverUrl,
  onDone,
}: {
  serverUrl: string;
  onDone?: () => void;
}) {
  const { exit } = useApp();
  const webUrl = 'http://127.0.0.1:5173';

  useEffect(() => {
    const opener =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    try {
      spawn(opener, [webUrl], { stdio: 'ignore', detached: true }).unref();
    } catch {
      /* ignore */
    }
    if (!onDone) setTimeout(() => exit(), 100);
  }, [exit, onDone]);

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
