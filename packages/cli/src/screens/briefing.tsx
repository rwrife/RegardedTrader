import React, { useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import type { Briefing } from '@regardedtrader/core';
import { api } from '../api.js';
import { ReturnPrompt } from './menu.js';

export function BriefingScreen({
  symbol,
  serverUrl,
  onDone,
}: {
  symbol: string;
  serverUrl: string;
  onDone?: () => void;
}) {
  const { exit } = useApp();
  const [data, setData] = useState<Briefing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (!symbol) {
      setErr('Missing symbol. Usage: regard briefing NVDA');
      setFinished(true);
      if (!onDone) setTimeout(() => exit(), 50);
      return;
    }
    api<Briefing>(serverUrl, `/briefing/${encodeURIComponent(symbol.toUpperCase())}`)
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
        <Spinner type="dots" /> building briefing for {symbol.toUpperCase()}…
      </Text>
    );

  return (
    <Box flexDirection="column" rowGap={1}>
      <Text bold color="cyan">
        ━━━ {data.symbol} briefing ━━━
      </Text>
      <Text>
        Price ${data.quote.price.toFixed(2)} • RSI{' '}
        {data.indicators.rsi14?.toFixed(1) ?? '—'} • SMA20{' '}
        {data.indicators.sma20?.toFixed(2) ?? '—'} • SMA50{' '}
        {data.indicators.sma50?.toFixed(2) ?? '—'}
      </Text>
      <Box flexDirection="column">
        <Text bold color="green">
          Bull case
        </Text>
        <Text>{data.bullCase}</Text>
      </Box>
      <Box flexDirection="column">
        <Text bold color="red">
          Bear case
        </Text>
        <Text>{data.bearCase}</Text>
      </Box>
      {data.catalysts.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Catalysts</Text>
          {data.catalysts.map((c, i) => (
            <Text key={i}>• {c}</Text>
          ))}
        </Box>
      )}
      {data.risks.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Risks</Text>
          {data.risks.map((r, i) => (
            <Text key={i}>• {r}</Text>
          ))}
        </Box>
      )}
      <Text dimColor italic>
        {data.disclaimer}
      </Text>
      {onDone && finished && <ReturnPrompt onDone={onDone} />}
    </Box>
  );
}
