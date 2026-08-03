import OpenAI from 'openai';
import type { LLM } from '../agents/llm.js';
import { OpenAILLM } from '../agents/llm.js';
import type { AiProvider, AppConfig, CliBackendKind } from '../schemas/config.js';
import { CliBackendRunner } from './cli/runner.js';

/**
 * Build an LLM from a provider config.
 * Throws a helpful error if the provider is misconfigured.
 */
export function buildLLM(provider: AiProvider): LLM {
  if (provider.kind === 'openai-compatible') {
    const client = new OpenAI({
      apiKey: provider.apiKey ?? 'no-key-required',
      baseURL: provider.baseUrl,
      defaultHeaders: provider.headers,
    });
    return new OpenAILLM(client, provider.model);
  }
  return new CliLLM(provider.backend, provider.command, provider.args, provider.model, provider.env);
}

/** Resolve the active provider from config, or throw. */
export function activeLLM(cfg: AppConfig): LLM {
  if (!cfg.activeProvider) {
    throw new Error(
      'No active AI provider configured. Run `regard config` (CLI) or open Settings in the dashboard.',
    );
  }
  const p = cfg.providers[cfg.activeProvider];
  if (!p) {
    throw new Error(
      `activeProvider="${cfg.activeProvider}" not found in providers. Run \`regard config\`.`,
    );
  }
  return buildLLM(p);
}

/**
 * Generic CLI-backend LLM. Spawns an installed coding-CLI and captures its
 * final text output for one turn.
 *
 * Defaults follow OpenClaw's sanctioned invocation patterns:
 *   - codex-cli   → `codex exec --json --color never --sandbox workspace-write --skip-git-repo-check`
 *   - claude-cli  → `claude -p --output-format stream-json`
 *   - copilot-cli → `copilot -p <prompt>` (standalone `@github/copilot`)
 *
 * Each backend is routed through a per-provider serialized lane with backend-
 * specific timeout defaults so repeated completions don't spam local CLIs in
 * parallel. Codex/Claude backends also preserve parsed session IDs and attempt
 * resume on follow-up turns.
 */
export class CliLLM implements LLM {
  private static readonly runners = new Map<string, CliBackendRunner>();

  constructor(
    private readonly backend: CliBackendKind,
    private readonly command?: string,
    private readonly extraArgs?: string[],
    private readonly model?: string,
    private readonly env?: Record<string, string>,
  ) {}

  async complete({
    system,
    user,
  }: {
    system: string;
    user: string;
    json?: boolean;
  }): Promise<string> {
    const prompt = `${system}\n\n---\n\n${user}`;
    return this.runner().complete(prompt);
  }

  private runner(): CliBackendRunner {
    const key = JSON.stringify({
      backend: this.backend,
      command: this.command ?? null,
      args: this.extraArgs ?? [],
      model: this.model ?? null,
      env: this.env ?? {},
    });
    let r = CliLLM.runners.get(key);
    if (!r) {
      r = new CliBackendRunner(this.backend, key, this.command, this.extraArgs, this.model, this.env);
      CliLLM.runners.set(key, r);
    }
    return r;
  }
}
