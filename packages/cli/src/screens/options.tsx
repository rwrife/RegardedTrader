/**
 * `regard options <SYMBOL>` — terminal options-chain explorer.
 *
 * Parity twin of the web `#/options/:sym` route (issue #155). Both surfaces
 * are thin clients over `GET /options/:symbol` and share the same grouping +
 * greek-fill helpers from `@regardedtrader/core` so the rendered numbers are
 * identical across surfaces.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import type { OptionContract, Quote } from '@regardedtrader/core';
import { fillGreeks, groupChainByStrike, type ChainRow } from '@regardedtrader/core';
import { api } from '../api.js';
import { ReturnPrompt } from './menu.js';
import { aiDisclaimerLine } from '../aiDisclaimer.js';

const DISCLAIMER = aiDisclaimerLine();

export interface OptionsScreenProps {
  symbol: string;
  serverUrl: string;
  expiry?: string;
  /** Test seam: when present, skip HTTP and render the supplied data. */
  initialChain?: OptionContract[];
  initialQuote?: Quote | null;
  onDone?: () => void;
}

/**
 * Group + greek-fill helper that backs both the CLI screen and its test.
 * Pulled out so we can unit-test the render-data pipeline without spinning
 * up Ink.
 */
export function buildChainRows(
  contracts: ReadonlyArray<OptionContract>,
  opts: { spot: number | null; asOf?: string; expiry?: string },
): ChainRow[] {
  const filtered = opts.expiry
    ? contracts.filter((c) => c.expiry === opts.expiry)
    : contracts;
  const withGreeks =
    opts.spot && opts.spot > 0
      ? fillGreeks(filtered, { spot: opts.spot, asOf: opts.asOf })
      : filtered.map((c) => ({ ...c }));
  return groupChainByStrike(withGreeks);
}

/** Format a nullable number to a fixed-width string for the table. */
function num(n: number | null | undefined, digits = 2): string {
  return n == null || !Number.isFinite(n) ? '—' : n.toFixed(digits);
}

/** Format IV (decimal) as a percentage. */
function ivPct(iv: number | null | undefined): string {
  return iv == null || !Number.isFinite(iv) ? '—' : `${(iv * 100).toFixed(1)}%`;
}

export function OptionsScreen({
  symbol,
  serverUrl,
  expiry,
  initialChain,
  initialQuote,
  onDone,
}: OptionsScreenProps): JSX.Element {
  const { exit } = useApp();
  const [chain, setChain] = useState<OptionContract[] | null>(initialChain ?? null);
  const [quote, setQuote] = useState<Quote | null>(initialQuote ?? null);
  const [err, setErr] = useState<string | null>(symbol ? null : 'Missing symbol. Usage: regard options NVDA');
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (!symbol) {
      setFinished(true);
      if (!onDone) setTimeout(() => exit(), 50);
      return;
    }
    if (initialChain) {
      setFinished(true);
      return;
    }
    const sym = encodeURIComponent(symbol.toUpperCase());
    const qs = expiry ? `?expiry=${encodeURIComponent(expiry)}` : '';
    Promise.allSettled([
      api<OptionContract[]>(serverUrl, `/options/${sym}${qs}`),
      api<Quote>(serverUrl, `/quote/${sym}`),
    ])
      .then(([chainRes, quoteRes]) => {
        if (chainRes.status === 'fulfilled') setChain(chainRes.value);
        else setErr(String(chainRes.reason));
        if (quoteRes.status === 'fulfilled') setQuote(quoteRes.value);
      })
      .finally(() => {
        setFinished(true);
        if (!onDone) setTimeout(() => exit(), 50);
      });
  }, [symbol, serverUrl, expiry, exit, onDone, initialChain]);

  const rows = useMemo(() => {
    if (!chain) return [];
    return buildChainRows(chain, {
      spot: quote?.price ?? null,
      asOf: quote?.asOf,
      expiry,
    });
  }, [chain, quote, expiry]);

  if (err) {
    return (
      <Box flexDirection="column">
        <Text color="red">{err}</Text>
        {onDone && finished && <ReturnPrompt onDone={onDone} />}
      </Box>
    );
  }

  if (!chain) {
    return (
      <Text>
        <Spinner type="dots" /> fetching options for {symbol.toUpperCase()}…
      </Text>
    );
  }

  if (rows.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">
          No options data for {symbol.toUpperCase()}
          {expiry ? ` (expiry ${expiry})` : ''}.
        </Text>
        <Text dimColor>{DISCLAIMER}</Text>
        {onDone && finished && <ReturnPrompt onDone={onDone} />}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{symbol.toUpperCase()}</Text>
        {quote ? <Text> spot ${num(quote.price)}</Text> : null}
        {expiry ? <Text dimColor> · expiry {expiry}</Text> : null}
        <Text dimColor> · {rows.length} strikes</Text>
      </Text>
      <Box>
        <Text dimColor>
          {'   call Δ    bid    ask     iv  |  strike  |     iv    bid    ask    put Δ'}
        </Text>
      </Box>
      {rows.map((r) => (
        <ChainRowView key={r.strike} row={r} spot={quote?.price ?? null} />
      ))}
      <Text dimColor>{DISCLAIMER}</Text>
      {onDone && finished && <ReturnPrompt onDone={onDone} />}
    </Box>
  );
}

function ChainRowView({ row, spot }: { row: ChainRow; spot: number | null }): JSX.Element {
  const inMoney = (c: OptionContract | null): boolean => {
    if (!c || spot == null) return false;
    return c.type === 'call' ? spot > c.strike : spot < c.strike;
  };
  const callItm = inMoney(row.call);
  const putItm = inMoney(row.put);
  return (
    <Text>
      <Text color={callItm ? 'green' : undefined}>
        {pad(num(row.call?.delta ?? null, 2), 7)}
        {pad(num(row.call?.bid ?? null), 7)}
        {pad(num(row.call?.ask ?? null), 7)}
        {pad(ivPct(row.call?.iv ?? null), 7)}
      </Text>
      <Text dimColor>{'  |  '}</Text>
      <Text bold>{pad(num(row.strike, 2), 7)}</Text>
      <Text dimColor>{'  |  '}</Text>
      <Text color={putItm ? 'red' : undefined}>
        {pad(ivPct(row.put?.iv ?? null), 7)}
        {pad(num(row.put?.bid ?? null), 7)}
        {pad(num(row.put?.ask ?? null), 7)}
        {pad(num(row.put?.delta ?? null, 2), 7)}
      </Text>
    </Text>
  );
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}
