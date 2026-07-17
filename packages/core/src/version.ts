/**
 * Core version helper (issue #179).
 *
 * Mirrors `packages/server/src/version.ts` so the server's `GET /version`
 * endpoint can report `core` alongside `server` without duplicating the
 * package-loading logic. Read once at module load; route handlers pay zero
 * per-request I/O.
 *
 * Layout note:
 *  - `src/version.ts`  -> `../package.json`
 *  - `dist/version.js` -> `../package.json`
 * Both resolve the same file via `import.meta.url`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

function readCoreVersion(): string {
  try {
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
 * The `@regardedtrader/core` package version, resolved once at module load.
 * Exported as a plain `const` so importers get a stable value for the
 * lifetime of the process.
 */
export const CORE_VERSION: string = readCoreVersion();
