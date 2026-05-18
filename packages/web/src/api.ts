/**
 * Thin HTTP client around the local server's /config surface.
 *
 * The web bundle talks to the server via Vite's `/api` proxy in dev, and
 * directly when the server serves the production bundle. All endpoints used
 * here return Zod-validated payloads (validated server-side); we re-derive the
 * types from the shared `@regardedtrader/core` schemas so the wire format
 * stays in lockstep with the server.
 */
import type { AppConfig, AiProvider } from '@regardedtrader/core';

export type { AppConfig, AiProvider };

export interface ConfigResponse {
  ok: boolean;
  aiConfigured: boolean;
  config: AppConfig;
}

export interface TestResponse {
  ok: boolean;
  sample?: string;
  error?: string;
}

export interface ApiClient {
  getConfig(): Promise<AppConfig>;
  upsertProvider(id: string, provider: AiProvider): Promise<ConfigResponse>;
  removeProvider(id: string): Promise<ConfigResponse>;
  activateProvider(id: string): Promise<ConfigResponse>;
  testActive(): Promise<TestResponse>;
}

export interface ApiOptions {
  /** Override base path; defaults to `/api` (Vite proxy / server prefix). */
  base?: string;
  /** Fetch impl override (tests). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = '/api';

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON from ${res.url} (status ${res.status})`);
    }
  }
  if (!res.ok) {
    const message =
      parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return parsed as T;
}

export function createApi(opts: ApiOptions = {}): ApiClient {
  const base = opts.base ?? DEFAULT_BASE;
  const f = opts.fetchImpl ?? fetch;
  const url = (p: string): string => `${base}${p}`;
  const json = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return {
    async getConfig() {
      const res = await f(url('/config'));
      return readJson<AppConfig>(res);
    },
    async upsertProvider(id, provider) {
      const res = await f(url('/config/providers'), json({ id, provider }));
      return readJson<ConfigResponse>(res);
    },
    async removeProvider(id) {
      const res = await f(url(`/config/providers/${encodeURIComponent(id)}`), {
        method: 'DELETE',
      });
      return readJson<ConfigResponse>(res);
    },
    async activateProvider(id) {
      const res = await f(url('/config/activate'), json({ id }));
      return readJson<ConfigResponse>(res);
    },
    async testActive() {
      const res = await f(url('/config/test'), { method: 'POST' });
      // /config/test returns 503/500 with `ok:false` on failure rather than
      // throwing — surface the structured payload to the caller.
      const text = await res.text();
      try {
        return text ? (JSON.parse(text) as TestResponse) : { ok: false, error: 'empty response' };
      } catch {
        return { ok: false, error: `Invalid JSON from ${res.url}` };
      }
    },
  };
}

/** Mask key for display. Mirrors the server-side redactor for in-browser inputs. */
export function maskApiKey(k: string | undefined): string {
  if (!k) return '';
  if (k.length <= 8) return '••••';
  return `${k.slice(0, 4)}••••${k.slice(-4)}`;
}

/**
 * Known OpenAI-compatible presets, mirrored from the CLI's `regard config`
 * flow so both surfaces stay in step (surface-parity rule).
 */
export interface HttpPreset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  needsKey: boolean;
}

export const HTTP_PRESETS: ReadonlyArray<HttpPreset> = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true,
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.1-70b-versatile',
    needsKey: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
    needsKey: true,
  },
  {
    id: 'ollama',
    label: 'Local Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.1:latest',
    needsKey: false,
  },
  { id: 'custom', label: 'Custom', baseUrl: '', model: '', needsKey: false },
];

export interface CliBackendPreset {
  id: 'codex-cli' | 'claude-cli' | 'copilot-cli';
  label: string;
  defaultCommand: string;
}

export const CLI_BACKENDS: ReadonlyArray<CliBackendPreset> = [
  { id: 'codex-cli', label: 'Codex CLI', defaultCommand: 'codex' },
  { id: 'claude-cli', label: 'Claude CLI', defaultCommand: 'claude' },
  { id: 'copilot-cli', label: 'GitHub Copilot CLI', defaultCommand: 'gh' },
];
