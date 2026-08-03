# Agent Authoring Guide (`packages/core/src/agents/`)

This is the canonical guide for adding or changing RegardedTrader agents.

## Purpose

Agents are the AI/domain workers used by the core orchestrator pipeline. They must stay:

- deterministic at the seam (Zod-validated outputs)
- dependency-injected (no inline network access from agent internals)
- reusable by both CLI and web via shared `core` + `server`

## Agent contract and lifecycle

RegardedTrader does **not** currently use one giant generic `Agent` interface. Instead, each agent exposes a narrow method (examples: `Analyst.brief`, `Technician.analyze`, `OptionsStrategist.propose`) and the orchestrator composes them.

Lifecycle for an LLM-backed agent:

1. Receive typed input (`symbol`, `quote`, etc.).
2. Build prompts from `core/src/prompts/`.
3. Call injected `LLM.complete({ system, user, json: true })`.
4. Parse JSON and validate with a dedicated Zod schema.
5. On validation failure, throw `AgentParseError` (do not silently return empty content).
6. Construct enriched output (`disclaimer`, `sourcesUsed`, computed fields).
7. Validate outward payload against exported schema before returning.

## Schema location and naming

- Put wire/output schemas in **`packages/core/src/schemas/`**.
- Re-export through `packages/core/src/schemas/index.ts`.
- Use explicit names:
  - raw model reply: `SomethingOutputSchema`
  - outward contract: domain schema (`Briefing`, `BriefingTechnical`, etc.)
- Keep types derived from schemas (`type X = z.infer<typeof XSchema>`).

## Dependency injection (no raw fetch in agents)

Agents must not do ad-hoc HTTP calls.

- Inject clients through constructor/options (e.g., `MarketDataClient`, `WebSearch`, `LLM`).
- Keep framework + transport logic in clients under `core/src/clients/` and server wiring.
- Pure transforms/calculations stay in `core` modules.

## Minimal worked example (`HelloAgent`)

```ts
import type { LLM } from './llm.js';
import { z } from 'zod';
import { AgentParseError } from './errors.js';
import { DISCLAIMER } from '../constants.js';

const HelloOutputSchema = z.object({
  summary: z.string().min(1),
  sourcesUsed: z.array(z.string()).default([]),
});

type HelloInput = { symbol: string };

const HelloBriefingSchema = z.object({
  symbol: z.string().min(1),
  summary: z.string().min(1),
  sourcesUsed: z.array(z.string()).default([]),
  disclaimer: z.string().min(1),
});

export class HelloAgent {
  constructor(private readonly llm: LLM) {}

  async run(input: HelloInput) {
    const raw = await this.llm.complete({
      system: 'Return JSON with summary and sourcesUsed.',
      user: `Symbol: ${input.symbol}`,
      json: true,
    });

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new AgentParseError('HelloAgent', [(err as Error).message], raw);
    }

    const parsed = HelloOutputSchema.safeParse(json);
    if (!parsed.success) {
      throw new AgentParseError(
        'HelloAgent',
        parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
        raw,
      );
    }

    return HelloBriefingSchema.parse({
      symbol: input.symbol,
      summary: parsed.data.summary,
      sourcesUsed: parsed.data.sourcesUsed,
      disclaimer: DISCLAIMER,
    });
  }
}
```

## Testing pattern (`vitest` + fixtures)

- Co-locate tests as `*.test.ts` beside the agent.
- Use injected fakes/stubs (`LLM`, clients) rather than live network calls.
- Put reusable fixtures in `__fixtures__/` near the agent domain.
- Test both success paths and parse-failure paths (`AgentParseError`).

Recommended test cases:

- well-formed JSON parses and validates
- malformed JSON throws `AgentParseError`
- schema-mismatch JSON throws `AgentParseError`
- output always includes disclaimer and non-empty required fields

## Orchestrator registration and surface parity

After implementing an agent:

1. Register it in `packages/core/src/orchestrator.ts` (constructor wiring + invocation path).
2. Expose usage through server endpoints as needed.
3. Ensure **both** surfaces can reach it:
   - CLI command/route (`packages/cli`)
   - web route/view (`packages/web`)
4. Update `docs/surface-parity.md` in the same PR (or link a tracking issue in that PR).

## Disclaimer and sources requirements

Any user-facing AI output must:

- include canonical disclaimer text from `core/src/constants.ts` (`DISCLAIMER`)
- expose `sourcesUsed` so users can see which data informed the output
- avoid presenting model output as guaranteed advice

## Author checklist

- [ ] Prompts live in `core/src/prompts/` (no inlined multi-paragraph prompts in routes)
- [ ] Input/output schema changes in `core/src/schemas/`
- [ ] No `any` in new code
- [ ] No direct network calls inside agent
- [ ] `AgentParseError` used for invalid model output
- [ ] Tests added/updated with fixtures
- [ ] Orchestrator wired
- [ ] CLI + web parity maintained
- [ ] Disclaimer + sources included
