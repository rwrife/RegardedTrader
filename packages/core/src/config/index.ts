import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AppConfig, DEFAULT_CONFIG } from '../schemas/config.js';
import type { AppConfig as AppConfigT } from '../schemas/config.js';

export function configHome(): string {
  return process.env.REGARDEDTRADER_HOME?.trim() || join(homedir(), '.regardedtrader');
}

export function configPath(): string {
  return join(configHome(), 'config.json');
}

export async function loadConfig(): Promise<AppConfigT> {
  const p = configPath();
  try {
    const raw = await readFile(p, 'utf8');
    const parsed = AppConfig.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      console.warn(`[config] ${p} failed validation; falling back to defaults.`);
      return DEFAULT_CONFIG;
    }
    return parsed.data;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
    throw e;
  }
}

export async function saveConfig(cfg: AppConfigT): Promise<string> {
  const validated = AppConfig.parse(cfg);
  const p = configPath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(validated, null, 2), 'utf8');
  // Best-effort: lock down the file (ignore on Windows)
  try {
    await chmod(p, 0o600);
  } catch {
    /* ignore */
  }
  return p;
}

export async function patchConfig(
  fn: (cfg: AppConfigT) => AppConfigT | Promise<AppConfigT>,
): Promise<AppConfigT> {
  const cur = await loadConfig();
  const next = await fn(cur);
  await saveConfig(next);
  return next;
}
