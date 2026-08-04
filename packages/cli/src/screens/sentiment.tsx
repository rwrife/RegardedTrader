import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import type { MentionItem, ScoredMention, SentimentSnapshot } from '@regardedtrader/core';
import { api } from '../api.js';
import { readSse } from '../sse.js';
import { ReturnPrompt } from './menu.js';

type SentimentHistory = { symbol: string; items: SentimentSnapshot[] };
type MentionsResponse = { symbol: string; items: Array<MentionItem | ScoredMention> };
type SentimentUpdateEvent = {
  type: 'sentiment.update';
  symbol: string;
  snapshot: SentimentSnapshot | null;
  id: string;
  at: string;
};

export function windowSinceIso(window: string | undefined, now = new Date()): string | null {
  if (!window) return null;
  const m = /^(\d+)([mhd])$/i.exec(window.trim());
  if (!m) return null;
  const amountPart = m[1];
  const unitPart = m[2];
  if (!amountPart || !unitPart) return null;
  const amount = Number(amountPart);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = unitPart.toLowerCase();
  const mult = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return new Date(now.getTime() - amount * mult).toISOString();
}

export function buildSentimentLatestPath(symbol: string): string {
  return `/sentiment/${encodeURIComponent(symbol.toUpperCase())}/latest`;
}

export function buildSentimentHistoryPath(
  symbol: string,
  window: string | undefined,
  now = new Date(),
): string {
  const since = windowSinceIso(window, now);
  if (!window || !since) return `/sentiment/${encodeURIComponent(symbol.toUpperCase())}`;
  return `/sentiment/${encodeURIComponent(symbol.toUpperCase())}?since=${encodeURIComponent(since)}`;
}

export function pickLatestSnapshot(items: SentimentSnapshot[]): SentimentSnapshot | null {
  if (items.length === 0) return null;
  return [...items].sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf)).at(-1) ?? null;
}

export function buildMentionsPath(symbol: string, source?: string, limit?: number): string {
  const params = new URLSearchParams();
  if (source) params.set('source', source);
  if (limit && Number.isFinite(limit) && limit > 0) params.set('limit', String(Math.floor(limit)));
  const qs = params.toString();
  return `/mentions/${encodeURIComponent(symbol.toUpperCase())}${qs ? `?${qs}` : ''}`;
}

function renderSnapshot(symbol: string, snapshot: SentimentSnapshot, window?: string) {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        sentiment · {symbol} {window ? `(window ${window})` : '(latest)'}
      </Text>
      <Text>
        score <Text color={snapshot.score >= 0 ? 'green' : 'red'}>{snapshot.score >= 0 ? '+' : ''}{snapshot.score.toFixed(2)}</Text>{' '}
        · conf {(snapshot.confidence * 100).toFixed(0)}% · volume {snapshot.volume.toLocaleString()}
      </Text>
      <Text dimColor>as of {snapshot.asOf}</Text>
      <Text>by source:</Text>
      {Object.keys(snapshot.bySource).length === 0 ? (
        <Text dimColor>  none</Text>
      ) : (
        Object.entries(snapshot.bySource)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([source, row]) => (
            <Text key={source}>
              {'  '}
              <Text bold>{source.padEnd(16)}</Text>
              <Text color={row.score >= 0 ? 'green' : 'red'}>{row.score >= 0 ? '+' : ''}{row.score.toFixed(2)}</Text>
              {' · conf '}
              {(row.confidence * 100).toFixed(0)}% · mentions {row.volume.toLocaleString()}
            </Text>
          ))
      )}
    </Box>
  );
}

