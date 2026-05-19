import React, { useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import type { WatchlistEntry } from '@regardedtrader/core';
import { api } from '../api.js';
import { ReturnPrompt } from './menu.js';

export function ListScreen({
  serverUrl,
  onDone,
}: {
  serverUrl: string;
  onDone?: () => void;
}) {
  const { exit } = useApp();
  const [data, setData] = useState<WatchlistEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ entries: WatchlistEntry[] }>(serverUrl, '/tickers')
      .then((r) => setData(r.entries))
      .catch((e) => setErr(String(e)))
      .finally(() => {
        if (!onDone) setTimeout(() => exit(), 50);
      });
  }, [serverUrl, exit, onDone]);

  if (err)
    return (
      <Box flexDirection="column">
        <Text color="red">{err}</Text>
        {onDone && <ReturnPrompt onDone={onDone} />}
      </Box>
    );
  if (!data)
    return (
      <Text>
        <Spinner type="dots" /> loading watchlist…
      </Text>
    );
  if (data.length === 0)
    return (
      <Box flexDirection="column">
        <Text dimColor>No tickers yet.</Text>
        <Text>Add one with: <Text bold>regard add NVDA</Text></Text>
        {onDone && <ReturnPrompt onDone={onDone} />}
      </Box>
    );

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">━━━ watchlist ({data.length}) ━━━</Text>
      {data.map((e) => (
        <Text key={e.profile.symbol}>
          <Text bold>{e.profile.symbol.padEnd(6)}</Text>
          <Text>{e.profile.name.padEnd(40)}</Text>
          <Text dimColor>{e.profile.exchange.padEnd(10)}</Text>
          <Text dimColor>{e.profile.sector}</Text>
        </Text>
      ))}
      {onDone && <ReturnPrompt onDone={onDone} />}
    </Box>
  );
}

export function RemoveScreen({
  symbol,
  serverUrl,
  onDone,
}: {
  symbol: string;
  serverUrl: string;
  onDone?: () => void;
}) {
  const { exit } = useApp();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (!symbol) {
      setErr('Usage: regard rm <SYM>');
      setFinished(true);
      if (!onDone) setTimeout(() => exit(), 50);
      return;
    }
    api<{ ok: boolean; removed: boolean }>(serverUrl, `/tickers/${encodeURIComponent(symbol.toUpperCase())}`, {
      method: 'DELETE',
    })
      .then((r) =>
        setMsg(r.removed ? `Removed ${symbol.toUpperCase()}` : `${symbol.toUpperCase()} not in watchlist`),
      )
      .catch((e) => setErr(String(e)))
      .finally(() => {
        setFinished(true);
        if (!onDone) setTimeout(() => exit(), 50);
      });
  }, [symbol, serverUrl, exit, onDone]);

  if (err)
    return (
      <Box flexDirection="column">
        <Text color="red">{err}</Text>
        {onDone && finished && <ReturnPrompt onDone={onDone} />}
      </Box>
    );
  if (!msg) return <Text><Spinner type="dots" /> removing…</Text>;
  return (
    <Box flexDirection="column">
      <Text>{msg}</Text>
      {onDone && finished && <ReturnPrompt onDone={onDone} />}
    </Box>
  );
}
