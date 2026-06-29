import React from 'react';
import { Box, Text } from 'ink';
import { AddScreen } from './add.js';
import { ListScreen, RemoveScreen } from './watchlist.js';
import { ReturnPrompt } from './menu.js';

/**
 * `regard watch <ls|add|rm>` dispatcher — the explicit "managed watchlist"
 * surface called out in `docs/surface-parity.md`.
 *
 * The underlying screens (`ListScreen`, `AddScreen`, `RemoveScreen`) already
 * exist for the legacy `regard ls|add|rm` entrypoints and talk to the same
 * `/tickers` endpoints. This screen is a thin verb dispatcher so the CLI
 * mirrors the web `/watchlist` route and the parity-table entry for #167.
 *
 * Subcommands map 1:1 to existing flows:
 *   - `watch ls`            → `ListScreen`
 *   - `watch add <SYM>...`  → `AddScreen` (no `--refresh` here; use
 *                             the legacy `regard add` for refresh flows)
 *   - `watch rm <SYM>`      → `RemoveScreen`
 */
export type WatchSub = 'ls' | 'add' | 'rm';

/** Parse the `regard watch <sub> [...args]` argv slice. Exported for tests. */
export function parseWatchArgs(args: readonly string[]):
  | { kind: 'ls' }
  | { kind: 'add'; symbols: string[] }
  | { kind: 'rm'; symbol: string }
  | { kind: 'error'; message: string } {
  const [sub, ...rest] = args;
  if (!sub) {
    return {
      kind: 'error',
      message: 'Usage: regard watch <ls|add|rm> [SYM...]',
    };
  }
  const normalized = sub.toLowerCase();
  if (normalized === 'ls' || normalized === 'list') {
    return { kind: 'ls' };
  }
  if (normalized === 'add') {
    const symbols = rest.map((s) => s.toUpperCase()).filter((s) => s.length > 0);
    if (symbols.length === 0) {
      return { kind: 'error', message: 'Usage: regard watch add <SYM> [<SYM>...]' };
    }
    return { kind: 'add', symbols };
  }
  if (normalized === 'rm' || normalized === 'remove') {
    const symbol = (rest[0] ?? '').toUpperCase();
    if (!symbol) {
      return { kind: 'error', message: 'Usage: regard watch rm <SYM>' };
    }
    return { kind: 'rm', symbol };
  }
  return {
    kind: 'error',
    message: `Unknown subcommand: regard watch ${sub}. Try ls | add | rm.`,
  };
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
  if (parsed.kind === 'ls') {
    return <ListScreen serverUrl={serverUrl} onDone={onDone} />;
  }
  if (parsed.kind === 'add') {
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
