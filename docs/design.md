# RegardedTrader — Design Language

A focused style guide for the **web dashboard**. The Ink CLI follows the same
ethos (mono, dense, terminal-feel) but has its own constraints.

## North star

> A clean, professional, dark trading terminal — like the best parts of
> Bloomberg, IBKR TWS, and TradingView — that **explains itself**. The classic
> terminals show you data and expect you to know what it means. We show you the
> same data plus a calm, well-cited AI layer that helps you understand it.

Three audiences should feel at home:

1. A trader who likes their terminals dense and keyboard-driven.
2. A spreadsheet-and-charts retail investor who wants pretty visuals.
3. Someone learning who needs the AI to explain what RSI even is.

The design has to serve all three without becoming a toy.

## Tokens

### Surfaces (dark only, v1)

| Token              | Hex       | Use                                            |
| ------------------ | --------- | ---------------------------------------------- |
| `bg.app`           | `#0A0F14` | Page background. Near-black with cool tint.   |
| `bg.surface`       | `#0F1620` | Cards, panels.                                 |
| `bg.surface-2`     | `#141C28` | Nested surfaces, table headers, hover.         |
| `bg.surface-3`     | `#1B2533` | Active rows, focused inputs.                   |
| `border.subtle`    | `#1F2A38` | Hairlines, dividers.                           |
| `border.strong`    | `#2B3A4D` | Card borders, separators that need to read.    |
| `text.primary`     | `#E6EDF3` | Default text. Never `#FFF`.                    |
| `text.secondary`   | `#9BA8B7` | Labels, captions.                              |
| `text.muted`       | `#5F6E7E` | Timestamps, hints.                             |
| `text.disabled`    | `#3D4A5A` |                                                |

### Semantic color (data, not chrome)

| Token             | Hex       | Means                                       |
| ----------------- | --------- | ------------------------------------------- |
| `state.up`        | `#26D782` | Price up, P/L positive, success.            |
| `state.up-soft`   | `#0F4A2F` | Up tint for chart fills / row backgrounds.  |
| `state.down`      | `#FF5C7A` | Price down, P/L negative, error.            |
| `state.down-soft` | `#4A1620` |                                             |
| `state.warn`      | `#F5A524` | Warnings, risk caps, IV spikes.             |
| `state.info`      | `#56A6FF` | Neutral informational accents.              |
| `accent.ai`       | `#5BE3D6` | AI output stripe, AI badges, AI links.      |
| `accent.brand`    | `#26D782` | Logo/brand accent only. Same hue as `up`. |

Rules:

- Green/red ONLY mean P/L direction. Never green/red for "OK/error" UI status —
  use neutral text + an icon for that.
- AI is teal/cyan, not green. This keeps "AI said" visually distinct from
  "stock went up."
- Color blindness: every up/down indicator must also have a `▲ / ▼` glyph or
  a `+ / -` sign.

### Typography

- **Mono:** `JetBrains Mono`, fallback `IBM Plex Mono`, fallback `ui-monospace`.
  Use for: prices, P/L, strikes, greeks, % changes, table cells with numbers,
  contract symbols, CLI-style snippets.
- **Sans:** `Inter`, fallback `system-ui`. Use for: prose, headings, labels,
  AI summaries, modals.
- **Numbers in tables:** `font-variant-numeric: tabular-nums;` always.
  Right-aligned. Decimals aligned by place value.

Sizes (rem):

| Use              | Size   |
| ---------------- | ------ |
| Page title       | 1.25   |
| Section heading  | 1.0    |
| Body / table     | 0.875  |
| Caption / label  | 0.75   |
| Micro / status   | 0.6875 |

### Density

- Default row height in data tables: **28px**.
- Compact mode (toggleable): **22px**.
- Card padding: 16px outer, 12px inner sections.
- AI/prose regions: 24px padding, generous line-height (1.55).

### Motion

- Live value updates: a 200ms fade of background tint (up-soft / down-soft),
  then back to base. No flashing, no bouncing.
- Route transitions: 120ms opacity. No slide-ins.
- Respect `prefers-reduced-motion: reduce` — disable all flashes and pulses.

## Layout

A persistent three-zone shell:

```
┌──────────────────────────────────────────────────────────────────────┐
│  TopBar   ticker bar · market status · clock · refresh · ⌘K palette │
├────────┬─────────────────────────────────────────────────────────────┤
│ Side   │                                                             │
│ Nav    │             Main content area (route-specific)              │
│        │                                                             │
│ Watch  │                                                             │
│ list   │                                                             │
└────────┴─────────────────────────────────────────────────────────────┘
```

