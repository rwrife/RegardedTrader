import Database from 'better-sqlite3';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { configHome } from '../config/index.js';

export interface CacheGetSetOptions {
  ttlMs?: number;
}

export interface CacheDeleteResult {
  deleted: number;
}

export interface SQLiteCacheOptions {
  dbPath?: string;
  enabled?: boolean;
  namespaceTtls?: Record<string, number>;
  now?: () => number;
}

interface CacheRow {
  value: Buffer | string;
  expires_at: number;
}

export function defaultCacheDbPath(): string {
  return join(configHome(), 'cache.sqlite');
}

export class SQLiteCache {
  private readonly dbPath: string;
  private readonly namespaceTtls: Record<string, number>;
  private readonly now: () => number;
  private enabled: boolean;
  private db: Database.Database | null = null;
  private initPromise: Promise<Database.Database> | null = null;

  constructor(opts: SQLiteCacheOptions = {}) {
    this.dbPath = opts.dbPath ?? defaultCacheDbPath();
    this.namespaceTtls = { ...(opts.namespaceTtls ?? {}) };
    this.now = opts.now ?? Date.now;
    this.enabled = opts.enabled ?? true;
  }

  get path(): string {
    return this.dbPath;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    if (!this.enabled) return undefined;
    const db = await this.ensureDb();
    const row = db
      .prepare('SELECT value, expires_at FROM cache WHERE namespace = ? AND key = ?')
      .get(namespace, key) as CacheRow | undefined;
    if (!row) return undefined;

    if (row.expires_at <= this.now()) {
      db.prepare('DELETE FROM cache WHERE namespace = ? AND key = ?').run(namespace, key);
      return undefined;
    }

    try {
      const raw = Buffer.isBuffer(row.value) ? row.value.toString('utf8') : row.value;
      return JSON.parse(raw) as T;
    } catch {
      db.prepare('DELETE FROM cache WHERE namespace = ? AND key = ?').run(namespace, key);
      return undefined;
    }
  }

  async set<T>(namespace: string, key: string, value: T, opts: CacheGetSetOptions = {}): Promise<void> {
    if (!this.enabled) return;
    const db = await this.ensureDb();
    const ttlMs = this.resolveTtlMs(namespace, opts.ttlMs);
    const fetchedAt = this.now();
    const expiresAt = fetchedAt + ttlMs;
    const payload = Buffer.from(JSON.stringify(value), 'utf8');
    db.prepare(
      `INSERT INTO cache(namespace, key, value, fetched_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(namespace, key)
       DO UPDATE SET
         value = excluded.value,
         fetched_at = excluded.fetched_at,
         expires_at = excluded.expires_at`,
    ).run(namespace, key, payload, fetchedAt, expiresAt);
  }

  async del(namespace: string, key: string): Promise<boolean> {
    const db = await this.ensureDb();
    const out = db.prepare('DELETE FROM cache WHERE namespace = ? AND key = ?').run(namespace, key);
    return out.changes > 0;
  }

  async clear(namespace?: string): Promise<CacheDeleteResult> {
    const db = await this.ensureDb();
    if (namespace) {
      const out = db.prepare('DELETE FROM cache WHERE namespace = ?').run(namespace);
      return { deleted: out.changes };
    }
    const out = db.prepare('DELETE FROM cache').run();
    return { deleted: out.changes };
  }

  async sweep(): Promise<number> {
    const db = await this.ensureDb();
    const out = db.prepare('DELETE FROM cache WHERE expires_at <= ?').run(this.now());
    return out.changes;
  }

  async close(): Promise<void> {
    if (this.db) this.db.close();
    this.db = null;
    this.initPromise = null;
  }

  private resolveTtlMs(namespace: string, override?: number): number {
    const ttl = override ?? this.namespaceTtls[namespace];
    if (!Number.isFinite(ttl) || ttl === undefined || ttl <= 0) {
      throw new Error(`SQLiteCache TTL missing/invalid for namespace "${namespace}"`);
    }
    return Math.floor(ttl);
  }

  private async ensureDb(): Promise<Database.Database> {
    if (this.db) return this.db;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await mkdir(dirname(this.dbPath), { recursive: true });
      const db = new Database(this.dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.exec(
        `CREATE TABLE IF NOT EXISTS cache(
          namespace TEXT NOT NULL,
          key TEXT NOT NULL,
          value BLOB NOT NULL,
          fetched_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY(namespace, key)
        );`,
      );
      try {
        await chmod(this.dbPath, 0o600);
      } catch {
        /* ignore on platforms/filesystems that don't support unix perms */
      }
      this.db = db;
      return db;
    })();
    return this.initPromise;
  }
}
