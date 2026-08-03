# @regardedtrader/web

Vite + React + Tailwind dashboard surface for RegardedTrader. This package is a client over local server APIs and shared core schemas.

- Repo rules: [AGENTS.md](../../AGENTS.md)
- Surface parity contract: [docs/surface-parity.md](../../docs/surface-parity.md)
- Design language: [docs/design.md](../../docs/design.md)

## Setup / scripts

From repo root:

```bash
npm --workspace @regardedtrader/web run dev
npm --workspace @regardedtrader/web run build
npm --workspace @regardedtrader/web run test
```

From repo root, `npm test` also runs this workspace test suite.

## Route map

Top-level hash routes (from `src/App.tsx`):

- `#/` — home dashboard (ticker intake, watchlist, quote header, tabs)
- `#/settings` — provider/risk/server settings
- `#/watchlist` — validated ticker watchlist page
- `#/paper` — paper trading panel
- `#/brief/:symbol` — full briefing view
- `#/plan/:symbol` — options trade-plan route
- `#/options/:symbol` — options chain explorer
- `#/ticker/:symbol` — full chart route

Home tabs are under `src/routes/tabs/` (`Briefing`, `Sentiment`, `News`, `Recommendation`, `Calendar`, `Chart`, `Tech`).

## Conventions

- Keep components in `src/components/` presentational when possible.
- Keep network logic in hooks/routes, not deep UI leaf nodes.
- Use shared core schemas/types for payload assumptions.
- Respect design constraints in [docs/design.md](../../docs/design.md): dark-first palette, mono numeric data surfaces, explicit AI disclosure treatment.
- Keep formatting/value semantics aligned with [docs/domain-glossary.md](../../docs/domain-glossary.md).
- Use `AiDisclaimer` on AI-analysis surfaces (see [docs/disclaimer.md](../../docs/disclaimer.md)).
- Preserve parity with CLI command surfaces and update [surface-parity.md](../../docs/surface-parity.md) whenever routes/features change.

## Testing notes

- Current package command is `vitest run --passWithNoTests`.
- Test config: `packages/web/vitest.config.ts`
- Test setup: `packages/web/src/test-setup.ts`
- Preferred approach for server-driven views: inject `fetchImpl` and assert request/response behavior in component tests.
- Broader route-level test setup remains tracked by issue #79; extend this README when that lands.