- Sidebar is collapsible (icon-only mode at < 1024px).
- Watchlist lives in the sidebar bottom half; click a row to load that ticker
  into the main pane.
- Main pane uses a tabbed sub-shell for `Overview | Chart | Options | News | AI`.

## Charts

- Single library across the app. Prefer
  [`lightweight-charts`](https://github.com/tradingview/lightweight-charts) for
  candles/areas; `visx` or `recharts` for everything else (bar P/L diagrams,
  greek surfaces, payoff curves).
- Default chart type for a ticker: **candles + volume**, with toggleable
  overlays for SMA(20), SMA(50), EMA(12/26), and a separate pane for RSI(14)
  and MACD.
- Crosshair always on. Hovering shows OHLCV + indicator values pinned to a
  legend in the top-left.
- Options payoff diagrams: filled area chart, x-axis = price at expiry,
  y-axis = P/L, x=current price marked with a vertical guide, break-evens
  marked as dotted verticals, max-loss line in `state.down`, max-gain in
  `state.up`.

## AI surfaces

This is the part old terminals never had. Treat it like a first-class component
type — not a bonus feature.

- Every AI-produced block lives in an `<AiCard>` with:
  - A 2px left-edge stripe in `accent.ai`.
  - A small `AI` pill (uppercase, mono, `accent.ai` text on a darker tint).
  - A `Sources` disclosure at the bottom listing every URL the LLM was given.
  - The disclaimer ("Educational/research. Not financial advice.") in
    `text.muted` italic, always present.
- Long-form output (bull case, bear case) is rendered as **scannable cards**,
  not paragraphs:
  - One-line summary at top, bolder.
  - Up to 4 bullet supports underneath.
- Numbers cited by the AI must be tagged with their source: hover shows where
  it came from (e.g. `RSI 67.3 · computed from 6mo daily closes`).
- A subtle `(re-ask)` link on every AI card lets the user regenerate that
  specific section without redoing the whole briefing.

## States

- **Loading:** skeletons that match the final layout, not spinners. AI cards
  show a "thinking..." line with a slow shimmer in `accent.ai`.
- **Empty:** a short prompt and the relevant CLI command to fix it
  (e.g. "No tickers yet. Try `regard add NVDA` or use the bar above.").
- **Error:** neutral surface with a `state.down` icon and the actionable
  message. Never throw a stack trace at the user.
- **Stale data:** show a small `state.warn` dot next to the timestamp and a
  `(refresh)` action.

## Status bar (top)

Left to right:

1. Ticker input (always focusable via `/`).
2. Market status pill: `Open` (`state.up`) / `Closed` (`text.muted`) /
   `Pre-market` / `After-hours` (`state.warn`).
3. Last-refresh time, mono.
4. Connection dot to local server.
5. `⌘K` palette hint.

## Command palette (⌘K / Ctrl-K)

- Fuzzy-search tickers in the watchlist, then global views, then AI actions
  ("explain RSI", "what are catalysts for NVDA").
- Keyboard-only operable. Esc closes. Arrow keys navigate. Enter executes.
- Matches CLI verbs where possible: `add NVDA`, `plan TSLA`, `briefing AAPL`.

## Accessibility

- WCAG AA contrast for every text token against its intended background.
- Focus rings are visible and use `accent.ai` (cyan reads well on dark).
- All interactive elements reachable by Tab in a logical order.
- Charts have a "Show data table" toggle that renders the underlying numbers.

## Anti-patterns

- ❌ Pure black `#000` backgrounds. Looks cheap, hurts on OLED at night.
- ❌ Neon everywhere. Color must mean something.
- ❌ Branded green/red used as success/error UI affordances.
- ❌ Big hero illustrations or marketing-y empty states.
- ❌ Modal dialogs for routine actions. Prefer inline editing and slide-overs.
- ❌ AI output dressed up as authoritative fact. Always cite sources and
  disclaim.

## Implementation notes

- Tailwind config maps the tokens above to utility classes
  (`bg-app`, `text-primary`, `text-up`, `border-subtle`, etc.).
- A `<ThemeProvider>` is overkill for v1 (dark only). Just CSS variables on
  `:root` so the CLI's dashboard launcher can deep-link without hydration.
- Fonts loaded locally (no Google Fonts call at runtime — local-only rule).
