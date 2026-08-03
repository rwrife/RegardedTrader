# @regardedtrader/cli

Ink-based terminal UI for RegardedTrader. The binary is `regard`, and this package is a thin client over server endpoints.

- Repo rules: [AGENTS.md](../../AGENTS.md)
- Surface parity contract: [docs/surface-parity.md](../../docs/surface-parity.md)

## Router map

Command routing is centralized in `src/app.tsx`:

- `add`, `ls`, `rm` → watchlist/ticker intake screens
- `watch`, `tail`, `polling` → polling/tape screens
- `briefing`, `brief`, `quote`, `tech`, `news`, `plan`, `options`, `chart` → analysis + planning screens
- `paper` → simulated order/position surfaces
- `cal` / `calendar` → market calendar screens
- `config` → provider/risk config screens
- `dashboard` → launches/attaches to local web dashboard

When invoked with no command, `src/screens/menu.tsx` renders the interactive menu shell.

## Screen conventions

- Keep screens in `src/screens/` small and single-purpose.
- Parse/validate user-facing arguments in entry flow, not deep inside rendering branches.
- Reuse shared API helpers/types from `src/api.ts` + `@regardedtrader/core` schemas.
- Render canonical financial disclaimer when showing AI opinions.
- Prefer explicit completion callbacks (`onDone`) for menu-return flows.

## Adding a new `regard` subcommand

1. Add command help text + flags in `src/index.tsx` (meow config).
2. Create or extend a screen under `src/screens/`.
3. Wire command dispatch in `src/app.tsx`.
4. Add/update tests (`src/screens/*.test.ts*` and smoke interaction coverage).
5. Ensure matching web route/feature exists (or track immediately) and update [surface parity doc](../../docs/surface-parity.md).

## Development

From repo root:

```bash
npm --workspace @regardedtrader/cli run start -- --help
npm --workspace @regardedtrader/cli run test
npm --workspace @regardedtrader/cli run lint
```
