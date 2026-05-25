import { z } from 'zod';
import { MarketDataConfig } from './marketData.js';
export * from './marketData.js';

/** OpenAI-compatible HTTP endpoint (OpenAI, Azure OpenAI, OpenRouter, Groq, Together, local Ollama, vLLM, etc.) */
export const OpenAICompatibleProvider = z.object({
  kind: z.literal('openai-compatible'),
  /** Display name e.g. "OpenAI", "Groq", "Local Ollama" */
  label: z.string().min(1),
  /** Base URL, e.g. https://api.openai.com/v1 or http://127.0.0.1:11434/v1 */
  baseUrl: z.string().url(),
  /** API key. Stored locally; never logged. Optional for keyless local servers. */
  apiKey: z.string().optional(),
  /** Default model id sent to the endpoint */
  model: z.string().min(1),
  /** Optional headers (e.g. azure-api-version) */
  headers: z.record(z.string()).optional(),
});
export type OpenAICompatibleProvider = z.infer<typeof OpenAICompatibleProvider>;

/** Local AI CLI backends (codex, claude, copilot). RegardedTrader spawns the CLI per turn. */
export const CliBackendKind = z.enum(['codex-cli', 'claude-cli', 'copilot-cli']);
export type CliBackendKind = z.infer<typeof CliBackendKind>;

export const CliProvider = z.object({
  kind: z.literal('cli'),
  label: z.string().min(1),
  backend: CliBackendKind,
  /** Binary path / command. Defaults: `codex`, `claude`, `gh` */
  command: z.string().optional(),
  /** Extra args appended after the backend's defaults */
  args: z.array(z.string()).optional(),
  /** Model id passed via the backend's --model flag */
  model: z.string().optional(),
  /** Override env vars when spawning */
  env: z.record(z.string()).optional(),
});
export type CliProvider = z.infer<typeof CliProvider>;

export const AiProvider = z.discriminatedUnion('kind', [OpenAICompatibleProvider, CliProvider]);
export type AiProvider = z.infer<typeof AiProvider>;

export const AppConfig = z.object({
  /** Schema version for safe migrations */
  version: z.literal(1).default(1),
  /** Map of provider id (user-chosen, e.g. "openai", "local-ollama", "codex") -> config */
  providers: z.record(AiProvider).default({}),
  /** Which provider id is active for AI calls */
  activeProvider: z.string().nullable().default(null),
  /** Risk caps applied by RiskOfficer */
  risk: z
    .object({
      maxLossUsd: z.number().positive().default(500),
      maxLegs: z.number().int().positive().default(4),
      forbidNakedShorts: z.boolean().default(true),
    })
    .default({ maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true }),
  /** Local server bind. Validated to localhost only. */
  server: z
    .object({
      host: z.enum(['127.0.0.1', 'localhost']).default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(4317),
    })
    .default({ host: '127.0.0.1', port: 4317 }),
  /** Pluggable market-data provider config (#91). */
  marketData: MarketDataConfig,
});
export type AppConfig = z.infer<typeof AppConfig>;

export const DEFAULT_CONFIG: AppConfig = AppConfig.parse({});

/**
 * Structured outcome of `POST /config/test` — the provider "smoke test"
 * required by AGENTS.md. Sends one tiny prompt to the named provider (or the
 * active one if omitted) and reports success/failure with enough context to
 * be actionable. Never includes the API key.
 */
export const ConfigTestErrorCode = z.enum([
  /** No provider id was supplied and no provider is currently active. */
  'no_provider',
  /** A providerId was supplied but it doesn't exist in the config. */
  'unknown_provider',
  /** The LLM call exceeded the smoke-test timeout. */
  'timeout',
  /** The provider returned an empty response — likely a model/permission issue. */
  'empty_response',
  /** Provider call failed (network, auth, rate-limit, etc.). */
  'provider_error',
]);
export type ConfigTestErrorCode = z.infer<typeof ConfigTestErrorCode>;

export const ConfigTestError = z.object({
  code: ConfigTestErrorCode,
  message: z.string(),
  /** Short, user-actionable hint (e.g. "Check your API key in Settings"). */
  hint: z.string().optional(),
});
export type ConfigTestError = z.infer<typeof ConfigTestError>;

export const ConfigTestResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** Wall-clock latency of the LLM call in milliseconds. */
    latencyMs: z.number().int().nonnegative(),
    /** The model id that was actually probed. May be undefined for CLI backends with no `--model` flag. */
    model: z.string().optional(),
    /** The provider id that was tested (the request's providerId, or the active one when omitted). */
    providerId: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    error: ConfigTestError,
    /** Provider id that we tried to test, when known. */
    providerId: z.string().optional(),
  }),
]);
export type ConfigTestResult = z.infer<typeof ConfigTestResult>;

/** Sanitized view safe to render or send over the wire (no api keys). */
export function redactConfig(cfg: AppConfig): AppConfig {
  const providers: Record<string, AiProvider> = {};
  for (const [id, p] of Object.entries(cfg.providers)) {
    if (p.kind === 'openai-compatible' && p.apiKey) {
      providers[id] = { ...p, apiKey: maskKey(p.apiKey) };
    } else {
      providers[id] = p;
    }
  }
  const md = cfg.marketData;
  const mdProviders: Record<string, MarketDataConfig['providers'][string]> = {};
  for (const [id, p] of Object.entries(md.providers)) {
    if (p.kind === 'finnhub' && p.apiKey) {
      mdProviders[id] = { ...p, apiKey: maskKey(p.apiKey) };
    } else {
      mdProviders[id] = p;
    }
  }
  return { ...cfg, providers, marketData: { ...md, providers: mdProviders } };
}

function maskKey(k: string): string {
  if (k.length <= 8) return '••••';
  return `${k.slice(0, 4)}••••${k.slice(-4)}`;
}
