import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SAMPLE_TICKERS, findSample, type SampleTicker } from './sample-data.js';
import { Settings } from './routes/settings.js';
import { Brief } from './routes/brief.js';
import { Plan } from './routes/plan.js';
import { Options } from './routes/options.js';
import { TickerRoute } from './routes/ticker.js';
import { Watchlist as WatchlistRoute } from './routes/watchlist.js';
import { Paper as PaperRoute } from './routes/paper.js';
import { TopBar } from './components/TopBar.js';
import { CommandPalette, type CommandPaletteItem } from './components/CommandPalette.js';
import { Watchlist } from './components/Watchlist.js';
import { CalendarStrip } from './components/CalendarStrip.js';
import { QuoteHeader } from './components/QuoteHeader.js';
import { TabBar } from './components/TabBar.js';
import { TickerIntake } from './components/TickerIntake.js';
import { BriefingTab } from './routes/tabs/BriefingTab.js';
import { RecommendationTab } from './routes/tabs/RecommendationTab.js';
import { SentimentTab } from './routes/tabs/SentimentTab.js';
import { NewsTab } from './routes/tabs/NewsTab.js';
import { CalendarTab } from './routes/tabs/CalendarTab.js';
import { ChartTab } from './routes/tabs/ChartTab.js';
import { TechTab } from './routes/tabs/TechTab.js';
import { useLiveQuote } from './hooks/useLiveQuote.js';
import { useHistory } from './hooks/useHistory.js';
import { CandleChart } from './components/CandleChart.js';
import { LiveQuoteIndicator } from './components/LiveQuoteIndicator.js';
import { AUTH_EXPIRED_EVENT } from './auth.js';
import type { Tab } from './types.js';
import type { WatchlistEntry } from './types.js';

