import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import {
  loadConfig,
  saveConfig,
  redactConfig,
  configPath,
  type AppConfig,
  type AiProvider,
  type ConfigTestResult,
} from '@regardedtrader/core';
import { api } from '../api.js';

type Mode =
  | 'menu'
  | 'pick-kind'
  | 'http-form'
  | 'cli-form'
  | 'pick-active'
  | 'remove'
  | 'show'
  | 'test'
  | 'done';

type CliBackend = 'codex-cli' | 'claude-cli' | 'copilot-cli';

export function ConfigScreen({
  sub,
  testProviderId,
  serverUrl,
  onDone,
}: {
  sub?: string;
  testProviderId?: string;
  serverUrl?: string;
  onDone?: () => void;
}) {
  const { exit } = useApp();
  const leave = onDone ?? exit;
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [mode, setMode] = useState<Mode>(
    sub === 'show' ? 'show' : sub === 'test' ? 'test' : 'menu',
  );
  const [msg, setMsg] = useState<string>('');

  useEffect(() => {
    loadConfig().then(setCfg);
  }, []);

  if (!cfg) return <Text>loading config…</Text>;

  if (mode === 'show') {
    const r = redactConfig(cfg);
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">Config: <Text color="white">{configPath()}</Text></Text>
        <Text>Active provider: <Text color="green">{r.activeProvider ?? '(none)'}</Text></Text>
        <Text bold>Providers:</Text>
        {Object.entries(r.providers).length === 0 && <Text color="yellow">  (none)</Text>}
        {Object.entries(r.providers).map(([id, p]) => (
          <Text key={id}>
            {'  '}• <Text bold>{id}</Text> — {p.kind === 'openai-compatible'
              ? `${p.label} (${p.baseUrl}, model=${p.model}${p.apiKey ? `, key=${p.apiKey}` : ''})`
              : `${p.label} CLI ${p.backend}${p.model ? ` model=${p.model}` : ''}`}
          </Text>
        ))}
        <Text>
          Risk: maxLoss=${cfg.risk.maxLossUsd} maxLegs={cfg.risk.maxLegs}{' '}
          forbidNakedShorts={String(cfg.risk.forbidNakedShorts)}
        </Text>
        <Text>
          Risk (#181): maxDte={cfg.risk.maxDte === 0 ? 'off' : `${cfg.risk.maxDte}d`}{' '}
          accountSize=${cfg.risk.accountSizeUsd}{' '}
          maxPctOfAccount={(cfg.risk.maxPctOfAccount * 100).toFixed(2)}%
        </Text>
        <Text>Server: {cfg.server.host}:{cfg.server.port}</Text>
        <Text dimColor>(use `regard config` for the interactive editor)</Text>
        <Exit exit={leave} interactive={!!onDone} />
      </Box>
    );
  }

  if (mode === 'test') {
    return (
      <TestConnection
        serverUrl={serverUrl ?? 'http://127.0.0.1:4317'}
        providerId={testProviderId}
        exit={leave}
        interactive={!!onDone}
      />
    );
  }

  if (mode === 'done') {
    return (
      <Box flexDirection="column">
        <Text color="green">{msg || 'Config saved.'}</Text>
        <Text dimColor>{configPath()}</Text>
        <Exit exit={leave} interactive={!!onDone} />
      </Box>
    );
  }

  if (mode === 'menu') {
    return (
      <Menu
        cfg={cfg}
        onPick={(choice) => {
          if (choice === 'add') setMode('pick-kind');
          else if (choice === 'active') setMode('pick-active');
          else if (choice === 'remove') setMode('remove');
          else if (choice === 'show') setMode('show');
          else if (choice === 'test') setMode('test');
          else if (choice === 'quit') leave();
        }}
      />
    );
  }

  if (mode === 'pick-kind') {
    return (
      <PickKind
        onPick={(kind) => {
          if (kind === 'http') setMode('http-form');
          else setMode('cli-form');
        }}
      />
    );
  }

  if (mode === 'http-form') {
    return (
      <HttpForm
        onCancel={() => setMode('menu')}
        onSave={async (id, p) => {
          const next: AppConfig = {
            ...cfg,
            providers: { ...cfg.providers, [id]: p },
            activeProvider: cfg.activeProvider ?? id,
          };
          await saveConfig(next);
          setCfg(next);
          setMsg(`Added "${id}" and set active.`);
          setMode('done');
        }}
      />
    );
  }

  if (mode === 'cli-form') {
    return (
      <CliForm
        onCancel={() => setMode('menu')}
        onSave={async (id, p) => {
          const next: AppConfig = {
            ...cfg,
            providers: { ...cfg.providers, [id]: p },
            activeProvider: cfg.activeProvider ?? id,
          };
          await saveConfig(next);
          setCfg(next);
          setMsg(`Added "${id}" CLI backend.`);
          setMode('done');
        }}
      />
    );
  }

  if (mode === 'pick-active') {
    return (
      <PickActive
        cfg={cfg}
        onPick={async (id) => {
          const next = { ...cfg, activeProvider: id };
          await saveConfig(next);
          setCfg(next);
          setMsg(`Active provider: ${id}`);
          setMode('done');
        }}
      />
    );
  }

  if (mode === 'remove') {
    return (
      <Remove
        cfg={cfg}
        onPick={async (id) => {
          const providers = { ...cfg.providers };
          delete providers[id];
          const activeProvider = cfg.activeProvider === id ? null : cfg.activeProvider;
          const next: AppConfig = { ...cfg, providers, activeProvider };
          await saveConfig(next);
          setCfg(next);
          setMsg(`Removed "${id}".`);
          setMode('done');
        }}
      />
    );
  }
  return null;
}

