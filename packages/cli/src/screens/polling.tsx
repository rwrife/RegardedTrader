import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { api } from '../api.js';
import { readSse } from '../sse.js';

interface TapePoint {
  symbol: string;
  last: number;
  change: number;
  changePercent: number;
  rsi: number | null;
  lastHeadline: string | null;
  asOf: string;
}

interface PollingStatusRow {
  id: string;
  state: string;
  lastRun: string | null;
  nextRun: string | null;
  lastError: string | null;
}

export function WatchTapeScreen({
  symbols,
  serverUrl,
}: {
  symbols: string[];
  serverUrl: string;
}) {
  const { exit } = useApp();
  const [err, setErr] = useState<string | null>(null);
  const [rows, setRows] = useState<Map<string, TapePoint>>(new Map());
  const [connected, setConnected] = useState(false);

  const symbolList = useMemo(
    () => symbols.map((s) => s.toUpperCase()).filter(Boolean),
    [symbols],
  );

  useEffect(() => {
    const abort = new AbortController();
    const query =
      symbolList.length > 0 ? `?symbols=${encodeURIComponent(symbolList.join(','))}` : '';
    readSse(`${serverUrl}/polling/watch${query}`, (msg) => {
      if (msg.event === 'ready') setConnected(true);
      if (msg.event === 'tape') {
        const row = JSON.parse(msg.data) as TapePoint;
        setRows((prev) => {
          const next = new Map(prev);
          next.set(row.symbol, row);
          return next;
        });
      }
    }, abort.signal).catch((e) => {
      setErr(String(e));
      setTimeout(() => exit(), 50);
    });
    return () => abort.abort();
  }, [serverUrl, exit, symbolList]);

  if (err) return <Text color="red">{err}</Text>;
  if (!connected) return <Text><Spinner type="dots" /> connecting to watch stream…</Text>;

  const list = [...rows.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">live tape {symbolList.length > 0 ? `(${symbolList.join(', ')})` : '(watchlist)'}</Text>
      {list.length === 0 && <Text dimColor>Waiting for updates…</Text>}
      {list.map((r) => (
        <Text key={r.symbol}>
          <Text bold>{r.symbol.padEnd(6)}</Text>
          <Text>{r.last.toFixed(2).padStart(9)}</Text>
          <Text color={r.change >= 0 ? 'green' : 'red'}>{formatSigned(r.change, 2).padStart(9)}</Text>
          <Text color={r.change >= 0 ? 'green' : 'red'}>{formatSigned(r.changePercent, 2).padStart(9)}%</Text>
          <Text>{` RSI ${formatNullable(r.rsi)}`}</Text>
          <Text dimColor>{`  ${truncate(r.lastHeadline ?? '—', 64)}`}</Text>
        </Text>
      ))}
      <Text dimColor>Ctrl+C to stop.</Text>
    </Box>
  );
}

export function TailScreen({
  symbol,
  includeQuotes,
  serverUrl,
}: {
  symbol: string;
  includeQuotes: boolean;
  serverUrl: string;
}) {
  const { exit } = useApp();
  const [err, setErr] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const normalized = symbol.toUpperCase();

  useEffect(() => {
    if (!normalized) {
      setErr('Usage: regard tail <SYM> [--quotes]');
      setTimeout(() => exit(), 50);
      return;
    }
    const abort = new AbortController();
    const q = includeQuotes ? '?quotes=true' : '';
    readSse(`${serverUrl}/polling/tail/${encodeURIComponent(normalized)}${q}`, (msg) => {
      if (msg.event === 'ready') setConnected(true);
      if (msg.event === 'news') {
        const v = JSON.parse(msg.data) as {
          title: string;
          source: string;
          publishedAt: string;
        };
        push(`[news ${v.source}] ${v.title} (${v.publishedAt})`);
      }
      if (msg.event === 'quote') {
        const v = JSON.parse(msg.data) as {
          price: number;
          change: number;
          changePercent: number;
          rsi: number | null;
          asOf: string;
        };
        push(
          `[quote] ${normalized} ${v.price.toFixed(2)} (${formatSigned(v.change, 2)}, ${formatSigned(v.changePercent, 2)}%) RSI ${formatNullable(v.rsi)} @ ${v.asOf}`,
        );
      }
      if (msg.event === 'tape' && !includeQuotes) {
        const v = JSON.parse(msg.data) as TapePoint;
        push(
          `[tape] ${v.symbol} ${v.last.toFixed(2)} (${formatSigned(v.change, 2)}, ${formatSigned(v.changePercent, 2)}%) RSI ${formatNullable(v.rsi)} · ${v.lastHeadline ?? '—'}`,
        );
      }
    }, abort.signal).catch((e) => {
      setErr(String(e));
      setTimeout(() => exit(), 50);
    });
    return () => abort.abort();

    function push(line: string) {
      setLines((prev) => [...prev.slice(-40), line]);
    }
  }, [serverUrl, normalized, includeQuotes, exit]);

  if (err) return <Text color="red">{err}</Text>;
  if (!connected) return <Text><Spinner type="dots" /> tailing {normalized}…</Text>;
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">tail {normalized}{includeQuotes ? ' (+quotes)' : ''}</Text>
      {lines.length === 0 ? <Text dimColor>Waiting for events…</Text> : lines.map((line, i) => <Text key={`${line}-${i}`}>{line}</Text>)}
      <Text dimColor>Ctrl+C to stop.</Text>
    </Box>
  );
}

export function PollingStatusScreen({ serverUrl }: { serverUrl: string }) {
  const { exit } = useApp();
  const [rows, setRows] = useState<PollingStatusRow[] | null>(null);
  const [paused, setPaused] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ paused: boolean; jobs: PollingStatusRow[] }>(serverUrl, '/polling/status')
      .then((r) => {
        setRows(r.jobs);
        setPaused(r.paused);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setTimeout(() => exit(), 50));
  }, [serverUrl, exit]);

  if (err) return <Text color="red">{err}</Text>;
  if (!rows || paused === null) return <Text><Spinner type="dots" /> loading polling status…</Text>;
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">polling status ({paused ? 'paused' : 'running'})</Text>
      {rows.map((r) => (
        <Text key={r.id}>
          <Text bold>{r.id.padEnd(10)}</Text>
          <Text>{r.state.padEnd(10)}</Text>
          <Text dimColor>{`last=${r.lastRun ?? '—'} next=${r.nextRun ?? '—'} err=${r.lastError ?? '—'}`}</Text>
        </Text>
      ))}
    </Box>
  );
}

export function PollingToggleScreen({
  action,
  serverUrl,
}: {
  action: 'pause' | 'resume';
  serverUrl: string;
}) {
  const { exit } = useApp();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ paused: boolean }>(serverUrl, `/polling/${action}`, { method: 'POST' })
      .then((r) => setMsg(`Polling ${r.paused ? 'paused' : 'running'}`))
      .catch((e) => setErr(String(e)))
      .finally(() => setTimeout(() => exit(), 50));
  }, [action, serverUrl, exit]);
  if (err) return <Text color="red">{err}</Text>;
  if (!msg) return <Text><Spinner type="dots" /> {action} polling…</Text>;
  return <Text>{msg}</Text>;
}

function formatSigned(n: number, digits: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`;
}

function formatNullable(n: number | null): string {
  return n === null ? '—' : n.toFixed(1);
}

function truncate(v: string, max: number): string {
  if (v.length <= max) return v;
  return `${v.slice(0, max - 1)}…`;
}
