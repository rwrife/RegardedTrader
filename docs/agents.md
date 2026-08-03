# Agent Authoring Guide

This guide is the canonical playbook for adding a new agent under `packages/core/src/agents/`.

## 1) Agent interface and lifecycle

RegardedTrader agents are small, single-purpose classes with one async entrypoint and constructor-injected dependencies.

Lifecycle:

1. **Input received** (usually via Orchestrator, server route, or polling job).
2. **Prompt/build context** from typed input.
3. **Call dependencies** (LLM, market/news/web clients) through injected interfaces.
4. **Parse and validate** output with Zod schemas from `core/src/schemas/`.
5. **Return typed result** (or throw typed parse/domain errors when appropriate).

Use capability interfaces for orchestrator wiring (current examples: `TechnicianAgent`, `NewsScoutAgent` in `packages/core/src/agents/index.ts`), and keep one public method per agent (`brief`, `analyze`, `propose`, `scout`, `validate`, etc.).

## 2) Required schema location and naming

All wire/shared payload schemas live in:

- `packages/core/src/schemas/`

Rules:

- Define schemas with **PascalCase** names (`TickerProfile`, `Briefing`, `NewsScoutOutputSchema`).
- Export both schema and inferred TypeScript type (`export type X = z.infer<typeof X>`).
- Re-export from `packages/core/src/schemas/index.ts`.
- Validate at the seam: parse external/LLM output before returning from the agent.

## 3) Dependency injection (no raw `fetch` in agents)

Agents must not call raw HTTP directly.

- ✅ Inject typed clients from `packages/core/src/clients/` or LLM interfaces from `packages/core/src/agents/llm.ts`.
- ✅ Keep network access behind interfaces so tests stay deterministic.
- ❌ Do not use raw `fetch` inside agent classes.

## 4) Testing pattern (`__fixtures__`)

Use colocated tests (`*.test.ts`) and fixtures under `__fixtures__/`.

Examples in this repo:

- `packages/core/src/agents/__fixtures__/option-contracts.ts`
- `packages/core/src/agents/options-strategist.test.ts`
- `packages/core/src/recommender/__fixtures__/store.ts`
- `packages/core/src/recommender/orchestrator.test.ts`

Pattern:

1. Build tiny fake dependencies (`LLM`, clients) with deterministic responses.
2. Load structured fixture data from `__fixtures__/` for realistic cases.
3. Assert both happy-path outputs and malformed/edge-path behavior.

## 5) Register with Orchestrator + surface parity

When adding an agent that participates in briefings/plans:

1. Add exports in `packages/core/src/agents/index.ts`.
2. Add/extend the orchestrator slot interface in `packages/core/src/agents/index.ts` if needed.
3. Wire the optional/required slot in `packages/core/src/orchestrator.ts`.
4. Update server endpoint flow to expose the new output.
5. Add matching CLI and web surface integration (**parity is required**).
6. Update `docs/surface-parity.md` in the same PR.

If a feature lands on one surface, it must land on the other (or have a linked tracking issue in the same release).

## 6) Disclaimer + “sources used” requirements

For AI-generated output:

- Always include canonical disclaimer from `packages/core/src/constants.ts` (`DISCLAIMER`).
- Do not hardcode disclaimer variants.
- Include a `sourcesUsed` list whenever output depends on fetched/news/search inputs so users can inspect provenance.
- Follow `docs/disclaimer.md` and shared envelope/schema requirements.

## 7) Minimal worked example: `HelloAgent` (~50 lines)

```ts
import { z } from 'zod';
import type { LLM } from './llm.js';
import { DISCLAIMER } from '../constants.js';
import { AgentParseError } from './errors.js';

const HelloAgentOutput = z.object({
  summary: z.string().min(1),
  sourcesUsed: z.array(z.string().url()).default([]),
});

export type HelloAgentOutput = z.infer<typeof HelloAgentOutput>;

export interface HelloAgentInput {
  symbol: string;
  context: string;
}

export class HelloAgent {
  constructor(private readonly llm: LLM) {}

  async run(input: HelloAgentInput): Promise<HelloAgentOutput & { disclaimer: string }> {
    const raw = await this.llm.complete({
      system: 'You are a concise market assistant. Return JSON only.',
      user: `Summarize ${input.symbol} using: ${input.context}`,
      json: true,
    });

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (err) {
      throw new AgentParseError('HelloAgent', [(err as Error).message], raw);
    }

    const result = HelloAgentOutput.safeParse(parsedJson);
    if (!result.success) {
      throw new AgentParseError(
        'HelloAgent',
        result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
        raw,
      );
    }

    return { ...result.data, disclaimer: DISCLAIMER };
  }
}
```