// Tiny hash-based router so the dashboard stays a single bundle without
// pulling in react-router. Routes: `#/` (default), `#/settings`,
// `#/brief/:symbol` (full Orchestrator briefing pipeline, issue #139),
// `#/plan/:symbol` (OptionsStrategist trade-plan view, issue #113),
// `#/options/:symbol` (options chain explorer), `#/ticker/:symbol` (full
// chart route with overlays/RSI/MACD, issue #2).
type Route =
  | { kind: 'home' }
  | { kind: 'settings' }
  | { kind: 'brief'; symbol: string }
  | { kind: 'plan'; symbol: string }
  | { kind: 'options'; symbol: string }
  | { kind: 'ticker'; symbol: string }
  | { kind: 'watchlist' }
  | { kind: 'paper' };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '').replace(/^\/+/, '');
  if (raw.startsWith('settings')) return { kind: 'settings' };
  if (raw.startsWith('watchlist')) return { kind: 'watchlist' };
  if (raw.startsWith('paper')) return { kind: 'paper' };
  const briefMatch = raw.match(/^brief\/([^/?#]+)/);
  if (briefMatch)
    return { kind: 'brief', symbol: decodeURIComponent(briefMatch[1]!).toUpperCase() };
  const planMatch = raw.match(/^plan\/([^/?#]+)/);
  if (planMatch) return { kind: 'plan', symbol: decodeURIComponent(planMatch[1]!).toUpperCase() };
  const optionsMatch = raw.match(/^options\/([^/?#]+)/);
  if (optionsMatch)
    return { kind: 'options', symbol: decodeURIComponent(optionsMatch[1]!).toUpperCase() };
  const tickerMatch = raw.match(/^ticker\/([^/?#]+)/);
  if (tickerMatch)
    return { kind: 'ticker', symbol: decodeURIComponent(tickerMatch[1]!).toUpperCase() };
  return { kind: 'home' };
}

type NavTarget =
  | 'home'
  | 'settings'
  | 'watchlist'
  | 'paper'
  | { kind: 'brief'; symbol: string }
  | { kind: 'plan'; symbol: string }
  | { kind: 'options'; symbol: string }
  | { kind: 'ticker'; symbol: string };

export function useHashRoute(): [Route, (r: NavTarget) => void] {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === 'undefined' ? { kind: 'home' } : parseRoute(window.location.hash),
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onHash = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = useCallback((r: NavTarget): void => {
    if (typeof window === 'undefined') return;
    if (r === 'settings') {
      window.location.hash = '#/settings';
    } else if (r === 'watchlist') {
      window.location.hash = '#/watchlist';
    } else if (r === 'paper') {
      window.location.hash = '#/paper';
    } else if (r === 'home') {
      window.location.hash = '#/';
    } else if (r.kind === 'plan') {
      window.location.hash = `#/plan/${encodeURIComponent(r.symbol)}`;
    } else if (r.kind === 'options') {
      window.location.hash = `#/options/${encodeURIComponent(r.symbol)}`;
    } else if (r.kind === 'ticker') {
      window.location.hash = `#/ticker/${encodeURIComponent(r.symbol)}`;
    } else {
      window.location.hash = `#/brief/${encodeURIComponent(r.symbol)}`;
    }
  }, []);
  return [route, navigate];
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || target.isContentEditable;
}

export function App(): JSX.Element {
  const [route, navigate] = useHashRoute();
  // Demo mode is on whenever the backend is unreachable or ?demo=1 is set.
  const demoForced = typeof window !== 'undefined' && /[?&]demo=1\b/.test(window.location.search);
  const [demo, setDemo] = useState<boolean>(demoForced || true);
  const [sessionEnded, setSessionEnded] = useState(false);
  // These hooks must be declared unconditionally so the order stays stable
  // across renders, even when a non-home route returns early below.
  const [active, setActive] = useState<string>('');
  const [tab, setTab] = useState<Tab>('briefing');
  const [query, setQuery] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [watchlistEntries, setWatchlistEntries] = useState<WatchlistEntry[]>([]);
  const [tickerPrefill, setTickerPrefill] = useState<string>('');
  const tickerInputRef = useRef<HTMLInputElement | null>(null);

  // Probe the API once to decide if we should drop demo mode.
  // On success, also fetch the watchlist and activate the first entry.
  useEffect(() => {
    if (demoForced) return;
    fetch('/api/health', { method: 'GET' })
      .then((r) => {
        if (!r.ok) return;
        setDemo(false);
        // Pick the first watchlist entry as the default active ticker.
        return fetch('/api/tickers')
          .then((wr) => wr.json())
          .then((data: { entries: WatchlistEntry[] }) => {
            const entries = Array.isArray(data?.entries) ? data.entries : [];
            const first = entries[0]?.profile?.symbol;
            if (first) setActive(first);
            setWatchlistEntries(entries);
          });
      })
      .catch(() => {
        /* stay in demo */
      });
  }, [demoForced]);

  useEffect(() => {
    const onExpired = (): void => setSessionEnded(true);
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  if (sessionEnded) {
    return (
      <div className="min-h-screen bg-app text-fg flex items-center justify-center px-6">
        <div className="max-w-xl border border-border-subtle bg-surface rounded p-6">
          <div className="text-sm font-semibold mb-2">Dashboard session ended</div>
          <p className="text-xs text-fg-secondary">
            Re-run <code>regard dashboard</code> from your terminal to start a new session.
          </p>
        </div>
      </div>
    );
  }

  const ticker: SampleTicker | undefined = useMemo(() => {
    // In demo mode with nothing active yet, fall back to the first sample ticker.
    const effectiveActive = active || (demo ? SAMPLE_TICKERS[0]!.symbol : '');
    return findSample(effectiveActive);
  }, [active, demo]);

  const paletteSymbols = useMemo(() => {
    const base = demo
      ? SAMPLE_TICKERS.map((sample) => ({ symbol: sample.symbol, name: sample.name }))
      : watchlistEntries.map((entry) => ({ symbol: entry.profile.symbol, name: entry.profile.name }));

    const deduped = new Map<string, { symbol: string; name: string }>();
    for (const row of base) {
      deduped.set(row.symbol.toUpperCase(), {
        symbol: row.symbol.toUpperCase(),
        name: row.name,
      });
    }
    return Array.from(deduped.values()).sort((left, right) => left.symbol.localeCompare(right.symbol));
  }, [demo, watchlistEntries]);

  const focusTickerInput = useCallback(() => {
    tickerInputRef.current?.focus();
    tickerInputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (
        event.key === '/' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        !isEditableTarget(event.target)
      ) {
        event.preventDefault();
        if (route.kind !== 'home') navigate('home');
        focusTickerInput();
        setTimeout(focusTickerInput, 0);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focusTickerInput, navigate, route.kind]);

  const paletteItems = useMemo<CommandPaletteItem[]>(() => {
    const viewItems: CommandPaletteItem[] = [
      {
        id: 'view-home',
        label: 'view home',
        group: 'Views',
        keywords: ['dashboard', 'overview'],
        onSelect: () => navigate('home'),
      },
      {
        id: 'view-watchlist',
        label: 'view watchlist',
        group: 'Views',
        keywords: ['tickers', 'symbols'],
        onSelect: () => navigate('watchlist'),
      },
      {
        id: 'view-paper',
        label: 'view paper',
        group: 'Views',
        keywords: ['paper', 'positions', 'orders'],
        onSelect: () => navigate('paper'),
      },
      {
        id: 'view-settings',
        label: 'view settings',
        group: 'Views',
        keywords: ['provider', 'risk caps'],
        onSelect: () => navigate('settings'),
      },
      {
        id: 'ticker-focus',
        label: 'focus ticker bar',
        group: 'Views',
        keywords: ['/', 'add ticker'],
        onSelect: () => {
          navigate('home');
          setTimeout(focusTickerInput, 0);
        },
      },
    ];

    const watchlistItems: CommandPaletteItem[] = paletteSymbols.map((row) => ({
      id: `watch-${row.symbol}`,
      label: `watch ${row.symbol}`,
      group: 'Watchlist',
      keywords: [row.name, 'ticker', 'quote'],
      onSelect: () => {
        setActive(row.symbol);
        navigate('home');
      },
    }));

    const aiItems: CommandPaletteItem[] = paletteSymbols.flatMap((row) => [
      {
        id: `brief-${row.symbol}`,
        label: `briefing ${row.symbol}`,
        group: 'AI',
        keywords: [row.name, 'analysis', 'brief'],
        onSelect: () => navigate({ kind: 'brief', symbol: row.symbol }),
      },
      {
        id: `plan-${row.symbol}`,
        label: `plan ${row.symbol}`,
        group: 'AI',
        keywords: [row.name, 'options', 'strategy'],
        onSelect: () => navigate({ kind: 'plan', symbol: row.symbol }),
      },
      {
        id: `add-${row.symbol}`,
        label: `add ${row.symbol}`,
        group: 'AI',
        keywords: [row.name, 'ticker', 'validate'],
        onSelect: () => {
          navigate('home');
          setTickerPrefill(row.symbol);
          setTimeout(focusTickerInput, 0);
        },
      },
    ]);

    return [...viewItems, ...watchlistItems, ...aiItems];
  }, [focusTickerInput, navigate, paletteSymbols]);

  const commandPalette = (
    <CommandPalette open={paletteOpen} items={paletteItems} onClose={() => setPaletteOpen(false)} />
  );

  if (route.kind === 'settings') {
    return (
      <>
        <Settings onClose={() => navigate('home')} />
        {commandPalette}
      </>
    );
  }
  if (route.kind === 'watchlist') {
    return (
      <>
        <WatchlistRoute onClose={() => navigate('home')} />
        {commandPalette}
      </>
    );
  }
  if (route.kind === 'paper') {
    return (
      <>
        <PaperRoute onClose={() => navigate('home')} />
        {commandPalette}
      </>
    );
  }
  if (route.kind === 'brief') {
    return (
      <>
        <Brief symbol={route.symbol} onClose={() => navigate('home')} />
        {commandPalette}
      </>
    );
  }
  if (route.kind === 'plan') {
    return (
      <>
        <Plan symbol={route.symbol} onClose={() => navigate('home')} />
        {commandPalette}
      </>
    );
  }
  if (route.kind === 'options') {
    return (
      <>
        <Options symbol={route.symbol} onClose={() => navigate('home')} />
        {commandPalette}
      </>
    );
  }
  if (route.kind === 'ticker') {
    return (
      <>
        <TickerRoute symbol={route.symbol} demo={demo} onClose={() => navigate('home')} />
        {commandPalette}
      </>
    );
  }

  return (
    <div className="min-h-screen bg-app text-fg">
      <TopBar
        demo={demo}
        onOpenSettings={() => navigate('settings')}
        onOpenWatchlist={() => navigate('watchlist')}
        onOpenPaper={() => navigate('paper')}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      <div className="max-w-7xl mx-auto px-6 py-4 grid grid-cols-12 gap-6">
        {/* Sidebar: validated watchlist + filter + calendar strip */}
        <aside className="col-span-12 md:col-span-3 space-y-4">
          <TickerIntake
            demo={demo}
            onPick={setActive}
            inputRef={tickerInputRef}
            prefill={tickerPrefill}
            onEntriesChange={setWatchlistEntries}
          />
          <Watchlist
            active={active}
            onPick={setActive}
            query={query}
            setQuery={setQuery}
            demo={demo}
          />
          <CalendarStrip />
        </aside>

        {/* Main column */}
        <main className="col-span-12 md:col-span-9 space-y-4">
          {ticker ? (
            <>
              <QuoteHeader t={ticker} demo={demo} />
              <TabBar tab={tab} setTab={setTab} />
              {tab === 'briefing' && <BriefingTab t={ticker} />}
              {tab === 'sentiment' && <SentimentTab t={ticker} demo={demo} />}
              {tab === 'news' && <NewsTab t={ticker} demo={demo} />}
              {tab === 'recommendation' && <RecommendationTab t={ticker} demo={demo} />}
              {tab === 'calendar' && <CalendarTab t={ticker} />}
              {tab === 'chart' && <ChartTab t={ticker} demo={demo} />}
              {tab === 'tech' && <TechTab t={ticker} demo={demo} />}
            </>
          ) : (
            <div className="text-fg-muted text-sm">No ticker selected.</div>
          )}
        </main>
      </div>
      {commandPalette}
    </div>
  );
}
