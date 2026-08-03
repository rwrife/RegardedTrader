import React from 'react';
import { Box, Text } from 'ink';
import { AddScreen } from './add.js';
import { ListScreen, RemoveScreen } from './watchlist.js';
import { WatchTapeScreen } from './polling.js';
import { ReturnPrompt } from './menu.js';

/**
 * `regard watch [SYM...]` live-tape dispatcher.
 *
 * The underlying screens (`ListScreen`, `AddScreen`, `RemoveScreen`) already
 * exist for the legacy `regard ls|add|rm` entrypoints and talk to the same
 * `/tickers` endpoints. This screen is a thin verb dispatcher so the CLI
 * mirrors the web `/watchlist` route and the parity-table entry for #167.
 *
 * Legacy subcommands still map 1:1 to existing watchlist flows:
 *   - `watch ls`            → `ListScreen`
 *   - `watch add <SYM>...`  → `AddScreen` (no `--refresh` here; use
 *                             the legacy `regard add` for refresh flows)
 *   - `watch rm <SYM>`      → `RemoveScreen`
 */
export type WatchSub = 'ls' | 'add' | 'rm';

/** Parse the `regard watch <sub> [...args]` argv slice. Exported for tests. */
export function parseWatchArgs(args: readonly string[]):
  | { kind: 'tape'; symbols: string[] }
  | { kind: 'legacy-ls' }
  | { kind: 'legacy-add'; symbols: string[] }
  | { kind: 'legacy-rm'; symbol: string }
  | { kind: 'error'; message: string } {
  const [sub, ...rest] = args;
  if (!sub) return { kind: 'tape', symbols: [] };
  const first = sub.toLowerCase();
  if (!['ls', 'list', 'add', 'rm', 'remove'].includes(first)) {
    const symbols = [sub, ...rest].map((s) => s.toUpperCase()).filter((s) => s.length > 0);
    return { kind: 'tape', symbols };
  }
  if (first === 'ls' || first === 'list') {
    return { kind: 'legacy-ls' };
  }
  if (first === 'add') {
    const symbols = rest.map((s) => s.toUpperCase()).filter((s) => s.length > 0);
    if (symbols.length === 0) {
      return { kind: 'error', message: 'Usage: regard watch add <SYM> [<SYM>...]' };
    }
    return { kind: 'legacy-add', symbols };
  }
  if (first === 'rm' || first === 'remove') {
    const symbol = (rest[0] ?? '').toUpperCase();
    if (!symbol) {
      return { kind: 'error', message: 'Usage: regard watch rm <SYM>' };
    }
    return { kind: 'legacy-rm', symbol };
  }
  return { kind: 'tape', symbols: [] };
}

export function WatchScreen({
  args,
  serverUrl,
  onDone,
}: {
  args: readonly string[];
  serverUrl: string;
  onDone?: () => void;
}) {
  const parsed = parseWatchArgs(args);

  if (parsed.kind === 'error') {
    return (
      <Box flexDirection="column">
        <Text color="red">{parsed.message}</Text>
        {onDone && <ReturnPrompt onDone={onDone} />}
      </Box>
    );
  }
  if (parsed.kind === 'tape') {
    return <WatchTapeScreen symbols={parsed.symbols} serverUrl={serverUrl} />;
  }
  if (parsed.kind === 'legacy-ls') {
    return <ListScreen serverUrl={serverUrl} onDone={onDone} />;
  }
  if (parsed.kind === 'legacy-add') {
    return (
      <AddScreen
        symbols={parsed.symbols}
        refresh={false}
        serverUrl={serverUrl}
        onDone={onDone}
      />
    );
  }
  return <RemoveScreen symbol={parsed.symbol} serverUrl={serverUrl} onDone={onDone} />;
}
