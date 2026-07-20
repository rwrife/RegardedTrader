import React, { useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import type { ValidationResult, TickerProfile } from '@regardedtrader/core';
import { api } from '../api.js';
import { aiDisclaimerLine } from '../aiDisclaimer.js';
import { ReturnPrompt } from './menu.js';

interface State {
  loading: boolean;
  results: ValidationResult[];
  err: string | null;
}

export function AddScreen({
  symbols,
  refresh,
  serverUrl,
  onDone,
}: {
  symbols: string[];
  refresh: boolean;
  serverUrl: string;
  onDone?: () => void;
}) {
  const { exit } = useApp();
  const [state, setState] = useState<State>({ loading: true, results: [], err: null });

  useEffect(() => {
    if (symbols.length === 0) {
      setState({ loading: false, results: [], err: 'Usage: regard add <SYM> [<SYM>...] [--refresh]' });
      if (!onDone) setTimeout(() => exit(), 50);
      return;
    }
    api<{ results: ValidationResult[] }>(serverUrl, '/tickers/validate', {
      method: 'POST',
      body: JSON.stringify({ symbols, refresh }),
    })
      .then((r) => setState({ loading: false, results: r.results, err: null }))
      .catch((e) => setState({ loading: false, results: [], err: String(e) }))
      .finally(() => {
        if (!onDone) setTimeout(() => exit(), 50);
      });
  }, [symbols, refresh, serverUrl, exit, onDone]);

  if (state.err)
    return (
      <Box flexDirection="column">
        <Text color="red">{state.err}</Text>
        {onDone && <ReturnPrompt onDone={onDone} />}
      </Box>
    );
  if (state.loading)
    return (
      <Text>
        <Spinner type="dots" /> validating {symbols.join(', ')}…
      </Text>
    );

  return (
    <Box flexDirection="column" rowGap={1}>
      {state.results.map((r, i) => (
        <ResultBlock key={i} r={r} />
      ))}
      <Text dimColor italic>
        {aiDisclaimerLine()}
      </Text>
      {onDone && <ReturnPrompt onDone={onDone} />}
    </Box>
  );
}

function ResultBlock({ r }: { r: ValidationResult }) {
  if (r.ok) return <ProfileBlock profile={r.profile} cached={r.cached} />;
  return (
    <Box flexDirection="column">
      <Text color="red">✗ {r.symbol}: {r.error}</Text>
      {r.suggestions.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          <Text dimColor>Did you mean:</Text>
          {r.suggestions.map((s, i) => (
            <Text key={i}>• {s.symbol}{s.name ? ` — ${s.name}` : ''}{s.reason ? ` (${s.reason})` : ''}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

function ProfileBlock({ profile, cached }: { profile: TickerProfile; cached: boolean }) {
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="green">✓</Text> <Text bold>{profile.symbol}</Text>{' '}
        <Text>{profile.name}</Text>{' '}
        <Text dimColor>· {profile.exchange}</Text>
        {cached && <Text dimColor> · cached</Text>}
      </Text>
      <Box marginLeft={2} flexDirection="column">
        <Text dimColor>
          {profile.sector} / {profile.industry}
        </Text>
        <Text>{profile.description}</Text>
        <Text dimColor>
          sources: {profile.sources.slice(0, 3).join(', ')}
          {profile.sources.length > 3 ? ` (+${profile.sources.length - 3})` : ''}
        </Text>
      </Box>
    </Box>
  );
}
