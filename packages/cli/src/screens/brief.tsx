import React, { useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import type { Briefing, BriefingRequest } from '@regardedtrader/core';
import { api } from '../api.js';
import { ReturnPrompt } from './menu.js';

export interface BriefRequestPlan {
  path: string;
  init: RequestInit;
  /** True when strategist inputs are present and the POST body is sent. */
  usesStrategist: boolean;
}

/**
 * Build the HTTP request shape for `regard brief`. Exported for unit
 * testing — keeps the React component's `useEffect` thin.
 */
export function buildBriefRequest(opts: {
  symbol: string;
  thesis?: string;
  maxLossUsd?: number;
  expiry?: string;
}): BriefRequestPlan {
  const body: BriefingRequest = {};
  if (opts.thesis) body.thesis = opts.thesis;
  if (typeof opts.maxLossUsd === 'number' && Number.isFinite(opts.maxLossUsd)) {
    body.maxLossUsd = opts.maxLossUsd;
  }
  if (opts.expiry) body.expiry = opts.expiry;
  const path = `/briefing/${encodeURIComponent(opts.symbol.toUpperCase())}`;
  const usesStrategist = Boolean(body.thesis && typeof body.maxLossUsd === 'number');
  const init: RequestInit = usesStrategist
    ? { method: 'POST', body: JSON.stringify(body) }
    : { method: 'GET' };
  return { path, init, usesStrategist };
}

/**
 * `regard brief <SYM>` — surfaces the full Orchestrator briefing pipeline
 * (issue #126) in the CLI. When `--thesis` and `--max-loss` are supplied the
 * server runs the strategist + RiskOfficer arms; otherwise this collapses to
 * an analyst-only briefing (same backing endpoint as `regard briefing`).
 *
 * Sections rendered (when present):
 *   - Analyst (bull/bear/catalysts/risks)
 *   - Technician (`ta`)
 *   - NewsScout (`newsScout`) — also falls back to raw headlines
 *   - Strategist candidates with RiskOfficer review chips
 *   - Aggregated RiskOfficer verdict
 *
 * Issue #139: parity with the web `/brief/:sym` route.
 */
export function BriefScreen({
  symbol,
  serverUrl,
  thesis,
  maxLossUsd,
  expiry,
  onDone,
}: {
  symbol: string;
  serverUrl: string;
  thesis?: string;
  maxLossUsd?: number;
  expiry?: string;
  onDone?: () => void;
}) {
  const { exit } = useApp();
  const [data, setData] = useState<Briefing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (!symbol) {
      setErr('Missing symbol. Usage: regard brief NVDA [--thesis "..."] [--max-loss 500]');
      setFinished(true);
      if (!onDone) setTimeout(() => exit(), 50);
      return;
    }
    const plan = buildBriefRequest({ symbol, thesis, maxLossUsd, expiry });
    api<Briefing>(serverUrl, plan.path, plan.init)
      .then(setData)
      .catch((e) => setErr(String(e)))
      .finally(() => {
        setFinished(true);
        if (!onDone) setTimeout(() => exit(), 50);
      });
  }, [symbol, serverUrl, thesis, maxLossUsd, expiry, exit, onDone]);

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
        <Spinner type="dots" /> running full briefing pipeline for {symbol.toUpperCase()}…
      </Text>
    );

  return (
    <Box flexDirection="column" rowGap={1}>
      <Text bold color="cyan">
        ━━━ {data.symbol} full briefing ━━━
      </Text>
      <Text>
        Price ${data.quote.price.toFixed(2)} • RSI{' '}
        {data.indicators.rsi14?.toFixed(1) ?? '—'} • SMA20{' '}
        {data.indicators.sma20?.toFixed(2) ?? '—'} • SMA50{' '}
        {data.indicators.sma50?.toFixed(2) ?? '—'}
      </Text>

      <Box flexDirection="column">
        <Text bold color="green">
          Analyst — Bull case
        </Text>
        <Text>{data.bullCase || '(no bull case generated)'}</Text>
      </Box>
      <Box flexDirection="column">
        <Text bold color="red">
          Analyst — Bear case
        </Text>
        <Text>{data.bearCase || '(no bear case generated)'}</Text>
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

      {data.ta && (
        <Box flexDirection="column">
          <Text bold color="magenta">
            Technician
          </Text>
          <Text>Trend: {data.ta.trend}</Text>
          <Text>Momentum: {data.ta.momentum}</Text>
          <Text>Volatility: {data.ta.volatility}</Text>
          {data.ta.keyLevels.length > 0 && (
            <Text>Key levels: {data.ta.keyLevels.map((n) => n.toFixed(2)).join(', ')}</Text>
          )}
          <Text>{data.ta.commentary}</Text>
        </Box>
      )}

      {data.newsScout ? (
        <Box flexDirection="column">
          <Text bold color="blue">
            NewsScout
          </Text>
          <Text>{data.newsScout.summary}</Text>
          {data.newsScout.headlines.slice(0, 5).map((h, i) => (
            <Text key={i}>• {h.title}</Text>
          ))}
        </Box>
      ) : data.news.length > 0 ? (
        <Box flexDirection="column">
          <Text bold color="blue">
            Headlines
          </Text>
          {data.news.slice(0, 5).map((h, i) => (
            <Text key={i}>• {h.title}</Text>
          ))}
        </Box>
      ) : null}

      {data.strategist && (
        <Box flexDirection="column">
          <Text bold color="yellow">
            Strategist candidates ({data.strategist.candidates.length})
          </Text>
          <Text dimColor>Thesis: {data.strategist.thesis}</Text>
          {data.strategist.noCompliantPlans && (
            <Text color="red">No candidate plans passed risk caps.</Text>
          )}
          {data.strategist.candidates.map((c, i) => (
            <Box key={i} flexDirection="column" marginTop={1}>
              <Text bold>
                #{i + 1} {c.plan.name} {c.review.ok ? '✓' : '⚠'}
              </Text>
              <Text>
                Max loss ${c.plan.maxLoss.toFixed(2)} • Max gain{' '}
                {c.plan.maxGain === null ? '∞' : `$${c.plan.maxGain.toFixed(2)}`}
              </Text>
              {c.plan.breakEvens.length > 0 && (
                <Text>
                  Break-evens: {c.plan.breakEvens.map((b) => b.toFixed(2)).join(', ')}
                </Text>
              )}
              {!c.review.ok && c.review.violations.length > 0 && (
                <Box flexDirection="column">
                  {c.review.violations.map((v, j) => (
                    <Text key={j} color="red">
                      ⚠ {v}
                    </Text>
                  ))}
                </Box>
              )}
            </Box>
          ))}
        </Box>
      )}

      {data.riskVerdict && (
        <Box flexDirection="column">
          <Text bold color={data.riskVerdict.ok ? 'green' : 'red'}>
            RiskOfficer verdict: {data.riskVerdict.ok ? 'OK' : 'BLOCKED'}
          </Text>
          {data.riskVerdict.violations.map((v, i) => (
            <Text key={i} color="red">
              ⚠ {v}
            </Text>
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
