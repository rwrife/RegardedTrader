import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Surface-audit test for issue #154: every CLI screen that renders LLM-influenced
 * output must include the canonical "not financial advice" disclaimer via either
 * `aiDisclaimerLine()` or the `disclaimer` field on `AiOutputEnvelope` payloads
 * (issue #77). This test reads source files directly so the check survives
 * refactors and is independent of Ink's render harness.
 */

const here = dirname(fileURLToPath(import.meta.url));
const screens = here;

type AiSurface = {
  file: string;
  /**
   * Some screens (`brief`, `briefing`) print the disclaimer that the server
   * embeds in the `Briefing` response (`data.disclaimer`), which is itself
   * sourced from the core `DISCLAIMER` via the envelope. Either form is OK.
   */
  acceptEnvelopeField?: boolean;
};

const SURFACES: AiSurface[] = [
  { file: 'brief.tsx', acceptEnvelopeField: true },
  { file: 'briefing.tsx', acceptEnvelopeField: true },
  { file: 'plan.tsx' },
  { file: 'tech.tsx' },
  { file: 'options.tsx' },
];

function read(name: string): string {
  return readFileSync(resolve(screens, name), 'utf8');
}

describe('CLI AI surfaces include the disclaimer (issue #154)', () => {
  it.each(SURFACES)('$file renders a disclaimer', ({ file, acceptEnvelopeField }) => {
    const src = read(file);
    const usesHelper = src.includes('aiDisclaimerLine');
    const usesEnvelope =
      Boolean(acceptEnvelopeField) && /\{data\.disclaimer\}/.test(src);
    expect(
      usesHelper || usesEnvelope,
      `${file} must call aiDisclaimerLine() or render {data.disclaimer} from the envelope`,
    ).toBe(true);
  });

  it('no CLI screen ships a hand-rolled disclaimer string', () => {
    // Catch regressions where someone re-introduces a local
    // "Not financial advice ..." constant instead of using the shared helper.
    for (const { file } of SURFACES) {
      const src = read(file);
      const hasLocalConst = /const\s+DISCLAIMER\s*=\s*['"][^'"]*Not financial advice/.test(
        src,
      );
      // options.tsx still has `const DISCLAIMER = aiDisclaimerLine();` — that's
      // fine because the RHS is the shared helper.
      expect(hasLocalConst, `${file} must not hard-code a disclaimer string`).toBe(false);
    }
  });
});
