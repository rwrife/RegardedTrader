# @regardedtrader/web

React + Vite dashboard for RegardedTrader.

## Scripts

- `npm run dev --workspace @regardedtrader/web` — start Vite dev server
- `npm run build --workspace @regardedtrader/web` — type-check + production build
- `npm run test --workspace @regardedtrader/web` — run Vitest (jsdom + Testing Library)

From repo root, `npm test` runs this workspace test suite automatically.

## Testing notes

- Test config: `packages/web/vitest.config.ts`
- Test setup: `packages/web/src/test-setup.ts`
- Preferred approach for server-driven views: inject `fetchImpl` and assert request/response behavior in component tests.

## Design-system pointers

- Follow dark-terminal visual language in `docs/design.md`.
- Use `AiDisclaimer` on AI-analysis surfaces (see `docs/disclaimer.md`).
- Keep formatting/value semantics aligned with shared domain terminology in `docs/domain-glossary.md`.
