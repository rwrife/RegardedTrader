import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { configHome } from '@regardedtrader/core';

export interface DashboardOptions {
  serverUrl: string;
  port: number;
  noOpen: boolean;
  printUrl: boolean;
  force: boolean;
}

interface DashboardPidFile {
  pid: number;
  url: string;
}

const pidFilePath = join(configHome(), 'run', 'dashboard.pid');

function parsePortFromUrl(raw: string): number {
  const u = new URL(raw);
  return Number(u.port || '80');
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPidFile(): Promise<DashboardPidFile | null> {
  try {
    const raw = await readFile(pidFilePath, 'utf8');
    const parsed = JSON.parse(raw) as DashboardPidFile;
    if (typeof parsed.pid !== 'number' || typeof parsed.url !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writePidFile(data: DashboardPidFile): Promise<void> {
  await mkdir(dirname(pidFilePath), { recursive: true });
  await writeFile(pidFilePath, JSON.stringify(data), 'utf8');
}

async function clearPidFile(): Promise<void> {
  await rm(pidFilePath, { force: true });
}

function spawnNpm(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  if (process.platform === 'win32') {
    const quoted = args
      .map((a) => (/\s/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a))
      .join(' ');
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npm ${quoted}`], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: resolve(process.cwd()),
    });
  }
  return spawn('npm', args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: resolve(process.cwd()),
  });
}

function streamLogs(name: string, child: ChildProcess): void {
  child.stdout?.on('data', (chunk) => {
    process.stdout.write(`[${name}] ${String(chunk)}`);
  });
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(`[${name}] ${String(chunk)}`);
  });
}

async function waitForHealth(serverUrl: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${serverUrl.replace(/\/$/, '')}/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  throw new Error(`Timed out waiting for server health at ${serverUrl}/health`);
}

function openBrowser(url: string): void {
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

export async function runDashboardCommand(opts: DashboardOptions): Promise<number> {
  const existing = await readPidFile();
  if (existing && isRunning(existing.pid)) {
    if (!opts.force) {
      console.error(`Dashboard already running at ${existing.url}`);
      console.error('Use --force to replace it.');
      return 1;
    }
    try {
      process.kill(existing.pid, 'SIGTERM');
    } catch {
      // ignore and continue
    }
  }

  let token = randomBytes(32).toString('base64url');
  const dashboardOrigin = `http://127.0.0.1:${opts.port}`;
  const dashboardUrl = `${dashboardOrigin}/?t=${encodeURIComponent(token)}`;
  const serverPort = parsePortFromUrl(opts.serverUrl);

  const serverChild = spawnNpm(
    [
      '--workspace',
      '@regardedtrader/server',
      'run',
      'dev',
      '--',
      '--auth-token',
      token,
      '--dashboard-origin',
      dashboardOrigin,
    ],
    {
      ...process.env,
      REGARDEDTRADER_AUTH_TOKEN: token,
      REGARDEDTRADER_DASHBOARD_ORIGIN: dashboardOrigin,
      REGARDEDTRADER_SERVER_PORT: String(serverPort),
    },
  );

  const webChild = spawnNpm(
    [
      '--workspace',
      '@regardedtrader/web',
      'run',
      'dev',
      '--',
      '--host',
      '127.0.0.1',
      '--port',
      String(opts.port),
      '--strictPort',
    ],
    {
      ...process.env,
      REGARDEDTRADER_SERVER_URL: opts.serverUrl,
    },
  );

  streamLogs('server', serverChild);
  streamLogs('web', webChild);

  await writePidFile({ pid: process.pid, url: dashboardUrl });

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    serverChild.kill('SIGTERM');
    webChild.kill('SIGTERM');
    token = '';
    await clearPidFile();
  }

  process.on('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on('exit', () => {
    void clearPidFile();
  });

  console.log(`RegardedTrader server: ${opts.serverUrl}`);
  console.log(`Dashboard:             ${dashboardUrl}`);
  console.log('');
  console.log(`  Token: ${token}   (valid until you Ctrl-C)`);
  console.log('');

  await waitForHealth(opts.serverUrl);

  if (opts.printUrl || opts.noOpen) {
    console.log(dashboardUrl);
  } else {
    console.log('Opening browser…');
    openBrowser(dashboardUrl);
  }

  await Promise.race([
    new Promise((resolve) => serverChild.on('exit', resolve)),
    new Promise((resolve) => webChild.on('exit', resolve)),
  ]);
  await shutdown();
  return 0;
}

export async function dashboardCommandPreflight(force: boolean): Promise<{ running: boolean; url?: string }> {
  const existing = await readPidFile();
  if (!existing || !isRunning(existing.pid)) {
    if (existing) await clearPidFile();
    return { running: false };
  }
  if (force) {
    try {
      process.kill(existing.pid, 'SIGTERM');
    } catch {
      // ignore
    }
    return { running: false };
  }
  return { running: true, url: existing.url };
}

export async function hasWebDist(): Promise<boolean> {
  try {
    const distIndex = join(resolve(process.cwd()), 'packages', 'web', 'dist', 'index.html');
    const s = await stat(distIndex);
    return s.isFile();
  } catch {
    return false;
  }
}
