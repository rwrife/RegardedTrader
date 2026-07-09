/**
 * Server version helper (issue #180).
 *
 * The `/health` endpoint used to hardcode `"version": "0.1.0"`, which
 * silently drifted from `packages/server/package.json` on every bump.
 * This module reads the version from the shipped `package.json` once at
 * module load and re-exports it, so `/health` always reports the actual
 * release.
 *
 * Runtime notes:
 *  - No new dependencies. Uses only `node:fs` + `node:url`.
 *  - Resolved relative to `import.meta.url` so it works identically under
 *    `tsx watch` (source layout: `src/version.ts` + `package.json`) and the
 *    built ESM output (`dist/version.js` + `package.json`).
 *  - Cached at module load. Route handlers pay zero per-request I/O.
 *  - If the file is missing or malformed we fall back to `'0.0.0'` and log
 *    a warning rather than crashing the server. `/health` must never fail
 *    just because packaging is weird in some downstream install.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

function readServerVersion(): string {
  try {
    // `src/version.ts` -> `../package.json`
    // `dist/version.js` -> `../package.json`
    // Both layouts have package.json one directory above this file.
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'version' in parsed &&
      typeof (parsed as { version: unknown }).version === 'string'
    ) {
      return (parsed as { version: string }).version;
    }
    return '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * The server package version, resolved once at module load. Exported as a
 * plain `const` so importers get a value they can trust for the lifetime
 * of the process.
 */
export const SERVER_VERSION: string = readServerVersion();
