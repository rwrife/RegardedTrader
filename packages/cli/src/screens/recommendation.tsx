import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import {
  Recommendation as RecommendationSchema,
  type Recommendation,
  type Verdict,
} from '@regardedtrader/core/schemas/recommendation';
import { api } from '../api.js';
import { readSse } from '../sse.js';
import { aiDisclaimerLine } from '../aiDisclaimer.js';
import { ReturnPrompt } from './menu.js';

interface RecommendationHistoryResponse {
  symbol: string;
  items: Recommendation[];
}

interface RecommendationRecomputeResponse {
  symbol: string;
  persisted: boolean;
  recommendation: Recommendation;
}

interface RecommendationEventPayload {
  type: 'recommendation.update';
  symbol: string;
  recommendation: Recommendation;
}

type ParsedRecommendationArgs =
  | { kind: 'latest'; symbol: string; recompute: boolean }
  | { kind: 'history'; symbol: string; days: number }
  | { kind: 'watch'; symbols: string[] }
  | { kind: 'error'; message: string };

interface ParseRecommendationOpts {
  daysFlag?: number;
  recomputeFlag?: boolean;
  defaultHistoryDays?: number;
}

export function buildRecommendationLatestPath(symbol: string): string {
  return `/recommendations/${encodeURIComponent(symbol.toUpperCase())}/latest`;
}

export function buildRecommendationRecomputePath(symbol: string): string {
  return `/recommendations/${encodeURIComponent(symbol.toUpperCase())}/recompute`;
}

export function buildRecommendationHistoryPath(
  symbol: string,
  days = 30,
  now = new Date(),
): string {
  const until = now.toISOString();
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const params = new URLSearchParams({ since, until });
  return `/recommendations/${encodeURIComponent(symbol.toUpperCase())}?${params.toString()}`;
}

export function parseRecommendationArgs(
  args: readonly string[],
  opts: ParseRecommendationOpts = {},
): ParsedRecommendationArgs {
  const defaultHistoryDays = opts.defaultHistoryDays ?? 30;
  const [firstRaw, ...rest] = args;
  if (!firstRaw) {
    return {
      kind: 'error',
      message:
        'Usage: regard rec <SYM> [--recompute] | regard rec <SYM> history [--days=30] | regard rec watch [SYM...]',
    };
  }

  const first = firstRaw.toLowerCase();
  if (first === 'watch') {
    const symbols = rest
      .filter((v) => !v.startsWith('--'))
      .map((v) => v.toUpperCase())
      .filter(Boolean);
    return { kind: 'watch', symbols };
  }

  const symbol = firstRaw.trim().toUpperCase();
  if (!symbol) {
    return { kind: 'error', message: 'Missing symbol. Usage: regard rec <SYM> ...' };
  }

  const sub = (rest[0] ?? '').toLowerCase();
  if (!sub) {
    return {
      kind: 'latest',
      symbol,
      recompute: Boolean(opts.recomputeFlag),
    };
  }

  if (sub === 'history') {
    const parsedDays = parseDaysFromArgs(rest.slice(1));
    if (parsedDays instanceof Error) return { kind: 'error', message: parsedDays.message };
    const days = parsedDays ?? opts.daysFlag ?? defaultHistoryDays;
    if (!Number.isInteger(days) || days <= 0) {
      return {
        kind: 'error',
        message: 'Invalid --days. Use a positive integer, e.g. --days=30.',
      };
    }
    return { kind: 'history', symbol, days };
  }

  if (sub.startsWith('--')) {
    const rem = [sub, ...rest.slice(1)];
    const isRecompute = rem.every((t) => t === '--recompute');
    if (!isRecompute) {
      return {
        kind: 'error',
        message: `Unknown option for rec latest: ${rem.find((t) => t !== '--recompute') ?? sub}`,
      };
    }
    return { kind: 'latest', symbol, recompute: true };
  }

  return {
    kind: 'error',
    message: `Unknown rec subcommand: ${sub}. Expected "history" or "watch".`,
  };
}

function parseDaysFromArgs(args: readonly string[]): number | null | Error {
  if (args.length === 0) return null;
  for (let i = 0; i < args.length; i += 1) {
    const cur = args[i] ?? '';
    if (cur.startsWith('--days=')) {
      const raw = cur.slice('--days='.length);
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        return new Error('Invalid --days. Use a positive integer, e.g. --days=30.');
      }
      return n;
    }
    if (cur === '--days') {
      const raw = args[i + 1] ?? '';
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        return new Error('Invalid --days. Use a positive integer, e.g. --days=30.');
      }
      return n;
    }
    if (cur.startsWith('--')) {
      return new Error(`Unknown history option: ${cur}`);
    }
  }
  return null;
}

