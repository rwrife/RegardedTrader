import React, { useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import type { PaperOrder, PaperPosition } from '@regardedtrader/core';
import { api } from '../api.js';
import { ReturnPrompt } from './menu.js';
import { aiDisclaimerLine } from '../aiDisclaimer.js';

type ParsedPaperArgs =
  | { kind: 'submit'; planId: string }
  | { kind: 'orders' }
  | { kind: 'positions' }
  | { kind: 'error'; message: string };

export function parsePaperArgs(args: string[]): ParsedPaperArgs {
  const [rawSub, rawArg] = args;
  const sub = (rawSub ?? '').trim().toLowerCase();
  if (!sub) return { kind: 'error', message: 'Usage: regard paper <submit|orders|positions> [planId] --paper' };
  if (sub === 'orders' || sub === 'fills') return { kind: 'orders' };
  if (sub === 'positions' || sub === 'pos') return { kind: 'positions' };
  if (sub === 'submit') {
    const planId = (rawArg ?? '').trim();
    if (!planId) return { kind: 'error', message: 'Usage: regard paper submit <planId> --paper' };
    return { kind: 'submit', planId };
  }
  return { kind: 'error', message: `Unknown paper subcommand "${sub}". Try submit | orders | positions.` };
}

export function PaperScreen({
  args,
  serverUrl,
  paperFlag,
  onDone,
}: {
  args: string[];
  serverUrl: string;
  paperFlag?: boolean;
  onDone?: () => void;
}) {
  const parsed = parsePaperArgs(args);
  if (parsed.kind === 'error') {
    return (
      <Box flexDirection="column">
        <Text color="red">{parsed.message}</Text>
        {onDone && <ReturnPrompt onDone={onDone} />}
      </Box>
    );
  }
  if (parsed.kind === 'submit') {
    return <PaperSubmitScreen planId={parsed.planId} serverUrl={serverUrl} paperFlag={paperFlag} onDone={onDone} />;
  }
  if (parsed.kind === 'orders') {
    return <PaperOrdersScreen serverUrl={serverUrl} onDone={onDone} />;
  }
  return <PaperPositionsScreen serverUrl={serverUrl} onDone={onDone} />;
}

function PaperSubmitScreen({
  planId,
  serverUrl,
  paperFlag,
  onDone,
}: {
  planId: string;
  serverUrl: string;
  paperFlag?: boolean;
  onDone?: () => void;
}) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<'confirm' | 'submitting' | 'done' | 'err'>('confirm');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState<string>('');

  useEffect(() => {
    if ((phase === 'done' || phase === 'err') && !onDone) setTimeout(() => exit(), 50);
  }, [phase, onDone, exit]);

  if (!paperFlag) {
    return (
      <Box flexDirection="column">
        <Text color="red">Refusing to submit. Re-run with --paper.</Text>
        <Text dimColor>PAPER mode is required for simulated execution.</Text>
        {onDone && <ReturnPrompt onDone={onDone} />}
      </Box>
    );
  }

  if (phase === 'confirm') {
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">PAPER trade submit</Text>
        <Text>Plan ID: <Text bold>{planId}</Text></Text>
        <Text>Type <Text bold>PAPER</Text> to confirm simulated submit:</Text>
        <TextInput
          value={confirm}
          onChange={setConfirm}
          onSubmit={async (v) => {
            if (v.trim() !== 'PAPER') {
              setMessage('Confirmation mismatch. Type exactly PAPER.');
              return;
            }
            setPhase('submitting');
            try {
              const fill = await api<{ id: string; symbol: string; netPremiumUsd: number }>(serverUrl, '/paper/orders', {
                method: 'POST',
                body: JSON.stringify({ paper: true, planId }),
              });
              setMessage(
                `Submitted ${fill.symbol} as PAPER order ${fill.id}. Net premium: $${fill.netPremiumUsd.toFixed(2)}`,
              );
              setPhase('done');
            } catch (e) {
              setMessage(String(e));
              setPhase('err');
            }
          }}
        />
        {message && <Text color="yellow">{message}</Text>}
      </Box>
    );
  }

  if (phase === 'submitting') {
    return (
      <Text>
        <Spinner type="dots" /> submitting simulated order…
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={phase === 'done' ? 'green' : 'red'}>{message}</Text>
      <Text dimColor italic>{aiDisclaimerLine()}</Text>
      {onDone && <ReturnPrompt onDone={onDone} />}
    </Box>
  );
}

function PaperOrdersScreen({ serverUrl, onDone }: { serverUrl: string; onDone?: () => void }) {
  const { exit } = useApp();
  const [orders, setOrders] = useState<PaperOrder[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ orders: PaperOrder[] }>(serverUrl, '/paper/orders')
      .then((r) => setOrders(r.orders))
      .catch((e) => setErr(String(e)))
      .finally(() => {
        if (!onDone) setTimeout(() => exit(), 50);
      });
  }, [serverUrl, onDone, exit]);
  if (err) {
    return (
      <Box flexDirection="column">
        <Text color="red">{err}</Text>
        {onDone && <ReturnPrompt onDone={onDone} />}
      </Box>
    );
  }
  if (!orders) return <Text><Spinner type="dots" /> loading paper orders…</Text>;
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">━━━ PAPER orders ({orders.length}) ━━━</Text>
      {orders.length === 0 && <Text dimColor>No paper orders yet.</Text>}
      {orders.map((o) => (
        <Text key={o.id}>{o.planId} · {o.symbol} · {o.submittedAt}</Text>
      ))}
      <Text dimColor italic>{aiDisclaimerLine()}</Text>
      {onDone && <ReturnPrompt onDone={onDone} />}
    </Box>
  );
}

function PaperPositionsScreen({ serverUrl, onDone }: { serverUrl: string; onDone?: () => void }) {
  const { exit } = useApp();
  const [positions, setPositions] = useState<PaperPosition[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ positions: PaperPosition[] }>(serverUrl, '/paper/positions')
      .then((r) => setPositions(r.positions))
      .catch((e) => setErr(String(e)))
      .finally(() => {
        if (!onDone) setTimeout(() => exit(), 50);
      });
  }, [serverUrl, onDone, exit]);
  if (err) {
    return (
      <Box flexDirection="column">
        <Text color="red">{err}</Text>
        {onDone && <ReturnPrompt onDone={onDone} />}
      </Box>
    );
  }
  if (!positions) return <Text><Spinner type="dots" /> loading paper positions…</Text>;
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">━━━ PAPER positions ({positions.length}) ━━━</Text>
      {positions.length === 0 && <Text dimColor>No paper positions yet.</Text>}
      {positions.map((p) => (
        <Text key={p.id}>
          {p.planId} · {p.symbol} · net ${p.netPremiumUsd.toFixed(2)} · max loss ${p.maxLossUsd.toFixed(2)}
        </Text>
      ))}
      <Text dimColor italic>{aiDisclaimerLine()}</Text>
      {onDone && <ReturnPrompt onDone={onDone} />}
    </Box>
  );
}

