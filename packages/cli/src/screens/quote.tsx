import React, { useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import type { Quote } from '@regardedtrader/core';
import { api } from '../api.js';

export function QuoteScreen({ symbol, serverUrl }: { symbol: string; serverUrl: string }) {
  const { exit } = useApp();
  const [data, setData] = useState<Quote | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol) {
      setErr('Missing symbol');
      return;
    }
    api<Quote>(serverUrl, `/quote/${encodeURIComponent(symbol.toUpperCase())}`)
      .then(setData)
      .catch((e) => setErr(String(e)))
      .finally(() => setTimeout(() => exit(), 50));
  }, [symbol, serverUrl, exit]);

  if (err) return <Text color="red">{err}</Text>;
  if (!data)
    return (
      <Text>
        <Spinner type="dots" /> fetching {symbol.toUpperCase()}…
      </Text>
    );

  const up = data.change >= 0;
  return (
    <Box flexDirection="column">
      <Text bold>
        {data.symbol} <Text color={up ? 'green' : 'red'}>${data.price.toFixed(2)}</Text>{' '}
        <Text color={up ? 'green' : 'red'}>
          {up ? '+' : ''}
          {data.change.toFixed(2)} ({(data.changePercent ?? 0).toFixed(2)}%)
        </Text>
      </Text>
      <Text dimColor>vol {data.volume.toLocaleString()} • as of {data.asOf}</Text>
    </Box>
  );
}
