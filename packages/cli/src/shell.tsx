import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { BriefingScreen } from './screens/briefing.js';
import { QuoteScreen } from './screens/quote.js';
import { PlanScreen } from './screens/plan.js';
import { ConfigScreen } from './screens/config.js';
import { AddScreen } from './screens/add.js';
import { ListScreen, RemoveScreen } from './screens/watchlist.js';
import { DashboardScreen } from './screens/dashboard.js';

/**
 * Fancy modal-style shell inspired by Copilot CLI / Claude Code. Everything is
 * driven by `/` slash commands. The shell stays mounted; each command renders
 * inside the same bordered container and returns to the prompt when done.
 */

type Mode =
  | { kind: 'idle' }
  | { kind: 'running'; cmd: SlashId; args: string[] };

type SlashId =
  | 'briefing'
  | 'quote'
  | 'plan'
  | 'add'
  | 'ls'
  | 'rm'
  | 'config'
  | 'dashboard'
  | 'help'
  | 'clear'
  | 'quit';

interface SlashCommand {
  id: SlashId;
  name: string;
  usage: string;
  blurb: string;
  needsArgs?: boolean;
}

const COMMANDS: SlashCommand[] = [
  { id: 'briefing', name: '/briefing', usage: '/briefing <SYM>', blurb: 'AI bull/bear write-up for a ticker', needsArgs: true },
  { id: 'quote',    name: '/quote',    usage: '/quote <SYM>',    blurb: 'Quick price snapshot',                    needsArgs: true },
  { id: 'plan',     name: '/plan',     usage: '/plan <SYM>',     blurb: 'Interactive options trade-plan wizard',   needsArgs: true },
  { id: 'add',      name: '/add',      usage: '/add <SYM>...',   blurb: 'Validate ticker(s) and add to watchlist', needsArgs: true },
  { id: 'ls',       name: '/ls',       usage: '/ls',             blurb: 'Show watchlist' },
  { id: 'rm',       name: '/rm',       usage: '/rm <SYM>',       blurb: 'Remove a ticker from watchlist',          needsArgs: true },
  { id: 'config',   name: '/config',   usage: '/config',         blurb: 'AI providers, risk, server' },
  { id: 'dashboard',name: '/dashboard',usage: '/dashboard',      blurb: 'Open local web dashboard' },
  { id: 'help',     name: '/help',     usage: '/help',           blurb: 'List slash commands' },
  { id: 'clear',    name: '/clear',    usage: '/clear',          blurb: 'Clear the screen' },
  { id: 'quit',     name: '/quit',     usage: '/quit',           blurb: 'Exit the shell' },
];

const ACCENT = 'cyan';
const AI_ACCENT = 'cyanBright';
const MUTED = 'gray';

