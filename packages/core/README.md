# @regardedtrader/core

Shared domain logic for RegardedTrader. This package is the single source of truth used by both surfaces (CLI + web) through `@regardedtrader/server`.

- Repo rules: [AGENTS.md](../../AGENTS.md)
- Surface parity contract: [docs/surface-parity.md](../../docs/surface-parity.md)

## Purpose

- Define wire-safe schemas (`zod`) for server/client contracts.
- Host agent implementations (`Analyst`, `Technician`, `NewsScout`, `OptionsStrategist`, `RiskOfficer`, ticker validation, sentiment scoring).
- Provide market data clients/adapters and deterministic analyzers.
- Own local-first storage helpers and polling/recommender orchestration primitives.

## Directory map

`src/` key areas:

- `agents/` — AI-agent implementations + provider wrappers.
- `clients/` — market/news/LLM client interfaces and implementations.
- `indicators/` — deterministic TA calculations.
- `polling/` — quote/news polling pipelines and normalization logic.
- `recommender/` — recommendation context/rules/orchestrator/store.
- `schemas/` — shared Zod schemas for all payloads.
- `storage/` — local persistence adapters (`~/.regardedtrader/*`).
- `tickers/` — ticker resolution, source adapters, profile cache/store.
- `calendar/`, `options/`, `paper/`, `prompts/`, `config/` — domain modules exported through `src/index.ts`.

## Non-negotiable core rule: no framework I/O

`core` stays framework-agnostic and mostly deterministic:

- no Express/Ink/React code,
- no direct route handlers,
- no direct environment-loading side effects for surface behavior.

Network or filesystem access must be behind explicit clients/stores that can be injected in tests.

## Adding a new agent

1. Add implementation under `src/agents/<name>.ts`.
2. Keep inputs/outputs typed with shared schemas in `src/schemas`.
3. Export from `src/agents/index.ts` and `src/index.ts` (if public to server/clients).
4. If orchestrated, wire through `src/orchestrator.ts` using dependency injection.
5. Add focused `vitest` coverage in `src/agents/*.test.ts` (or closest domain tests).

## Adding a new schema

1. Define schema + type in `src/schemas/<topic>.ts` (or `src/schemas/index.ts` if tightly coupled there).
2. Export it from `src/schemas/index.ts`.
3. Re-export via `src/index.ts` when needed across packages.
4. Use the schema at wire boundaries (server request/response parsing + client parsing).
5. Update or add tests validating parse success/failure cases.

## Development

From repo root:

```bash
npm --workspace @regardedtrader/core run build
npm --workspace @regardedtrader/core run test
npm --workspace @regardedtrader/core run lint
```
