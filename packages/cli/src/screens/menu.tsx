import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { BriefingScreen } from './briefing.js';
import { QuoteScreen } from './quote.js';
import { PlanScreen } from './plan.js';
import { ConfigScreen } from './config.js';
import { AddScreen } from './add.js';
import { ListScreen, RemoveScreen } from './watchlist.js';
import { WatchScreen } from './watch.js';
import { DashboardScreen } from './dashboard.js';

/**
 * Interactive shell for the CLI. Lets the user pick an action, runs it, then
 * (per #86) returns here instead of exiting — so you don't have to retype
 * `regard …` for every step. Direct invocations (`regard briefing NVDA`)
 * still run one-shot and exit; this screen is only mounted when `regard` is
 * invoked with no command.
 */

type View =
  | { kind: 'menu' }
  | { kind: 'prompt-symbol'; for: SymbolAction }
  | { kind: 'add-input' }
  | { kind: 'watch-input' }
  | { kind: 'action'; action: MenuAction; symbol?: string; symbols?: string[]; watchArgs?: string[] };

type SymbolAction = 'briefing' | 'quote' | 'plan' | 'rm';
type MenuAction =
  | SymbolAction
  | 'add'
  | 'ls'
  | 'config'
  | 'dashboard'
  | 'watch';

interface MenuItem {
  label: string;
  value: MenuAction | 'quit';
}

const ITEMS: MenuItem[] = [
  { label: 'Briefing — AI write-up for a ticker', value: 'briefing' },
  { label: 'Quote — quick price snapshot', value: 'quote' },
  { label: 'Plan — interactive trade-plan wizard', value: 'plan' },
  { label: 'Add — validate & add tickers to watchlist', value: 'add' },
  { label: 'List — show watchlist', value: 'ls' },
  { label: 'Remove — drop a ticker from watchlist', value: 'rm' },
  { label: 'Watch — managed watchlist (ls/add/rm)', value: 'watch' },
  { label: 'Config — AI providers, risk, server', value: 'config' },
  { label: 'Dashboard — open web UI', value: 'dashboard' },
  { label: 'Quit', value: 'quit' },
];

const SYMBOL_ACTIONS = new Set<MenuAction>(['briefing', 'quote', 'plan', 'rm']);

export function MainMenu({ serverUrl }: { serverUrl: string }) {
  const { exit } = useApp();
  const [view, setView] = useState<View>({ kind: 'menu' });

  const returnToMenu = (): void => setView({ kind: 'menu' });

  if (view.kind === 'menu') {
    return (
      <Menu
        onPick={(value) => {
          if (value === 'quit') {
            exit();
            return;
          }
          if (SYMBOL_ACTIONS.has(value)) {
            setView({ kind: 'prompt-symbol', for: value as SymbolAction });
            return;
          }
          if (value === 'add') {
            setView({ kind: 'add-input' });
            return;
          }
          if (value === 'watch') {
            setView({ kind: 'watch-input' });
            return;
          }
          setView({ kind: 'action', action: value });
        }}
      />
    );
  }

  if (view.kind === 'prompt-symbol') {
    return (
      <SymbolPrompt
        label={view.for}
        onCancel={returnToMenu}
        onSubmit={(symbol) =>
          setView({ kind: 'action', action: view.for, symbol })
        }
      />
    );
  }

  if (view.kind === 'add-input') {
    return (
      <SymbolsPrompt
        onCancel={returnToMenu}
        onSubmit={(symbols) =>
          setView({ kind: 'action', action: 'add', symbols })
        }
      />
    );
  }

  if (view.kind === 'watch-input') {
    return (
      <WatchPrompt
        onCancel={returnToMenu}
        onSubmit={(watchArgs) =>
          setView({ kind: 'action', action: 'watch', watchArgs })
        }
      />
    );
  }

  // view.kind === 'action'
  const { action } = view;
  switch (action) {
    case 'briefing':
      return (
        <BriefingScreen
          symbol={view.symbol ?? ''}
          serverUrl={serverUrl}
          onDone={returnToMenu}
        />
      );
    case 'quote':
      return (
        <QuoteScreen
          symbol={view.symbol ?? ''}
          serverUrl={serverUrl}
          onDone={returnToMenu}
        />
      );
    case 'plan':
      return (
        <PlanScreen
          symbol={view.symbol ?? ''}
          serverUrl={serverUrl}
          onDone={returnToMenu}
        />
      );
    case 'add':
      return (
        <AddScreen
          symbols={view.symbols ?? []}
          refresh={false}
          serverUrl={serverUrl}
          onDone={returnToMenu}
        />
      );
    case 'ls':
      return <ListScreen serverUrl={serverUrl} onDone={returnToMenu} />;
    case 'rm':
      return (
        <RemoveScreen
          symbol={view.symbol ?? ''}
          serverUrl={serverUrl}
          onDone={returnToMenu}
        />
      );
    case 'config':
      return <ConfigScreen onDone={returnToMenu} />;
    case 'dashboard':
      return <DashboardScreen serverUrl={serverUrl} onDone={returnToMenu} />;
    case 'watch':
      return (
        <WatchScreen
          args={view.watchArgs ?? []}
          serverUrl={serverUrl}
          onDone={returnToMenu}
        />
      );
  }
}

