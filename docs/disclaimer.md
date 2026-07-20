# Disclaimer policy

> **Educational/research output. Not financial advice. You are responsible for your own trades.**

RegardedTrader is a local research assistant, not an advisor or broker.

## Canonical source of truth

- Canonical string: `DISCLAIMER`
- Location: `packages/core/src/constants.ts`
- Schema-level enforcement: `packages/core/src/schemas/envelope.ts` (and recommendation schema usage)

All user-facing AI surfaces must render this canonical disclaimer, not a hand-written variant.

## Contributor checklist (required)

When adding or modifying any screen/route/command that shows AI-generated or AI-influenced output:

1. Import the canonical disclaimer from shared helpers (`@regardedtrader/core/constants` directly, or local wrappers like `aiDisclaimerLine()` / `<AiDisclaimer />`).
2. Render the disclaimer in the UI output.
3. Do **not** hardcode a local `"Not financial advice..."` string.
4. Ensure envelope/schema output still includes a non-empty disclaimer.
5. Run `npm run lint && npm test`.

## Automated guard

- Script: `scripts/check-disclaimer.mjs`
- Run via: `npm run lint`
- Behavior: fails if a non-test source file contains a hardcoded "Not financial advice" string outside the canonical constant file.
