import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configHome } from '../config/index.js';
import { Briefing, Ticker, type Briefing as BriefingT } from '../schemas/index.js';

export interface BriefingSummary {
  id: string;
  symbol: string;
  asOf: string;
  path: string;
}

export interface StoredBriefing extends BriefingSummary {
  briefing: BriefingT;
}

export interface BriefingStorePort {
  saveBriefing(briefing: BriefingT): Promise<BriefingSummary>;
  listBriefings(symbol: string, limit?: number): Promise<BriefingSummary[]>;
  getBriefing(id: string): Promise<StoredBriefing | null>;
}

export interface BriefingStoreOptions {
  root?: string;
  now?: () => Date;
}

export function briefingsRoot(): string {
  return join(configHome(), 'briefings');
}

function symbolDir(root: string, symbol: string): string {
  return join(root, symbol.toUpperCase());
}

function normalizeStamp(iso: string): string {
  // Cross-platform filename safety: Windows forbids ":" in file names.
  return iso.replaceAll(':', '-');
}

function denormalizeStamp(fileStamp: string): string {
  const idx = fileStamp.indexOf('T');
  if (idx < 0) return fileStamp;
  const date = fileStamp.slice(0, idx);
  const time = fileStamp.slice(idx + 1);
  const z = time.endsWith('Z') ? 'Z' : '';
  const core = z ? time.slice(0, -1) : time;
  const parts = core.split('-');
  if (parts.length < 3) return fileStamp;
  return `${date}T${parts[0]}:${parts[1]}:${parts.slice(2).join('-')}${z}`;
}

export function looksLikeBriefingId(id: string): boolean {
  return id.includes('__');
}

function parseBriefingId(id: string): { symbol: string; fileStamp: string } | null {
  const cut = id.indexOf('__');
  if (cut <= 0 || cut === id.length - 2) return null;
  const symbol = id.slice(0, cut).toUpperCase();
  const fileStamp = id.slice(cut + 2);
  if (!Ticker.safeParse(symbol).success) return null;
  if (fileStamp.length === 0 || fileStamp.includes('\\') || fileStamp.includes('/')) return null;
  return { symbol, fileStamp };
}

export class BriefingStore implements BriefingStorePort {
  private readonly root: string;
  private readonly now: () => Date;

  constructor(opts: BriefingStoreOptions = {}) {
    this.root = opts.root ?? briefingsRoot();
    this.now = opts.now ?? (() => new Date());
  }

  get rootDir(): string {
    return this.root;
  }

  async saveBriefing(briefing: BriefingT): Promise<BriefingSummary> {
    const parsed = Briefing.parse(briefing);
    const symbol = parsed.symbol.toUpperCase();
    const sourceIso =
      typeof parsed.asOf === 'string' && Number.isFinite(Date.parse(parsed.asOf))
        ? parsed.asOf
        : this.now().toISOString();
    const fileStamp = normalizeStamp(sourceIso);
    const dir = symbolDir(this.root, symbol);
    await mkdir(dir, { recursive: true });

    let candidate = fileStamp;
    let attempt = 0;
    while (true) {
      const path = join(dir, `${candidate}.json`);
      try {
        await stat(path);
        attempt += 1;
        candidate = `${fileStamp}-${attempt}`;
        continue;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }

      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, JSON.stringify(parsed, null, 2), 'utf8');
      await rename(tmp, path);
      try {
        await chmod(path, 0o600);
      } catch {
        /* ignore (Windows) */
      }
      return {
        id: `${symbol}__${candidate}`,
        symbol,
        asOf: parsed.asOf,
        path,
      };
    }
  }

  async listBriefings(symbol: string, limit = 20): Promise<BriefingSummary[]> {
    const sym = Ticker.parse(symbol.toUpperCase());
    const dir = symbolDir(this.root, sym);
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const files = names
      .filter((n) => n.endsWith('.json'))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, Math.max(0, Math.floor(limit)));

    return files.map((n) => {
      const stamp = n.slice(0, -'.json'.length);
      return {
        id: `${sym}__${stamp}`,
        symbol: sym,
        asOf: denormalizeStamp(stamp),
        path: join(dir, n),
      };
    });
  }

  async getBriefing(id: string): Promise<StoredBriefing | null> {
    const parsed = parseBriefingId(id);
    if (!parsed) return null;
    const path = join(symbolDir(this.root, parsed.symbol), `${parsed.fileStamp}.json`);
    try {
      const raw = await readFile(path, 'utf8');
      const briefing = Briefing.parse(JSON.parse(raw));
      return {
        id,
        symbol: parsed.symbol,
        asOf: briefing.asOf,
        path,
        briefing,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
}