function Exit({ exit, interactive }: { exit: () => void; interactive?: boolean }) {
  useInput((input) => {
    if (input === 'q' || input === '\u001b') exit();
    else if (interactive) exit();
  });
  useEffect(() => {
    if (interactive) return;
    const t = setTimeout(exit, 100);
    return () => clearTimeout(t);
  }, [exit, interactive]);
  return null;
}

type MenuChoice = 'add' | 'active' | 'remove' | 'show' | 'test' | 'quit';

function Menu({ cfg, onPick }: { cfg: AppConfig; onPick: (c: MenuChoice) => void }) {
  const [i, setI] = useState(0);
  const items: { label: string; value: MenuChoice }[] = [
    { label: 'Add a new AI provider', value: 'add' },
    { label: 'Choose active provider', value: 'active' },
    { label: 'Remove a provider', value: 'remove' },
    { label: 'Show current config', value: 'show' },
    { label: 'Test connection (active provider)', value: 'test' },
    { label: 'Quit', value: 'quit' },
  ];
  useInput((input, key) => {
    if (key.upArrow) setI((p) => (p - 1 + items.length) % items.length);
    else if (key.downArrow) setI((p) => (p + 1) % items.length);
    else if (key.return) onPick(items[i]!.value);
  });
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">━━ RegardedTrader config ━━</Text>
      <Text dimColor>Active: <Text color="green">{cfg.activeProvider ?? '(none)'}</Text> · Providers: {Object.keys(cfg.providers).length}</Text>
      <Text> </Text>
      {items.map((it, idx) => (
        <Text key={it.value} color={idx === i ? 'cyan' : undefined}>
          {idx === i ? '› ' : '  '}{it.label}
        </Text>
      ))}
      <Text> </Text>
      <Text dimColor>↑/↓ to move · Enter to select</Text>
    </Box>
  );
}

function PickKind({ onPick }: { onPick: (k: 'http' | 'cli') => void }) {
  const [i, setI] = useState(0);
  const items = [
    { label: 'OpenAI-compatible HTTP endpoint (OpenAI, Azure, OpenRouter, Ollama, vLLM, Groq, etc.)', value: 'http' as const },
    { label: 'Local CLI backend (Copilot, Claude Code, Codex CLI)', value: 'cli' as const },
  ];
  useInput((_input, key) => {
    if (key.upArrow) setI((p) => (p - 1 + items.length) % items.length);
    else if (key.downArrow) setI((p) => (p + 1) % items.length);
    else if (key.return) onPick(items[i]!.value);
  });
  return (
    <Box flexDirection="column">
      <Text bold>Pick provider kind:</Text>
      {items.map((it, idx) => (
        <Text key={it.value} color={idx === i ? 'cyan' : undefined}>
          {idx === i ? '› ' : '  '}{it.label}
        </Text>
      ))}
    </Box>
  );
}

const PRESETS: Record<string, { baseUrl: string; model: string; needsKey: boolean }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needsKey: true },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-70b-versatile', needsKey: true },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', needsKey: true },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1:latest', needsKey: false },
  custom: { baseUrl: '', model: '', needsKey: false },
};

