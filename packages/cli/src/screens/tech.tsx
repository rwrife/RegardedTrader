import React, { useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import type { BriefingTechnical } from '@regardedtrader/core';
import { api } from '../api.js';
import { ReturnPrompt } from './menu.js';
import { aiDisclaimerLine } from '../aiDisclaimer.js';

/**
 * `regard tech <SYM>` — Technician agent surface (issue #74). Renders the
 * trend / momentum / volatility / commentary block from the server's
 * `/technician/:symbol` endpoint.
 */
export function TechScreen({
  symbol,
  serverUrl,
  onDone,
}: {
  symbol: string;
  serverUrl: string;
  onDone?: () => void;
}) {
  const { exit } = useApp();
  const [data, setData] = useState<BriefingTechnical | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (!symbol) {
      setErr('Missing symbol');
      setFinished(true);
      if (!onDone) setTimeout(() => exit(), 50);
      return;
    }
    api<BriefingTechnical>(
      serverUrl,
      `/technician/${encodeURIComponent(symbol.toUpperCase())}`,
    )
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
        <Spinner type="dots" /> analysing {symbol.toUpperCase()}…
      </Text>
    );

  return (
    <Box flexDirection="column">
      <Text bold>
        Technician · {symbol.toUpperCase()} <Text color="cyan">[AI]</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color="cyan">Trend:</Text> {data.trend}
        </Text>
        <Text>
          <Text color="cyan">Momentum:</Text> {data.momentum}
        </Text>
        <Text>
          <Text color="cyan">Volatility:</Text> {data.volatility}
        </Text>
        {data.keyLevels.length > 0 && (
          <Text>
            <Text color="cyan">Key levels:</Text>{' '}
            {data.keyLevels.map((n) => n.toFixed(2)).join(' · ')}
          </Text>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Commentary</Text>
        <Text>{data.commentary}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{aiDisclaimerLine()}</Text>
      </Box>
      {onDone && finished && <ReturnPrompt onDone={onDone} />}
    </Box>
  );
}
