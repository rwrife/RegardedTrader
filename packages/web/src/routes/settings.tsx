import React, { useEffect, useMemo, useState } from 'react';
import type { AiProvider, AppConfig, MarketDataProviderConfig } from '@regardedtrader/core';
import {
  CLI_BACKENDS,
  HTTP_PRESETS,
  MARKET_PROVIDER_PRESETS,
  createApi,
  maskApiKey,
  type ApiClient,
  type HttpPreset,
  type MarketProviderPreset,
} from '../api.js';

const DISCLAIMER =
  'Not financial advice. AI-generated analysis based on public data. Verify everything before trading.';

interface SettingsProps {
  /** Inject a fake API client in tests. */
  api?: ApiClient;
  /** Callback for the "back to dashboard" link. */
  onClose?: () => void;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'info'; message: string };

type TestState = Record<string, { ok: boolean; message: string } | undefined>;

export function Settings(props: SettingsProps): JSX.Element {
  const api = useMemo(() => props.api ?? createApi(), [props.api]);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [addOpen, setAddOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<TestState>({});

  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((c) => {
        if (cancelled) return;
        setConfig(c);
        setStatus({ kind: 'idle' });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const refresh = (next: AppConfig): void => {
    setConfig(next);
    setStatus({ kind: 'idle' });
  };

  const onActivate = async (id: string): Promise<void> => {
    try {
      const r = await api.activateProvider(id);
      refresh(r.config);
      setStatus({ kind: 'info', message: `Activated "${id}"` });
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const onDelete = async (id: string): Promise<void> => {
    try {
      const r = await api.removeProvider(id);
      refresh(r.config);
      setConfirmDelete(null);
      setStatus({ kind: 'info', message: `Removed "${id}"` });
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const onTest = async (id: string): Promise<void> => {
    setTestResults((prev) => ({ ...prev, [id]: undefined }));
    if (!config || config.activeProvider !== id) {
      // /config/test is wired to the active provider. Activate first so the
      // test reflects the row the user clicked.
      try {
        const r = await api.activateProvider(id);
        refresh(r.config);
      } catch (e) {
        setTestResults((prev) => ({
          ...prev,
          [id]: { ok: false, message: e instanceof Error ? e.message : String(e) },
        }));
        return;
      }
    }
    const r = await api.testActive();
    setTestResults((prev) => ({
      ...prev,
      [id]: {
        ok: !!r.ok,
        message: r.ok ? r.sample?.trim() || 'OK' : r.error || 'Test failed',
      },
    }));
  };

  const onAdd = async (id: string, provider: AiProvider): Promise<void> => {
    try {
      const r = await api.upsertProvider(id, provider);
      refresh(r.config);
      setAddOpen(false);
      setStatus({ kind: 'info', message: `Saved "${id}"` });
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="min-h-screen bg-app text-fg">
      <header className="border-b border-border-subtle bg-surface">
        <div className="max-w-5xl mx-auto px-6 h-12 flex items-center gap-4 text-xs">
          <button
            onClick={props.onClose}
            aria-label="Back to dashboard"
            className="font-semibold tracking-tight hover:text-ai"
          >
            ← RegardedTrader
          </button>
          <span className="text-fg-muted">·</span>
          <span className="num text-fg-secondary">Settings</span>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-6 space-y-4">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">AI Providers</h1>
            <p className="text-xs text-fg-muted mt-1">
              Local only. Keys are stored on this machine and never sent off-host.
            </p>
          </div>
          <button
            onClick={() => setAddOpen(true)}
            className="px-3 py-1.5 text-xs rounded border border-border-subtle bg-surface-2 hover:border-ai"
          >
            + Add provider
          </button>
        </div>

        {status.kind === 'loading' && (
          <div className="text-fg-muted text-sm">Loading config…</div>
        )}
        {status.kind === 'error' && (
          <div
            role="alert"
            className="border border-down rounded p-3 text-sm bg-down/10 text-down"
          >
            {status.message}
          </div>
        )}
        {status.kind === 'info' && (
          <div className="border border-border-subtle rounded p-2 text-xs text-fg-secondary bg-surface">
            {status.message}
          </div>
        )}

        {config && (
          <ProviderTable
            config={config}
            testResults={testResults}
            confirmDelete={confirmDelete}
            onActivate={onActivate}
            onTest={onTest}
            onRequestDelete={setConfirmDelete}
            onConfirmDelete={onDelete}
          />
        )}

        {addOpen && <AddProviderModal onSave={onAdd} onCancel={() => setAddOpen(false)} />}

        {config && <MarketDataSection api={api} config={config} onConfigChange={refresh} />}

        <p className="pt-4 text-[10px] text-fg-muted">{DISCLAIMER}</p>
      </div>
    </div>
  );
}

interface ProviderRowProps {
  id: string;
  provider: AiProvider;
  active: boolean;
  test: { ok: boolean; message: string } | undefined;
  pendingDelete: boolean;
  onActivate: () => void;
  onTest: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

function ProviderRow(p: ProviderRowProps): JSX.Element {
  const kind = p.provider.kind === 'openai-compatible' ? 'HTTP' : 'CLI';
  const model =
    p.provider.kind === 'openai-compatible'
      ? p.provider.model
      : p.provider.model || '—';
  const detail =
    p.provider.kind === 'openai-compatible'
      ? p.provider.baseUrl
      : `${p.provider.backend} (${p.provider.command || 'default cmd'})`;
  const key =
    p.provider.kind === 'openai-compatible' ? maskApiKey(p.provider.apiKey) || '—' : 'n/a';

  return (
    <tr className="border-t border-border-subtle align-top">
      <td className="px-3 py-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            name="activeProvider"
            checked={p.active}
            onChange={p.onActivate}
            aria-label={`Activate ${p.id}`}
          />
          <span className="font-mono text-xs">{p.id}</span>
        </label>
      </td>
      <td className="px-3 py-2 text-xs">{p.provider.label}</td>
      <td className="px-3 py-2 text-xs text-fg-muted">{kind}</td>
      <td className="px-3 py-2 text-xs font-mono">{model}</td>
      <td className="px-3 py-2 text-xs text-fg-muted font-mono break-all">{detail}</td>
      <td className="px-3 py-2 text-xs font-mono">{key}</td>
      <td className="px-3 py-2 text-right text-xs whitespace-nowrap space-x-2">
        <button
          onClick={p.onTest}
          className="px-2 py-1 rounded border border-border-subtle hover:border-ai"
        >
          Test
        </button>
        {p.pendingDelete ? (
          <span className="space-x-1">
            <span className="text-fg-muted">delete?</span>
            <button
              onClick={p.onConfirmDelete}
              className="px-2 py-1 rounded border border-down text-down hover:bg-down/10"
            >
              Yes
            </button>
            <button
              onClick={p.onCancelDelete}
              className="px-2 py-1 rounded border border-border-subtle"
            >
              No
            </button>
          </span>
        ) : (
          <button
            onClick={p.onRequestDelete}
            className="px-2 py-1 rounded border border-border-subtle hover:border-down hover:text-down"
            aria-label={`Remove ${p.id}`}
          >
            Remove
          </button>
        )}
        {p.test && (
          <div className={`mt-1 text-[10px] ${p.test.ok ? 'text-up' : 'text-down'}`}>
            {p.test.ok ? '✓' : '✗'} {p.test.message}
          </div>
        )}
      </td>
    </tr>
  );
}

function ProviderTable({
  config,
  testResults,
  confirmDelete,
  onActivate,
  onTest,
  onRequestDelete,
  onConfirmDelete,
}: {
  config: AppConfig;
  testResults: TestState;
  confirmDelete: string | null;
  onActivate: (id: string) => void;
  onTest: (id: string) => void;
  onRequestDelete: (id: string | null) => void;
  onConfirmDelete: (id: string) => void;
}): JSX.Element {
  const ids = Object.keys(config.providers).sort();
  if (ids.length === 0) {
    return (
      <div className="border border-border-subtle rounded p-6 text-center text-sm text-fg-muted bg-surface">
        No providers configured yet. Add one to get started.
      </div>
    );
  }
  return (
    <div className="border border-border-subtle rounded bg-surface overflow-hidden">
      <table className="w-full text-left">
        <thead className="bg-surface-2 text-[10px] font-mono tracking-wider text-fg-muted uppercase">
          <tr>
            <th className="px-3 py-2">Active</th>
            <th className="px-3 py-2">Label</th>
            <th className="px-3 py-2">Kind</th>
            <th className="px-3 py-2">Model</th>
            <th className="px-3 py-2">Endpoint / Command</th>
            <th className="px-3 py-2">Key</th>
            <th className="px-3 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {ids.map((id) => (
            <ProviderRow
              key={id}
              id={id}
              provider={config.providers[id]!}
              active={config.activeProvider === id}
              test={testResults[id]}
              pendingDelete={confirmDelete === id}
              onActivate={() => onActivate(id)}
              onTest={() => onTest(id)}
              onRequestDelete={() => onRequestDelete(id)}
              onConfirmDelete={() => onConfirmDelete(id)}
              onCancelDelete={() => onRequestDelete(null)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Add provider modal ----------------------------------------------------

interface AddProviderModalProps {
  onSave: (id: string, provider: AiProvider) => Promise<void>;
  onCancel: () => void;
}

function AddProviderModal({ onSave, onCancel }: AddProviderModalProps): JSX.Element {
  const [flow, setFlow] = useState<'http' | 'cli'>('http');
  return (
    <div
      role="dialog"
      aria-label="Add AI provider"
      className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50"
    >
      <div className="bg-surface border border-border-subtle rounded w-full max-w-lg">
        <div className="px-4 py-3 border-b border-border-subtle flex items-center gap-3">
          <h2 className="text-sm font-semibold">Add provider</h2>
          <div className="ml-auto text-xs space-x-2">
            <button
              onClick={() => setFlow('http')}
              className={`px-2 py-1 rounded border ${
                flow === 'http' ? 'border-ai text-ai' : 'border-border-subtle text-fg-muted'
              }`}
            >
              OpenAI-compatible
            </button>
            <button
              onClick={() => setFlow('cli')}
              className={`px-2 py-1 rounded border ${
                flow === 'cli' ? 'border-ai text-ai' : 'border-border-subtle text-fg-muted'
              }`}
            >
              CLI backend
            </button>
          </div>
        </div>
        <div className="p-4">
          {flow === 'http' ? (
            <HttpForm onSave={onSave} onCancel={onCancel} />
          ) : (
            <CliForm onSave={onSave} onCancel={onCancel} />
          )}
        </div>
      </div>
    </div>
  );
}

function HttpForm({
  onSave,
  onCancel,
}: {
  onSave: (id: string, p: AiProvider) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [presetId, setPresetId] = useState<string>(HTTP_PRESETS[0]!.id);
  const preset: HttpPreset = useMemo(
    () => HTTP_PRESETS.find((p) => p.id === presetId) ?? HTTP_PRESETS[0]!,
    [presetId],
  );
  const [id, setId] = useState(preset.id);
  const [label, setLabel] = useState(preset.label);
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl);
  const [model, setModel] = useState(preset.model);
  const [apiKey, setApiKey] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setId(preset.id);
    setLabel(preset.label);
    setBaseUrl(preset.baseUrl);
    setModel(preset.model);
  }, [preset]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErr(null);
    if (!id.trim()) return setErr('Provider id is required');
    if (!label.trim()) return setErr('Label is required');
    if (!baseUrl.trim()) return setErr('Base URL is required');
    if (!model.trim()) return setErr('Model is required');
    const provider: AiProvider = {
      kind: 'openai-compatible',
      label: label.trim(),
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    };
    try {
      setSaving(true);
      await onSave(id.trim(), provider);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 text-xs">
      <Field label="Preset">
        <select
          value={presetId}
          onChange={(e) => setPresetId(e.target.value)}
          className="bg-surface-2 border border-border-subtle rounded px-2 py-1 w-full"
        >
          {HTTP_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Provider id">
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          className="bg-surface-2 border border-border-subtle rounded px-2 py-1 w-full font-mono"
        />
      </Field>
      <Field label="Label">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="bg-surface-2 border border-border-subtle rounded px-2 py-1 w-full"
        />
      </Field>
      <Field label="Base URL">
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.openai.com/v1"
          className="bg-surface-2 border border-border-subtle rounded px-2 py-1 w-full font-mono"
        />
      </Field>
      <Field label="Model">
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="bg-surface-2 border border-border-subtle rounded px-2 py-1 w-full font-mono"
        />
      </Field>
      <Field label={`API key${preset.needsKey ? '' : ' (optional)'}`}>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={preset.needsKey ? 'required' : 'leave blank for local servers'}
          className="bg-surface-2 border border-border-subtle rounded px-2 py-1 w-full font-mono"
        />
      </Field>
      <FormFooter err={err} saving={saving} onCancel={onCancel} />
    </form>
  );
}

function CliForm({
  onSave,
  onCancel,
}: {
  onSave: (id: string, p: AiProvider) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [backend, setBackend] = useState(CLI_BACKENDS[0]!.id);
  const backendPreset = useMemo(
    () => CLI_BACKENDS.find((b) => b.id === backend) ?? CLI_BACKENDS[0]!,
    [backend],
  );
  const [id, setId] = useState<string>(backendPreset.id);
  const [label, setLabel] = useState(backendPreset.label);
  const [command, setCommand] = useState(backendPreset.defaultCommand);
  const [model, setModel] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setId(backendPreset.id);
    setLabel(backendPreset.label);
    setCommand(backendPreset.defaultCommand);
  }, [backendPreset]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErr(null);
    if (!id.trim()) return setErr('Provider id is required');
    if (!label.trim()) return setErr('Label is required');
    const provider: AiProvider = {
      kind: 'cli',
      label: label.trim(),
      backend: backendPreset.id,
      ...(command.trim() ? { command: command.trim() } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
    };
    try {
      setSaving(true);
      await onSave(id.trim(), provider);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 text-xs">
      <Field label="Backend">
        <select
          value={backend}
          onChange={(e) => setBackend(e.target.value as typeof backend)}
          className="bg-surface-2 border border-border-subtle rounded px-2 py-1 w-full"
        >
          {CLI_BACKENDS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Provider id">
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          className="bg-surface-2 border border-border-subtle rounded px-2 py-1 w-full font-mono"
        />
      </Field>
      <Field label="Label">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="bg-surface-2 border border-border-subtle rounded px-2 py-1 w-full"
        />
      </Field>
      <Field label="Command (binary path)">
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          className="bg-surface-2 border border-border-subtle rounded px-2 py-1 w-full font-mono"
        />
      </Field>
      <Field label="Model (optional)">
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="bg-surface-2 border border-border-subtle rounded px-2 py-1 w-full font-mono"
        />
      </Field>
      <FormFooter err={err} saving={saving} onCancel={onCancel} />
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="block text-[10px] font-mono tracking-wider text-fg-muted uppercase mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}

function FormFooter({
  err,
  saving,
  onCancel,
}: {
  err: string | null;
  saving: boolean;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div className="space-y-2 pt-2">
      {err && (
        <div role="alert" className="text-down text-xs">
          {err}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 rounded border border-border-subtle text-fg-muted hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="px-3 py-1.5 rounded border border-ai text-ai hover:bg-ai/10 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Market Data (#91)
// -----------------------------------------------------------------------------

interface MarketDataSectionProps {
  api: ApiClient;
  config: AppConfig;
  onConfigChange: (next: AppConfig) => void;
}

function MarketDataSection({ api, config, onConfigChange }: MarketDataSectionProps): JSX.Element {
  const [addOpen, setAddOpen] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const md = config.marketData;
  const active = md.activeProvider;
  const providers = Object.entries(md.providers);

  const handleActivate = async (id: string | null): Promise<void> => {
    try {
      const r = await api.activateMarketProvider(id);
      onConfigChange(r.config);
      setStatus({ kind: 'info', message: id ? `Activated "${id}"` : 'Cleared active provider' });
      setTestResult(null);
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleDelete = async (id: string): Promise<void> => {
    if (!confirm(`Remove market-data provider "${id}"?`)) return;
    try {
      const r = await api.removeMarketProvider(id);
      onConfigChange(r.config);
      setStatus({ kind: 'info', message: `Removed "${id}"` });
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleAdd = async (id: string, provider: MarketDataProviderConfig): Promise<void> => {
    try {
      const r = await api.upsertMarketProvider(id, provider);
      onConfigChange(r.config);
      setAddOpen(false);
      setStatus({ kind: 'info', message: `Saved "${id}"` });
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleTest = async (): Promise<void> => {
    setTestResult(null);
    setStatus({ kind: 'loading' });
    const r = await api.testMarketProvider();
    setStatus({ kind: 'idle' });
    setTestResult({
      ok: !!r.ok,
      message: r.ok
        ? `OK — ${r.symbol} @ ${typeof r.price === 'number' ? r.price.toFixed(2) : '—'}`
        : r.error ?? 'Test failed',
    });
  };

  return (
    <div className="pt-6 mt-6 border-t border-border-subtle space-y-3">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Market Data</h2>
          <p className="text-xs text-fg-muted mt-1">
            Source for live quotes, history, options chains, and news. All data flows through the
            active provider — there is no silent fallback to another vendor.
          </p>
        </div>
        <button
          onClick={() => setAddOpen(true)}
          className="px-3 py-1.5 text-xs rounded border border-border-subtle bg-surface-2 hover:border-ai"
        >
          + Add provider
        </button>
      </div>

      {status.kind === 'error' && (
        <div role="alert" className="border border-down rounded p-2 text-xs bg-down/10 text-down">
          {status.message}
        </div>
      )}
      {status.kind === 'info' && (
        <div className="border border-border-subtle rounded p-2 text-xs text-fg-secondary bg-surface">
          {status.message}
        </div>
      )}

      {providers.length === 0 ? (
        <div className="border border-dashed border-border-subtle rounded p-4 text-sm text-fg-muted">
          No market-data provider configured. Live quotes will use the built-in Yahoo source, which
          is unreliable. Add a Finnhub key for stable real-time quotes.
        </div>
      ) : (
        <table className="w-full text-sm border border-border-subtle rounded overflow-hidden">
          <thead className="bg-surface-2 text-xs text-fg-muted">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Active</th>
              <th className="text-left px-3 py-2 font-medium">ID</th>
              <th className="text-left px-3 py-2 font-medium">Kind</th>
              <th className="text-left px-3 py-2 font-medium">Key</th>
              <th className="text-right px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {providers.map(([id, p]) => (
              <tr key={id} className="border-t border-border-subtle align-top">
                <td className="px-3 py-2">
                  <input
                    type="radio"
                    name="activeMarketProvider"
                    checked={active === id}
                    onChange={() => void handleActivate(id)}
                    aria-label={`Activate ${id}`}
                  />
                </td>
                <td className="px-3 py-2 font-mono text-xs">{id}</td>
                <td className="px-3 py-2 text-xs">{p.label} <span className="text-fg-muted">({p.kind})</span></td>
                <td className="px-3 py-2 text-xs font-mono">
                  {p.kind === 'finnhub' ? maskApiKey(p.apiKey) || '—' : 'n/a'}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => void handleDelete(id)}
                    className="text-xs text-fg-muted hover:text-down"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {active && (
        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={() => void handleTest()}
            className="px-3 py-1.5 text-xs rounded border border-border-subtle bg-surface-2 hover:border-ai"
          >
            Test active provider
          </button>
          {testResult && (
            <span
              role="status"
              className={`text-xs ${testResult.ok ? 'text-up' : 'text-down'}`}
            >
              {testResult.message}
            </span>
          )}
        </div>
      )}

      {addOpen && (
        <AddMarketProviderModal
          onSave={handleAdd}
          onCancel={() => setAddOpen(false)}
          existingIds={new Set(providers.map(([id]) => id))}
        />
      )}
    </div>
  );
}

interface AddMarketProviderModalProps {
  onSave: (id: string, provider: MarketDataProviderConfig) => Promise<void>;
  onCancel: () => void;
  existingIds: Set<string>;
}

function AddMarketProviderModal({
  onSave,
  onCancel,
  existingIds,
}: AddMarketProviderModalProps): JSX.Element {
  // First preset is statically guaranteed to exist (the constant is non-empty),
  // but the strict-indexed-access lint can't see that — narrow once.
  const FIRST = MARKET_PROVIDER_PRESETS[0] as MarketProviderPreset;
  const [preset, setPreset] = useState<MarketProviderPreset>(FIRST);
  const [id, setId] = useState<string>(FIRST.kind);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (!id) {
      setError('ID is required');
      return;
    }
    if (existingIds.has(id)) {
      setError(`A provider with id "${id}" already exists`);
      return;
    }
    let provider: MarketDataProviderConfig;
    if (preset.kind === 'finnhub') {
      if (!apiKey.trim()) {
        setError('Finnhub requires an API key');
        return;
      }
      provider = {
        kind: 'finnhub',
        label: preset.label,
        apiKey: apiKey.trim(),
        baseUrl: 'https://finnhub.io/api/v1',
      };
    } else {
      provider = { kind: 'yahoo', label: preset.label };
    }
    setSaving(true);
    try {
      await onSave(id, provider);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form
        onSubmit={onSubmit}
        className="bg-surface border border-border-subtle rounded p-4 max-w-md w-full space-y-3"
        aria-label="Add market-data provider"
      >
        <h3 className="text-base font-semibold">Add market-data provider</h3>

        <label className="block text-xs">
          <span className="text-fg-muted">Provider</span>
          <select
            value={preset.kind}
            onChange={(e) => {
              const found = MARKET_PROVIDER_PRESETS.find((p) => p.kind === e.target.value);
              const next: MarketProviderPreset = found ?? FIRST;
              setPreset(next);
              setId(next.kind);
            }}
            className="mt-1 w-full bg-surface-2 border border-border-subtle rounded px-2 py-1.5 text-sm"
          >
            {MARKET_PROVIDER_PRESETS.map((p) => (
              <option key={p.kind} value={p.kind}>
                {p.label}
              </option>
            ))}
          </select>
          <span className="block text-fg-muted mt-1">{preset.description}</span>
          {preset.signupUrl && (
            <a
              href={preset.signupUrl}
              target="_blank"
              rel="noreferrer"
              className="block text-ai underline mt-0.5"
            >
              Get a free API key →
            </a>
          )}
        </label>

        <label className="block text-xs">
          <span className="text-fg-muted">ID</span>
          <input
            value={id}
            onChange={(e) => setId(e.target.value.trim())}
            className="mt-1 w-full bg-surface-2 border border-border-subtle rounded px-2 py-1.5 text-sm font-mono"
            placeholder="finnhub"
          />
        </label>

        {preset.needsKey && (
          <label className="block text-xs">
            <span className="text-fg-muted">API key</span>
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
              autoComplete="off"
              className="mt-1 w-full bg-surface-2 border border-border-subtle rounded px-2 py-1.5 text-sm font-mono"
              placeholder="…"
            />
          </label>
        )}

        {error && (
          <div role="alert" className="text-xs text-down border border-down/40 rounded p-2 bg-down/10">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded border border-border-subtle hover:border-ai"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-3 py-1.5 text-xs rounded border border-ai text-ai hover:bg-ai/10 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
