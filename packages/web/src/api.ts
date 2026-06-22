/**
 * Thin HTTP client around the local server's /config surface.
 *
 * The web bundle talks to the server via Vite's `/api` proxy in dev, and
 * directly when the server serves the production bundle. All endpoints used
 * here return Zod-validated payloads (validated server-side); we re-derive the
 * types from the shared `@regardedtrader/core` schemas so the wire format
 * stays in lockstep with the server.
 */
import type {
  AppConfig,
  AiProvider,
  ConfigTestResult,
  MarketDataProviderConfig,
  RiskConfig,
} from '@regardedtrader/core';

export type { AppConfig, AiProvider, ConfigTestResult, MarketDataProviderConfig, RiskConfig };

export interface ConfigResponse {
  ok: boolean;
  aiConfigured: boolean;
  config: AppConfig;
}

/**
 * `POST /config/test` response. This is the same Zod-validated
 * `ConfigTestResult` discriminated union the server emits — always 200, with
 * success/failure carried in `ok`.
 */
export type TestResponse = ConfigTestResult;

export interface MarketDataConfigResponse {
  ok: boolean;
  activeMarketProvider: string | null;
  config: AppConfig;
}

export interface MarketDataTestResponse {
  ok: boolean;
  provider?: string | null;
  symbol?: string;
  price?: number | null;
  error?: string;
}

export interface ApiClient {
  getConfig(): Promise<AppConfig>;
  upsertProvider(id: string, provider: AiProvider): Promise<ConfigResponse>;
  removeProvider(id: string): Promise<ConfigResponse>;
  activateProvider(id: string): Promise<ConfigResponse>;
  testActive(providerId?: string): Promise<TestResponse>;
  upsertMarketProvider(id: string, provider: MarketDataProviderConfig): Promise<MarketDataConfigResponse>;
  removeMarketProvider(id: string): Promise<MarketDataConfigResponse>;
  activateMarketProvider(id: string | null): Promise<MarketDataConfigResponse>;
  testMarketProvider(symbol?: string): Promise<MarketDataTestResponse>;
  /** Update risk caps (#152). Hot-applies to the in-process Orchestrator. */
  updateRiskCaps(risk: RiskConfig): Promise<ConfigResponse>;
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
    async testActive(providerId?: string) {
      const res = await f(
        url('/config/test'),
        json(providerId ? { providerId } : {}),
      );
      // /config/test always returns 200 with a `ConfigTestResult` body —
      // success/failure is carried in `ok`. We still defend against malformed
      // responses so the caller can surface a useful error.
      const text = await res.text();
      try {
        if (!text) {
          return {
            ok: false,
            error: { code: 'provider_error', message: 'empty response' },
          } satisfies TestResponse;
        }
        return JSON.parse(text) as TestResponse;
      } catch {
        return {
          ok: false,
          error: { code: 'provider_error', message: `Invalid JSON from ${res.url}` },
        } satisfies TestResponse;
      }
    },
    async upsertMarketProvider(id, provider) {
      const res = await f(url('/config/market-data/providers'), json({ id, provider }));
      return readJson<MarketDataConfigResponse>(res);
    },
    async removeMarketProvider(id) {
      const res = await f(url(`/config/market-data/providers/${encodeURIComponent(id)}`), {
        method: 'DELETE',
      });
      return readJson<MarketDataConfigResponse>(res);
    },
    async activateMarketProvider(id) {
      const res = await f(url('/config/market-data/activate'), json({ id }));
      return readJson<MarketDataConfigResponse>(res);
    },
    async testMarketProvider(symbol) {
      const res = await f(
        url('/config/market-data/test'),
        json(symbol ? { symbol } : {}),
      );
      const text = await res.text();
      try {
        return text
          ? (JSON.parse(text) as MarketDataTestResponse)
          : { ok: false, error: 'empty response' };
      } catch {
        return { ok: false, error: `Invalid JSON from ${res.url}` };
      }
    },
    async updateRiskCaps(risk) {
      const res = await f(url('/config/risk'), json(risk));
      return readJson<ConfigResponse>(res);
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
  { id: 'copilot-cli', label: 'GitHub Copilot CLI', defaultCommand: 'copilot' },
];

/**
 * Known market-data provider presets, surfaced in the Settings UI.
 * Mirrors the discriminated union in `@regardedtrader/core`.
 */
export interface MarketProviderPreset {
  kind: MarketDataProviderConfig['kind'];
  label: string;
  needsKey: boolean;
  signupUrl?: string;
  description: string;
}

export const MARKET_PROVIDER_PRESETS: ReadonlyArray<MarketProviderPreset> = [
  {
    kind: 'finnhub',
    label: 'Finnhub',
    needsKey: true,
    signupUrl: 'https://finnhub.io/register',
    description: 'Real-time US equities. Free tier: 60 calls/min, no daily cap. Recommended.',
  },
  {
    kind: 'yahoo',
    label: 'Yahoo Finance (unofficial)',
    needsKey: false,
    description: 'Scrape-based. No key needed, but frequently rate-limited (HTTP 429).',
  },
];