function HttpForm({
  onSave,
  onCancel,
}: {
  onSave: (id: string, p: AiProvider) => Promise<void>;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<'preset' | 'id' | 'baseUrl' | 'model' | 'key'>('preset');
  const [presetIdx, setPresetIdx] = useState(0);
  const presetKeys = Object.keys(PRESETS);
  const [id, setId] = useState('openai');
  const [label, setLabel] = useState('OpenAI');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');

  useInput((input, key) => {
    if (step !== 'preset') return;
    if (key.upArrow) setPresetIdx((p) => (p - 1 + presetKeys.length) % presetKeys.length);
    else if (key.downArrow) setPresetIdx((p) => (p + 1) % presetKeys.length);
    else if (input === '\u001b') onCancel();
    else if (key.return) {
      const k = presetKeys[presetIdx]!;
      const preset = PRESETS[k]!;
      setId(k);
      setLabel(k.charAt(0).toUpperCase() + k.slice(1));
      setBaseUrl(preset.baseUrl);
      setModel(preset.model);
      setStep('id');
    }
  });

  if (step === 'preset') {
    return (
      <Box flexDirection="column">
        <Text bold>Pick a preset (or custom):</Text>
        {presetKeys.map((k, idx) => (
          <Text key={k} color={idx === presetIdx ? 'cyan' : undefined}>
            {idx === presetIdx ? '› ' : '  '}{k} {PRESETS[k]!.baseUrl && <Text dimColor>· {PRESETS[k]!.baseUrl}</Text>}
          </Text>
        ))}
        <Text dimColor>Esc cancels</Text>
      </Box>
    );
  }

  if (step === 'id') {
    return (
      <Box flexDirection="column">
        <Text>Provider id (used in commands, e.g. "openai"):</Text>
        <TextInput
          value={id}
          onChange={setId}
          onSubmit={() => {
            setLabel(id.charAt(0).toUpperCase() + id.slice(1));
            setStep('baseUrl');
          }}
        />
      </Box>
    );
  }

  if (step === 'baseUrl') {
    return (
      <Box flexDirection="column">
        <Text>Base URL:</Text>
        <TextInput value={baseUrl} onChange={setBaseUrl} onSubmit={() => setStep('model')} />
      </Box>
    );
  }

  if (step === 'model') {
    return (
      <Box flexDirection="column">
        <Text>Model id:</Text>
        <TextInput value={model} onChange={setModel} onSubmit={() => setStep('key')} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>API key (leave blank for keyless local servers):</Text>
      <TextInput
        value={apiKey}
        onChange={setApiKey}
        mask="*"
        onSubmit={() => {
          const provider: AiProvider = {
            kind: 'openai-compatible',
            label,
            baseUrl,
            model,
            apiKey: apiKey || undefined,
          };
          onSave(id, provider);
        }}
      />
    </Box>
  );
}

function CliForm({
  onSave,
  onCancel,
}: {
  onSave: (id: string, p: AiProvider) => Promise<void>;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<'backend' | 'id' | 'cmd' | 'model'>('backend');
  const backends: { backend: CliBackend; defaultCmd: string; hint: string }[] = [
    { backend: 'codex-cli', defaultCmd: 'codex', hint: 'OpenAI Codex CLI (`codex exec`)' },
    { backend: 'claude-cli', defaultCmd: 'claude', hint: 'Claude Code (`claude -p`)' },
    { backend: 'copilot-cli', defaultCmd: 'copilot', hint: 'GitHub Copilot CLI (standalone `@github/copilot`)' },
  ];
  const [bIdx, setBIdx] = useState(0);
  const [id, setId] = useState('codex');
  const [cmd, setCmd] = useState('');
  const [model, setModel] = useState('');

  useInput((input, key) => {
    if (step !== 'backend') return;
    if (key.upArrow) setBIdx((p) => (p - 1 + backends.length) % backends.length);
    else if (key.downArrow) setBIdx((p) => (p + 1) % backends.length);
    else if (input === '\u001b') onCancel();
    else if (key.return) {
      const b = backends[bIdx]!;
      setId(b.backend.replace('-cli', ''));
      setCmd(b.defaultCmd);
      setStep('id');
    }
  });

  if (step === 'backend') {
    return (
      <Box flexDirection="column">
        <Text bold>Pick CLI backend:</Text>
        {backends.map((b, idx) => (
          <Text key={b.backend} color={idx === bIdx ? 'cyan' : undefined}>
            {idx === bIdx ? '› ' : '  '}{b.backend} <Text dimColor>· {b.hint}</Text>
          </Text>
        ))}
        <Text dimColor>(make sure the CLI is installed and authenticated separately)</Text>
      </Box>
    );
  }

  if (step === 'id') {
    return (
      <Box flexDirection="column">
        <Text>Provider id:</Text>
        <TextInput value={id} onChange={setId} onSubmit={() => setStep('cmd')} />
      </Box>
    );
  }

  if (step === 'cmd') {
    return (
      <Box flexDirection="column">
        <Text>Binary path (Enter to use default):</Text>
        <TextInput value={cmd} onChange={setCmd} onSubmit={() => setStep('model')} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>Model id (optional, e.g. gpt-5 / claude-opus-4):</Text>
      <TextInput
        value={model}
        onChange={setModel}
        onSubmit={() => {
          const b = backends[bIdx]!;
          const provider: AiProvider = {
            kind: 'cli',
            label: b.backend,
            backend: b.backend,
            command: cmd || undefined,
            model: model || undefined,
          };
          onSave(id, provider);
        }}
      />
    </Box>
  );
}

function PickActive({ cfg, onPick }: { cfg: AppConfig; onPick: (id: string) => void }) {
  const ids = Object.keys(cfg.providers);
  const [i, setI] = useState(0);
  useInput((_input, key) => {
    if (ids.length === 0) return;
    if (key.upArrow) setI((p) => (p - 1 + ids.length) % ids.length);
    else if (key.downArrow) setI((p) => (p + 1) % ids.length);
    else if (key.return) onPick(ids[i]!);
  });
  if (ids.length === 0) return <Text color="yellow">No providers yet. Add one first.</Text>;
  return (
    <Box flexDirection="column">
      <Text bold>Active provider:</Text>
      {ids.map((id, idx) => (
        <Text key={id} color={idx === i ? 'cyan' : undefined}>
          {idx === i ? '› ' : '  '}{id} {cfg.activeProvider === id && <Text dimColor>(current)</Text>}
        </Text>
      ))}
    </Box>
  );
}

function Remove({ cfg, onPick }: { cfg: AppConfig; onPick: (id: string) => void }) {
  const ids = Object.keys(cfg.providers);
  const [i, setI] = useState(0);
  useInput((_input, key) => {
    if (ids.length === 0) return;
    if (key.upArrow) setI((p) => (p - 1 + ids.length) % ids.length);
    else if (key.downArrow) setI((p) => (p + 1) % ids.length);
    else if (key.return) onPick(ids[i]!);
  });
  if (ids.length === 0) return <Text color="yellow">Nothing to remove.</Text>;
  return (
    <Box flexDirection="column">
      <Text bold color="red">Remove which provider?</Text>
      {ids.map((id, idx) => (
        <Text key={id} color={idx === i ? 'red' : undefined}>
          {idx === i ? '› ' : '  '}{id}
        </Text>
      ))}
    </Box>
  );
}

/**
 * `regard config test [providerId]` — pings the configured provider via the
 * local server's `POST /config/test` endpoint and renders the structured
 * `ConfigTestResult` (latency + model on success, code/message/hint on
 * failure). When `providerId` is omitted, the server tests the active
 * provider.
 */
function TestConnection({
  serverUrl,
  providerId,
  exit,
  interactive,
}: {
  serverUrl: string;
  providerId?: string;
  exit: () => void;
  interactive?: boolean;
}) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'result'; result: ConfigTestResult }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await api<ConfigTestResult>(serverUrl, '/config/test', {
          method: 'POST',
          body: JSON.stringify(providerId ? { providerId } : {}),
        });
        if (!cancelled) setState({ kind: 'result', result });
      } catch (e) {
        if (!cancelled)
          setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverUrl, providerId]);

  if (state.kind === 'loading') {
    return (
      <Box flexDirection="column">
        <Text dimColor>Testing {providerId ?? 'active provider'}…</Text>
      </Box>
    );
  }
  if (state.kind === 'error') {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ Could not reach server at {serverUrl}</Text>
        <Text dimColor>{state.message}</Text>
        <Text dimColor>(is `regard` server running?)</Text>
        <Exit exit={exit} interactive={interactive} />
      </Box>
    );
  }
  const r = state.result;
  if (r.ok) {
    return (
      <Box flexDirection="column">
        <Text color="green">✓ {r.providerId} responded in {r.latencyMs}ms</Text>
        {r.model && <Text dimColor>model: {r.model}</Text>}
        <Exit exit={exit} interactive={interactive} />
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text color="red">✗ {r.error.code}: {r.error.message}</Text>
      {r.error.hint && <Text dimColor>hint: {r.error.hint}</Text>}
      {r.providerId && <Text dimColor>provider: {r.providerId}</Text>}
      <Exit exit={exit} interactive={interactive} />
    </Box>
  );
}
