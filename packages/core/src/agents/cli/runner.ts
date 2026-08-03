import { spawn } from 'node:child_process';
import type { CliBackendKind } from '../../schemas/config.js';
import { parseClaudeJsonl, parseCodexJsonl } from './parsers.js';

const BACKEND_TIMEOUT_MS: Record<CliBackendKind, number> = {
  'codex-cli': 120_000,
  'claude-cli': 120_000,
  'copilot-cli': 90_000,
};

const lanes = new Map<string, Promise<unknown>>();

export class CliBackendRunner {
  private sessionId?: string;

  constructor(
    private readonly backend: CliBackendKind,
    private readonly laneKey: string,
    private readonly command?: string,
    private readonly extraArgs?: string[],
    private readonly model?: string,
    private readonly env?: Record<string, string>,
  ) {}

  async complete(prompt: string): Promise<string> {
    const queued = (lanes.get(this.laneKey) ?? Promise.resolve()).then(() => this.completeUnqueued(prompt));
    lanes.set(this.laneKey, queued.catch(() => undefined));
    try {
      return await queued;
    } finally {
      if (lanes.get(this.laneKey) === queued) lanes.delete(this.laneKey);
    }
  }

  private async completeUnqueued(prompt: string): Promise<string> {
    const { cmd, args, promptViaStdin } = this.buildInvocation();
    const stdout = await runCliProcess({
      backend: this.backend,
      cmd,
      args,
      prompt,
      promptViaStdin,
      env: this.env,
    });

    if (this.backend === 'codex-cli') {
      const parsed = parseCodexJsonl(stdout);
      this.sessionId = parsed.sessionId ?? this.sessionId;
      return parsed.text;
    }
    if (this.backend === 'claude-cli') {
      const parsed = parseClaudeJsonl(stdout);
      this.sessionId = parsed.sessionId ?? this.sessionId;
      return parsed.text;
    }
    return stripAnsi(stdout);
  }

  private buildInvocation(): { cmd: string; args: string[]; promptViaStdin: boolean } {
    switch (this.backend) {
      case 'codex-cli': {
        const cmd = this.command ?? 'codex';
        const args = ['exec'];
        if (this.sessionId) args.push('resume', this.sessionId);
        args.push('--json', '--color', 'never', '--sandbox', 'workspace-write', '--skip-git-repo-check');
        if (this.model) args.push('--model', this.model);
        if (this.extraArgs) args.push(...this.extraArgs);
        return { cmd, args, promptViaStdin: true };
      }
      case 'claude-cli': {
        const cmd = this.command ?? 'claude';
        const args = ['-p', '--output-format', 'stream-json', '--verbose'];
        if (this.sessionId) args.push('--resume', this.sessionId);
        if (this.model) args.push('--model', this.model);
        if (this.extraArgs) args.push(...this.extraArgs);
        return { cmd, args, promptViaStdin: true };
      }
      case 'copilot-cli': {
        const cmd = this.command ?? 'copilot';
        const args: string[] = [];
        if (this.model) args.push('--model', this.model);
        if (this.extraArgs) args.push(...this.extraArgs);
        args.push('-p', promptPlaceholder);
        return { cmd, args, promptViaStdin: false };
      }
    }
  }
}

const promptPlaceholder = '__REGARDEDTRADER_PROMPT__';

async function runCliProcess(opts: {
  backend: CliBackendKind;
  cmd: string;
  args: string[];
  prompt: string;
  promptViaStdin: boolean;
  env?: Record<string, string>;
}): Promise<string> {
  const timeoutMs = BACKEND_TIMEOUT_MS[opts.backend];
  const args = opts.args.map((a) => (a === promptPlaceholder ? opts.prompt : a));
  return new Promise<string>((resolve, reject) => {
    const child = spawn(opts.cmd, args, {
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${opts.backend} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('error', (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`${opts.backend} exited with code ${code}: ${stderr.slice(0, 500) || '(no stderr)'}`));
        return;
      }
      resolve(stdout);
    });
    if (opts.promptViaStdin) child.stdin.end(opts.prompt);
    else child.stdin.end();
  });
}

function stripAnsi(out: string): string {
  // eslint-disable-next-line no-control-regex
  return out.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').trim();
}