export function Shell({ serverUrl }: { serverUrl: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [input, setInput] = useState('');
  const [showHelp, setShowHelp] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // bumped by /clear to remount idle content

  const width = Math.min(stdout?.columns ?? 100, 110);

  const submit = (raw: string) => {
    setError(null);
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith('/')) {
      setError(`Commands start with "/" — try /help`);
      return;
    }
    const [head, ...rest] = trimmed.slice(1).split(/\s+/);
    const cmd = COMMANDS.find((c) => c.id === head);
    if (!cmd) {
      setError(`Unknown command: /${head}. Try /help.`);
      return;
    }
    setInput('');
    if (cmd.id === 'quit') {
      exit();
      return;
    }
    if (cmd.id === 'clear') {
      setShowHelp(false);
      setTick((t) => t + 1);
      return;
    }
    if (cmd.id === 'help') {
      setShowHelp(true);
      return;
    }
    if (cmd.needsArgs && rest.length === 0) {
      setError(`Usage: ${cmd.usage}`);
      return;
    }
    setShowHelp(false);
    setMode({ kind: 'running', cmd: cmd.id, args: rest });
  };

  const returnToIdle = () => {
    setMode({ kind: 'idle' });
  };

  // Esc from idle clears the input; from running, the screens handle their own keys.
  useInput((_, key) => {
    if (mode.kind !== 'idle') return;
    if (key.escape) setInput('');
  });

  const isIdle = mode.kind === 'idle';

  return (
    <Box flexDirection="column" width={width}>
      <Header active={mode.kind === 'running' ? mode.cmd : null} />
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={ACCENT}
        paddingX={1}
        paddingY={0}
        minHeight={10}
      >
        {isIdle ? (
          <IdleBody
            key={tick}
            showHelp={showHelp}
            filter={input}
          />
        ) : (
          <RunningBody
            mode={mode}
            serverUrl={serverUrl}
            onDone={returnToIdle}
          />
        )}
      </Box>
      {isIdle && (
        <>
          {error && (
            <Box paddingX={1}>
              <Text color="red">⚠ {error}</Text>
            </Box>
          )}
          <Prompt input={input} setInput={setInput} onSubmit={submit} />
          <Box paddingX={1}>
            <Text color={MUTED} dimColor>
              type <Text color={ACCENT}>/</Text> for commands · enter to run · /quit to exit ·{' '}
              <Text italic>not financial advice</Text>
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}

function Header({ active }: { active: SlashId | null }) {
  return (
    <Box paddingX={1} paddingY={0} justifyContent="space-between">
      <Text>
        <Text color={ACCENT} bold>◆ </Text>
        <Text bold>RegardedTrader</Text>
        <Text color={MUTED} dimColor> · local research terminal</Text>
      </Text>
      <Text color={MUTED} dimColor>
        {active ? (
          <>
            running <Text color={AI_ACCENT}>/{active}</Text>
          </>
        ) : (
          'idle'
        )}
      </Text>
    </Box>
  );
}

function IdleBody({ showHelp, filter }: { showHelp: boolean; filter: string }) {
  const typing = filter.startsWith('/');
  const query = typing ? filter.slice(1).toLowerCase() : '';
  const matches = typing
    ? COMMANDS.filter((c) => c.id.startsWith(query) || c.name.includes(query))
    : COMMANDS;

  return (
    <Box flexDirection="column">
      {!typing && showHelp && (
        <>
          <Text>
            <Text color={AI_ACCENT}>Welcome.</Text>{' '}
            <Text color={MUTED}>Use slash commands to drive analysis.</Text>
          </Text>
          <Text> </Text>
        </>
      )}
      {(typing || showHelp) && (
        <Box flexDirection="column">
          <Text color={MUTED} dimColor>
            {typing ? `commands matching "${filter}"` : 'commands'}
          </Text>
          {matches.length === 0 ? (
            <Text color="yellow">  (no matches)</Text>
          ) : (
            matches.map((c) => (
              <Text key={c.id}>
                <Text color={ACCENT} bold>{c.name.padEnd(12)}</Text>
                <Text>{c.blurb}</Text>
                <Text color={MUTED} dimColor>  ·  {c.usage}</Text>
              </Text>
            ))
          )}
        </Box>
      )}
      {!typing && !showHelp && (
        <Text color={MUTED} dimColor>ready · type / to see commands</Text>
      )}
    </Box>
  );
}

function Prompt({
  input,
  setInput,
  onSubmit,
}: {
  input: string;
  setInput: (v: string) => void;
  onSubmit: (v: string) => void;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor={ACCENT}
      paddingX={1}
      flexDirection="row"
    >
      <Text color={AI_ACCENT} bold>❯ </Text>
      <Box flexGrow={1}>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={onSubmit}
          placeholder="/help for commands…"
        />
      </Box>
    </Box>
  );
}

function RunningBody({
  mode,
  serverUrl,
  onDone,
}: {
  mode: Extract<Mode, { kind: 'running' }>;
  serverUrl: string;
  onDone: () => void;
}) {
  const { cmd, args } = mode;
  switch (cmd) {
    case 'briefing':
      return <BriefingScreen symbol={(args[0] ?? '').toUpperCase()} serverUrl={serverUrl} onDone={onDone} />;
    case 'quote':
      return <QuoteScreen symbol={(args[0] ?? '').toUpperCase()} serverUrl={serverUrl} onDone={onDone} />;
    case 'plan':
      return <PlanScreen symbol={(args[0] ?? '').toUpperCase()} serverUrl={serverUrl} onDone={onDone} />;
    case 'add':
      return (
        <AddScreen
          symbols={args.map((a) => a.toUpperCase())}
          refresh={false}
          serverUrl={serverUrl}
          onDone={onDone}
        />
      );
    case 'ls':
      return <ListScreen serverUrl={serverUrl} onDone={onDone} />;
    case 'rm':
      return <RemoveScreen symbol={(args[0] ?? '').toUpperCase()} serverUrl={serverUrl} onDone={onDone} />;
    case 'config':
      return <ConfigScreen onDone={onDone} />;
    case 'dashboard':
      return <DashboardScreen serverUrl={serverUrl} onDone={onDone} />;
    default:
      return null;
  }
}
