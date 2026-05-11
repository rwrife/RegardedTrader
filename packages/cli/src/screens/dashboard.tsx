import React, { useEffect } from 'react';
import { Box, Text, useApp } from 'ink';
import { spawn } from 'node:child_process';

export function DashboardScreen({ serverUrl }: { serverUrl: string }) {
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
    setTimeout(() => exit(), 100);
  }, [exit]);

  return (
    <Box flexDirection="column">
      <Text>Opening dashboard: <Text color="cyan">{webUrl}</Text></Text>
      <Text dimColor>(server: {serverUrl})</Text>
      <Text dimColor>If it doesn't open, run `npm run dev:web` and visit the URL.</Text>
    </Box>
  );
}