export function SentimentScreen({
  symbol,
  serverUrl,
  window,
  watch,
  onDone,
}: {
  symbol: string;
  serverUrl: string;
  window?: string;
  watch?: boolean;
  onDone?: () => void;
}) {
  const { exit } = useApp();
  const [snapshot, setSnapshot] = useState<SentimentSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const normalized = symbol.toUpperCase();
  const since = useMemo(() => (window ? windowSinceIso(window) : null), [window]);

  useEffect(() => {
    if (!normalized) {
      setErr('Missing symbol. Usage: regard sentiment <SYMBOL> [--window=30m] [--watch]');
      if (!watch) {
        if (!onDone) setTimeout(() => exit(), 50);
      }
      return;
    }
    if (window && !since) {
      setErr('Invalid --window. Use <number><m|h|d>, e.g. 30m, 4h, 1d.');
      if (!watch) {
        if (!onDone) setTimeout(() => exit(), 50);
      }
      return;
    }

    const load = async () => {
      if (window) {
        const history = await api<SentimentHistory>(
          serverUrl,
          buildSentimentHistoryPath(normalized, window),
        );
        const latest = pickLatestSnapshot(history.items);
        if (!latest) throw new Error(`No sentiment snapshots found for ${normalized} in window ${window}.`);
        setSnapshot(latest);
        return;
      }
      const latest = await api<SentimentSnapshot>(serverUrl, buildSentimentLatestPath(normalized));
      setSnapshot(latest);
    };

    if (watch) {
      const abort = new AbortController();
      load()
        .catch((e) => setErr(String(e)))
        .finally(() => setConnected(true));

      readSse(
        `${serverUrl}/events`,
        (msg) => {
          if (msg.event !== 'sentiment.update') return;
          const payload = JSON.parse(msg.data) as SentimentUpdateEvent;
          if (payload.symbol.toUpperCase() !== normalized) return;
          if (payload.snapshot) setSnapshot(payload.snapshot);
        },
        abort.signal,
      ).catch((e) => {
        setErr(String(e));
        setTimeout(() => exit(), 50);
      });

      return () => abort.abort();
    }

    load()
      .catch((e) => setErr(String(e)))
      .finally(() => {
        if (!onDone) setTimeout(() => exit(), 50);
      });
  }, [normalized, onDone, serverUrl, watch, window, exit, since]);

  if (err) {
    return (
      <Box flexDirection="column">
        <Text color="red">{err}</Text>
        {onDone && !watch && <ReturnPrompt onDone={onDone} />}
      </Box>
    );
  }

  if (!snapshot) {
    return (
      <Text>
        <Spinner type="dots" /> loading sentiment for {normalized}…
      </Text>
    );
  }

  if (!watch) {
    return (
      <Box flexDirection="column" rowGap={1}>
        {renderSnapshot(normalized, snapshot, window)}
        {onDone && <ReturnPrompt onDone={onDone} />}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" rowGap={1}>
      <Text dimColor>{connected ? 'watching sentiment stream (Ctrl+C to stop)' : 'connecting sentiment stream…'}</Text>
      {renderSnapshot(normalized, snapshot, window)}
    </Box>
  );
}

export function MentionsScreen({
  symbol,
  serverUrl,
  source,
  limit,
  onDone,
}: {
  symbol: string;
  serverUrl: string;
  source?: string;
  limit?: number;
  onDone?: () => void;
}) {
  const { exit } = useApp();
  const [rows, setRows] = useState<Array<MentionItem | ScoredMention> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const normalized = symbol.toUpperCase();
  const normalizedSource = source ? source : undefined;

  useEffect(() => {
    if (!normalized) {
      setErr('Missing symbol. Usage: regard mentions <SYMBOL> [--source=reddit] [--limit=50]');
      if (!onDone) setTimeout(() => exit(), 50);
      return;
    }
    api<MentionsResponse>(serverUrl, buildMentionsPath(normalized, normalizedSource, limit))
      .then((r) => setRows(r.items))
      .catch((e) => setErr(String(e)))
      .finally(() => {
        if (!onDone) setTimeout(() => exit(), 50);
      });
  }, [exit, limit, normalized, normalizedSource, onDone, serverUrl]);

  if (err) {
    return (
      <Box flexDirection="column">
        <Text color="red">{err}</Text>
        {onDone && <ReturnPrompt onDone={onDone} />}
      </Box>
    );
  }
  if (!rows) {
    return (
      <Text>
        <Spinner type="dots" /> loading mentions for {normalized}…
      </Text>
    );
  }

  const prettyLimit = limit && Number.isFinite(limit) ? Math.floor(limit) : 100;
  return (
    <Box flexDirection="column" rowGap={1}>
      <Text bold color="cyan">
        mentions · {normalized} {normalizedSource ? `(${normalizedSource})` : '(all sources)'} · limit {prettyLimit}
      </Text>
      {rows.length === 0 ? (
        <Text dimColor>No mentions found.</Text>
      ) : (
        rows.map((row, idx) => {
          const line = row.title || row.text;
          const score = 'sentiment' in row ? row.sentiment?.score : undefined;
          return (
            <Box key={`${row.source}-${row.sourceId}-${idx}`} flexDirection="column">
              <Text>
                <Text bold>{row.source.padEnd(16)}</Text>
                {row.publishedAt}
                {score !== undefined ? (
                  <>
                    {' · '}
                    <Text color={score >= 0 ? 'green' : 'red'}>
                      {score >= 0 ? '+' : ''}
                      {score.toFixed(2)}
                    </Text>
                  </>
                ) : null}
              </Text>
              <Text dimColor>{truncate(line, 140)}</Text>
            </Box>
          );
        })
      )}
      {onDone && <ReturnPrompt onDone={onDone} />}
    </Box>
  );
}

function truncate(v: string, max: number): string {
  if (v.length <= max) return v;
  return `${v.slice(0, max - 1)}…`;
}
