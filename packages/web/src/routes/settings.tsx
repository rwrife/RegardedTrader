import React, { useEffect, useMemo, useState } from 'react';
import type { AiProvider, AppConfig } from '@regardedtrader/core';
import {
  CLI_BACKENDS,
  HTTP_PRESETS,
  createApi,
  maskApiKey,
  type ApiClient,
  type HttpPreset,
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