function Menu({ onPick }: { onPick: (v: MenuItem['value']) => void }) {
  const [i, setI] = useState(0);
  useInput((input, key) => {
    if (key.upArrow) setI((p) => (p - 1 + ITEMS.length) % ITEMS.length);
    else if (key.downArrow) setI((p) => (p + 1) % ITEMS.length);
    else if (key.return) onPick(ITEMS[i]!.value);
    else if (input === 'q' || input === '\u001b') onPick('quit');
  });
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">━━ RegardedTrader ━━</Text>
      <Text dimColor>↑/↓ to move · enter to select · q to quit</Text>
      <Text> </Text>
      {ITEMS.map((item, idx) => (
        <Text key={item.value}>
          {idx === i ? <Text color="green">▶ </Text> : <Text>  </Text>}
          <Text bold={idx === i}>{item.label}</Text>
        </Text>
      ))}
    </Box>
  );
}

function SymbolPrompt({
  label,
  onSubmit,
  onCancel,
}: {
  label: string;
  onSubmit: (symbol: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  useInput((input, key) => {
    if (key.escape) onCancel();
  });
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color="cyan">{label}</Text>
        <Text> — enter a ticker symbol </Text>
        <Text dimColor>(esc to cancel)</Text>
      </Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={(v) => {
          const sym = v.trim().toUpperCase();
          if (sym) onSubmit(sym);
        }}
      />
    </Box>
  );
}

function SymbolsPrompt({
  onSubmit,
  onCancel,
}: {
  onSubmit: (symbols: string[]) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  useInput((input, key) => {
    if (key.escape) onCancel();
  });
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color="cyan">add</Text>
        <Text> — enter one or more tickers, space-separated </Text>
        <Text dimColor>(esc to cancel)</Text>
      </Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={(v) => {
          const syms = v
            .split(/[\s,]+/)
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean);
          if (syms.length > 0) onSubmit(syms);
        }}
      />
    </Box>
  );
}

/**
 * Free-form prompt for `regard watch <ls|add|rm> [SYM...]`. Hands the raw
 * tokens to `WatchScreen`, which owns the actual subcommand dispatch.
 */
function WatchPrompt({
  onSubmit,
  onCancel,
}: {
  onSubmit: (args: string[]) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  useInput((_, key) => {
    if (key.escape) onCancel();
  });
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color="cyan">watch</Text>
        <Text> — type subcommand: </Text>
        <Text>ls</Text>
        <Text dimColor> | </Text>
        <Text>add SYM...</Text>
        <Text dimColor> | </Text>
        <Text>rm SYM</Text>
        <Text dimColor> (esc to cancel)</Text>
      </Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={(v) => {
          const parts = v.split(/\s+/).map((s) => s.trim()).filter(Boolean);
          if (parts.length > 0) onSubmit(parts);
        }}
      />
    </Box>
  );
}

/**
 * Drop-in tail used by every action screen when running under the menu:
 * waits for any key, then calls `onDone`. Lets the user actually read the
 * output before being kicked back to the menu.
 */
export function ReturnPrompt({ onDone }: { onDone: () => void }) {
  const { exit } = useApp();
  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      exit();
      return;
    }
    onDone();
  });
  return (
    <Box marginTop={1}>
      <Text dimColor>↵ any key to return · q/esc to quit</Text>
    </Box>
  );
}
