import React, { useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import type { TradePlan } from '@regardedtrader/core';
import { api } from '../api.js';
import { ReturnPrompt } from './menu.js';

type PlanResult = { plan: TradePlan; ok: boolean; violations: string[] };

export function PlanScreen({
  symbol,
  serverUrl,
  onDone,
}: {
  symbol: string;
  serverUrl: string;
  onDone?: () => void;
}) {
  const { exit } = useApp();
  const [stage, setStage] = useState<'thesis' | 'budget' | 'loading' | 'done' | 'err'>(
    symbol ? 'thesis' : 'err',
  );
  const [thesis, setThesis] = useState('');
  const [budgetStr, setBudgetStr] = useState('500');
  const [results, setResults] = useState<PlanResult[]>([]);
  const [err, setErr] = useState<string | null>(symbol ? null : 'Missing symbol. Usage: regard plan NVDA');

  useEffect(() => {
    if (stage === 'done' || stage === 'err') {
      if (!onDone) setTimeout(() => exit(), 50);
    }
  }, [stage, exit, onDone]);

  if (stage === 'err')
    return (
      <Box flexDirection="column">
        <Text color="red">{err}</Text>
        {onDone && <ReturnPrompt onDone={onDone} />}
      </Box>
    );

  if (stage === 'thesis') {
    return (
      <Box flexDirection="column">
        <Text>Symbol: <Text bold>{symbol.toUpperCase()}</Text></Text>
        <Text>Describe your thesis (e.g. "bullish into earnings, defined risk"):</Text>
        <TextInput value={thesis} onChange={setThesis} onSubmit={() => setStage('budget')} />
      </Box>
    );
  }

  if (stage === 'budget') {
    return (
      <Box flexDirection="column">
        <Text>Max loss budget (USD):</Text>
        <TextInput
          value={budgetStr}
          onChange={setBudgetStr}
          onSubmit={async () => {
            const maxLossUsd = Number(budgetStr);
            if (!Number.isFinite(maxLossUsd) || maxLossUsd <= 0) {
              setErr('Invalid budget');
              setStage('err');
              return;
            }
            setStage('loading');
            try {
              const data = await api<PlanResult[]>(serverUrl, '/plans', {
                method: 'POST',
                body: JSON.stringify({
                  symbol: symbol.toUpperCase(),
                  thesis,
                  maxLossUsd,
                }),
              });
              setResults(data);
              setStage('done');
            } catch (e) {
              setErr(String(e));
              setStage('err');
            }
          }}
        />
      </Box>
    );
  }

  if (stage === 'loading')
    return (
      <Text>
        <Spinner type="dots" /> proposing structures for {symbol.toUpperCase()}…
      </Text>
    );

  return (
    <Box flexDirection="column" rowGap={1}>
      <Text bold color="cyan">
        ━━━ {symbol.toUpperCase()} candidate plans ━━━
      </Text>
      {results.length === 0 && <Text color="yellow">No plans returned.</Text>}
      {results.map((r, i) => (
        <Box key={i} flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>{r.plan.name}</Text>
          <Text>{r.plan.thesis}</Text>
          <Text>
            Max loss <Text color="red">${r.plan.maxLoss}</Text> • Max gain{' '}
            <Text color="green">
              {r.plan.maxGain === null ? '∞' : `$${r.plan.maxGain}`}
            </Text>{' '}
            • Break-evens: {r.plan.breakEvens.join(', ')}
          </Text>
          {r.plan.legs.map((l, j) => (
            <Text key={j}>
              {' '}
              {l.action} ×{l.qty} {l.contract.type} {l.contract.strike} exp{' '}
              {l.contract.expiry}
            </Text>
          ))}
          {!r.ok && <Text color="red">Risk: {r.violations.join('; ')}</Text>}
          {r.plan.notes && <Text dimColor>{r.plan.notes}</Text>}
        </Box>
      ))}
      {onDone && <ReturnPrompt onDone={onDone} />}
    </Box>
  );
}
