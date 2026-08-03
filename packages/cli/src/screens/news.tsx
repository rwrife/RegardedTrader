import React, { useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import type { HeadlineBundle } from '@regardedtrader/core';
import { api } from '../api.js';
import { ReturnPrompt } from './menu.js';

export function buildNewsPath(symbol: string): string {
  return `/news/${encodeURIComponent(symbol.toUpperCase())}`;
}

export function NewsScreen({
  symbol,
  serverUrl,
  onDone,
}: {
  symbol: string;
  serverUrl: string;
  onDone?: () => void;
}) {
  const { exit } = useApp();
  const [data, setData] = useState<HeadlineBundle | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (!symbol) {
      setErr('Missing symbol. Usage: regard news NVDA');
      setFinished(true);
      if (!onDone) setTimeout(() => exit(), 50);
      return;
    }
    api<HeadlineBundle>(serverUrl, buildNewsPath(symbol))
      .then(setData)
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
  if (!data)
    return (
      <Text>
        <Spinner type="dots" /> ranking headlines for {symbol.toUpperCase()}…
      </Text>
    );

  return (
    <Box flexDirection="column" rowGap={1}>
      <Text bold color="cyan">
        NewsScout · {data.symbol}
      </Text>
      <Text>{data.summary}</Text>
      {data.headlines.length === 0 ? (
        <Text dimColor>No headlines available.</Text>
      ) : (
        data.headlines.slice(0, 8).map((h) => (
          <Box key={h.id} flexDirection="column">
            <Text>
              <Text color="blue">{h.id}</Text> [{h.relevance}/5 relevance · {h.materiality}/5
              materiality] {h.title}
            </Text>
            <Text dimColor>{h.rationale}</Text>
          </Box>
        ))
      )}
      <Text dimColor italic>
        {data.disclaimer}
      </Text>
      {onDone && finished && <ReturnPrompt onDone={onDone} />}
    </Box>
  );
}

