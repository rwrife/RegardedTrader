import { spawn } from 'node:child_process';
import OpenAI from 'openai';
import type { LLM } from '../agents/llm.js';
import { OpenAILLM } from '../agents/llm.js';
import type { AiProvider, AppConfig, CliBackendKind } from '../schemas/config.js';

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
 * final text output for one turn. Stateless; no session resume yet.
 *
 * Defaults follow OpenClaw's sanctioned invocation patterns:
 *   - codex-cli   → `codex exec --json --color never --sandbox workspace-write --skip-git-repo-check`
 *   - claude-cli  → `claude -p --output-format stream-json`
 *   - copilot-cli → `copilot -p <prompt>` (GitHub Copilot CLI standalone,
 *     `@github/copilot` npm package — not the older `gh copilot` extension)
 *
 * Each backend has its own quirks; this implementation gives a working baseline.
 * Per-backend hardening (sessions, JSONL parsing, MCP loopback) is tracked as
 * GitHub issues.
 */
export class CliLLM implements LLM {
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
    const { cmd, args, prompt, promptViaStdin } = this.buildInvocation(system, user);
    return new Promise<string>((resolve, reject) => {
      const child = spawn(cmd, args, {
        env: { ...process.env, ...(this.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b) => (stdout += b.toString()));
      child.stderr.on('data', (b) => (stderr += b.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `${this.backend} exited with code ${code}: ${stderr.slice(0, 500) || '(no stderr)'}`,
            ),
          );
          return;
        }
        resolve(this.extractText(stdout));
      });
      if (promptViaStdin) {
        child.stdin.end(prompt);
      } else {
        child.stdin.end();
      }
    });
  }

  private buildInvocation(system: string, user: string): {
    cmd: string;
    args: string[];
    prompt: string;
    /** When true, write `prompt` to the child's stdin. When false, the prompt is already in `args`. */
    promptViaStdin: boolean;
  } {
    const prompt = `${system}\n\n---\n\n${user}`;
    switch (this.backend) {
      case 'codex-cli': {
        const cmd = this.command ?? 'codex';
        const args = [
          'exec',
          '--json',
          '--color',
          'never',
          '--sandbox',
          'workspace-write',
          '--skip-git-repo-check',
        ];
        if (this.model) args.push('--model', this.model);
        if (this.extraArgs) args.push(...this.extraArgs);
        return { cmd, args, prompt, promptViaStdin: true };
      }
      case 'claude-cli': {
        const cmd = this.command ?? 'claude';
        const args = ['-p', '--output-format', 'stream-json', '--verbose'];
        if (this.model) args.push('--model', this.model);
        if (this.extraArgs) args.push(...this.extraArgs);
        return { cmd, args, prompt, promptViaStdin: true };
      }
      case 'copilot-cli': {
        // Standalone GitHub Copilot CLI (`@github/copilot`). It accepts the
        // prompt as a `-p`/`--prompt` argument in non-interactive mode and
        // does NOT read from stdin (older `gh copilot explain` integration
        // was removed — `gh copilot` only handled shell-suggest flows and
        // wasn't a real chat interface).
        const cmd = this.command ?? 'copilot';
        const args: string[] = [];
        if (this.model) args.push('--model', this.model);
        if (this.extraArgs) args.push(...this.extraArgs);
        args.push('-p', prompt);
        return { cmd, args, prompt, promptViaStdin: false };
      }
    }
  }

  /** Extract the final assistant text from each backend's stdout. Best-effort. */
  private extractText(out: string): string {
    if (this.backend === 'codex-cli') {
      // JSONL stream; the final agent message has type "agent_message".
      const lines = out.split(/\r?\n/).filter(Boolean);
      let last = '';
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          const text =
            obj?.message?.content ??
            obj?.content ??
            obj?.text ??
            (obj?.type === 'agent_message' ? obj?.message : null);
          if (typeof text === 'string' && text.trim()) last = text;
        } catch {
          /* not json, skip */
        }
      }
      return last || out.trim();
    }
    if (this.backend === 'claude-cli') {
      // stream-json from claude. The final result event has `.result`.
      const lines = out.split(/\r?\n/).filter(Boolean);
      let last = '';
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (typeof obj?.result === 'string') last = obj.result;
          else if (obj?.type === 'assistant' && typeof obj?.message?.content === 'string') {
            last = obj.message.content;
          }
        } catch {
          /* skip */
        }
      }
      return last || out.trim();
    }
    if (this.backend === 'copilot-cli') {
      // Strip ANSI escape sequences (the standalone Copilot CLI emits color
      // codes even in non-interactive mode). Anything beyond that is the
      // model's plain-text response.
      // eslint-disable-next-line no-control-regex
      return out.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').trim();
    }
    return out.trim();
  }
}
