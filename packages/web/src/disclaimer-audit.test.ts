import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Surface-audit test for issue #154: every web AI surface must render the
 * shared <AiDisclaimer /> component (which itself pulls the canonical
 * `DISCLAIMER` string from `@regardedtrader/core/constants`, issue #77).
 *
 * The test reads source files directly so it catches regressions even when
 * the route's render path is hard to drive in jsdom.
 */

const srcRoot = dirname(fileURLToPath(import.meta.url));

const SURFACES = [
  'App.tsx',
  'routes/brief.tsx',
  'routes/plan.tsx',
  'routes/options.tsx',
  'routes/settings.tsx',
];

function read(rel: string): string {
  return readFileSync(resolve(srcRoot, rel), 'utf8');
}

describe('web AI surfaces include <AiDisclaimer /> (issue #154)', () => {
  it.each(SURFACES)('%s imports and renders <AiDisclaimer />', (rel) => {
    const src = read(rel);
    expect(src, `${rel} must import AiDisclaimer`).toMatch(
      /from\s+['"][^'"]*AiDisclaimer/,
    );
    expect(src, `${rel} must render <AiDisclaimer ... />`).toMatch(/<AiDisclaimer\b/);
  });

  it('no web surface hard-codes a "Not financial advice" string', () => {
    for (const rel of SURFACES) {
      const src = read(rel);
      const hasLocalConst =
        /const\s+DISCLAIMER\s*=\s*['"][^'"]*Not financial advice/.test(src);
      expect(hasLocalConst, `${rel} must not hard-code a disclaimer string`).toBe(false);
    }
  });
});