function convictionBar(conviction: number, width = 10): string {
  const clamped = Math.max(0, Math.min(1, conviction));
  const filled = Math.round(clamped * width);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
}

function actionColor(action: Verdict['action']): string {
  if (action === 'BUY') return 'green';
  if (action === 'SELL') return 'red';
  if (action === 'AVOID') return 'redBright';
  return 'yellow';
}

function renderVerdict(label: string, verdict: Verdict | null, naReason: string): React.ReactNode {
  if (!verdict) {
    return (
      <Text>
        {label.padEnd(12)} <Text dimColor>n/a ({naReason})</Text>
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      <Text>
        {label.padEnd(12)}
        <Text color={actionColor(verdict.action)}>{verdict.action}</Text>
        {'  '}
        <Text dimColor>{convictionBar(verdict.conviction)} {(verdict.conviction * 100).toFixed(0)}%</Text>
      </Text>
      <Text dimColor>  {verdict.rationale}</Text>
    </Box>
  );
}

function renderRecommendation(symbol: string, rec: Recommendation, prefix?: string): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {prefix ? `${prefix} · ` : ''}recommendation · {symbol}
      </Text>
      <Text dimColor>
        generated {rec.generatedAt} · model {rec.modelInfo.provider}/{rec.modelInfo.model}
      </Text>
      {renderVerdict('Equity', rec.equity, 'none')}
      {renderVerdict('Covered call', rec.options.coveredCall, 'no chain')}
      {renderVerdict('Covered put', rec.options.coveredPut, 'no chain')}
      {renderVerdict('Naked call', rec.options.nakedCall, 'naked shorts disabled')}
      {renderVerdict('Naked put', rec.options.nakedPut, 'naked shorts disabled')}
      {rec.riskFlags.length > 0 ? (
        <Text color="yellow">risk flags: {rec.riskFlags.join(', ')}</Text>
      ) : (
        <Text dimColor>risk flags: none</Text>
      )}
      <Text dimColor>sources used: {rec.sources.length > 0 ? rec.sources.map((s) => s.name).join(', ') : 'none'}</Text>
      <Text dimColor italic>{rec.disclaimer || aiDisclaimerLine()}</Text>
    </Box>
  );
}

export function RecommendationScreen({
  args,
  serverUrl,
  daysFlag,
  recomputeFlag,
  onDone,
}: {
  args: readonly string[];
  serverUrl: string;
  daysFlag?: number;
  recomputeFlag?: boolean;
  onDone?: () => void;
}) {
  const { exit } = useApp();
  const parsed = useMemo(
    () => parseRecommendationArgs(args, { daysFlag, recomputeFlag }),
    [args.join('\u0000'), daysFlag, recomputeFlag],
  );

  const [err, setErr] = useState<string | null>(parsed.kind === 'error' ? parsed.message : null);
  const [latest, setLatest] = useState<Recommendation | null>(null);
  const [history, setHistory] = useState<Recommendation[] | null>(null);
  const [watchRows, setWatchRows] = useState<Record<string, Recommendation>>({});
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (parsed.kind === 'error') {
      if (!onDone) setTimeout(() => exit(), 50);
      return;
    }

    if (parsed.kind === 'watch') {
      const allow = new Set(parsed.symbols.map((s) => s.toUpperCase()));
      const abort = new AbortController();
      setConnected(false);
      readSse(
        `${serverUrl}/events`,
        (msg) => {
          if (msg.event !== 'recommendation.update') return;
          try {
            const payload = JSON.parse(msg.data) as RecommendationEventPayload;
            if (payload.type !== 'recommendation.update') return;
            const symbol = payload.symbol.toUpperCase();
            if (allow.size > 0 && !allow.has(symbol)) return;
            const rec = RecommendationSchema.parse(payload.recommendation);
            setWatchRows((prev) => ({ ...prev, [symbol]: rec }));
          } catch {
            // ignore malformed events
          }
        },
        abort.signal,
      ).catch((e) => {
        if (abort.signal.aborted) return;
        setErr(String(e));
        if (!onDone) setTimeout(() => exit(), 50);
      });
      setConnected(true);
      return () => abort.abort();
    }

    const done = () => {
      if (!onDone) setTimeout(() => exit(), 50);
    };

    if (parsed.kind === 'latest') {
      const run = async () => {
        if (parsed.recompute) {
          const body = await api<RecommendationRecomputeResponse>(
            serverUrl,
            buildRecommendationRecomputePath(parsed.symbol),
            { method: 'POST', body: JSON.stringify({}) },
          );
          setLatest(RecommendationSchema.parse(body.recommendation));
          return;
        }
        const rec = await api<Recommendation>(
          serverUrl,
          buildRecommendationLatestPath(parsed.symbol),
        );
        setLatest(RecommendationSchema.parse(rec));
      };
      run()
        .catch((e) => setErr(String(e)))
        .finally(done);
      return;
    }

    api<RecommendationHistoryResponse>(
      serverUrl,
      buildRecommendationHistoryPath(parsed.symbol, parsed.days),
    )
      .then((r) => {
        const items = r.items.map((x) => RecommendationSchema.parse(x));
        items.sort((a, b) => Date.parse(a.generatedAt) - Date.parse(b.generatedAt));
        setHistory(items);
      })
      .catch((e) => setErr(String(e)))
      .finally(done);
  }, [exit, onDone, parsed, serverUrl]);

  if (err) {
    return (
      <Box flexDirection="column">
        <Text color="red">{err}</Text>
        {onDone && parsed.kind !== 'watch' && <ReturnPrompt onDone={onDone} />}
      </Box>
    );
  }

  if (parsed.kind === 'watch') {
    const symbols = Object.keys(watchRows).sort((a, b) => a.localeCompare(b));
    return (
      <Box flexDirection="column" rowGap={1}>
        <Text dimColor>
          {connected ? 'watching recommendation stream (Ctrl+C to stop)' : 'connecting recommendation stream…'}
        </Text>
        {parsed.symbols.length > 0 && <Text dimColor>filter: {parsed.symbols.join(', ')}</Text>}
        {symbols.length === 0 ? (
          <Text dimColor>Waiting for recommendation.update events…</Text>
        ) : (
          symbols.map((symbol) => {
            const rec = watchRows[symbol];
            if (!rec) return null;
            return (
              <Text key={symbol}>
                {symbol.padEnd(8)}
                <Text color={actionColor(rec.equity.action)}>{rec.equity.action.padEnd(6)}</Text>
                {' '}
                <Text dimColor>{convictionBar(rec.equity.conviction)} {(rec.equity.conviction * 100).toFixed(0)}%</Text>
                {' · '}
                <Text dimColor>{rec.generatedAt}</Text>
              </Text>
            );
          })
        )}
        <Text dimColor italic>{aiDisclaimerLine()}</Text>
      </Box>
    );
  }

  if (parsed.kind === 'latest') {
    if (!latest) {
      return (
        <Text>
          <Spinner type="dots" /> {parsed.recompute ? 'recomputing' : 'loading'} recommendation for{' '}
          {parsed.symbol}…
        </Text>
      );
    }
    return (
      <Box flexDirection="column" rowGap={1}>
        {renderRecommendation(parsed.symbol, latest, parsed.recompute ? 'recomputed' : undefined)}
        {onDone && <ReturnPrompt onDone={onDone} />}
      </Box>
    );
  }

  if (parsed.kind !== 'history') {
    return null;
  }

  if (!history) {
    return (
      <Text>
        <Spinner type="dots" /> loading recommendation history for {parsed.symbol}…
      </Text>
    );
  }

  return (
    <Box flexDirection="column" rowGap={1}>
      <Text bold color="cyan">
        recommendation history · {parsed.symbol} · last {parsed.days} day{parsed.days === 1 ? '' : 's'}
      </Text>
      {history.length === 0 ? (
        <Text dimColor>No recommendation history found in this window.</Text>
      ) : (
        history.map((rec) => (
          <Text key={`${rec.symbol}:${rec.generatedAt}`}>
            {rec.generatedAt} | <Text color={actionColor(rec.equity.action)}>{rec.equity.action}</Text> |{' '}
            {(rec.equity.conviction * 100).toFixed(0)}% | flags {rec.riskFlags.length}
          </Text>
        ))
      )}
      <Text dimColor italic>{aiDisclaimerLine()}</Text>
      {onDone && <ReturnPrompt onDone={onDone} />}
    </Box>
  );
}
