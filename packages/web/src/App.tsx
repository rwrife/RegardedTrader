import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { SAMPLE_TICKERS, findSample, type SampleTicker } from './sample-data.js';
import { Settings } from './routes/settings.js';
import { Brief } from './routes/brief.js';
import { Plan } from './routes/plan.js';
import { Options } from './routes/options.js';
import { Watchlist as WatchlistRoute } from './routes/watchlist.js';
import { TopBar } from './components/TopBar.js';
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
import type { Tab } from './types.js';

// Tiny hash-based router so the dashboard stays a single bundle without
// pulling in react-router. Routes: `#/` (default), `#/settings`,
// `#/brief/:symbol` (full Orchestrator briefing pipeline, issue #139),
// `#/plan/:symbol` (OptionsStrategist trade-plan view, issue #113),
// `#/options/:symbol` (options chain explorer).
type Route =
  | { kind: 'home' }
  | { kind: 'settings' }
  | { kind: 'brief'; symbol: string }
  | { kind: 'plan'; symbol: string }
  | { kind: 'options'; symbol: string }
  | { kind: 'watchlist' };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '').replace(/^\/+/, '');
  if (raw.startsWith('settings')) return { kind: 'settings' };
  if (raw.startsWith('watchlist')) return { kind: 'watchlist' };
  const briefMatch = raw.match(/^brief\/([^/?#]+)/);
  if (briefMatch) return { kind: 'brief', symbol: decodeURIComponent(briefMatch[1]!).toUpperCase() };
  const planMatch = raw.match(/^plan\/([^/?#]+)/);
  if (planMatch) return { kind: 'plan', symbol: decodeURIComponent(planMatch[1]!).toUpperCase() };
  const optionsMatch = raw.match(/^options\/([^/?#]+)/);
  if (optionsMatch)
    return { kind: 'options', symbol: decodeURIComponent(optionsMatch[1]!).toUpperCase() };
  return { kind: 'home' };
}

type NavTarget =
  | 'home'
  | 'settings'
  | 'watchlist'
  | { kind: 'brief'; symbol: string }
  | { kind: 'plan'; symbol: string }
  | { kind: 'options'; symbol: string };

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
    } else if (r === 'home') {
      window.location.hash = '#/';
    } else if (r.kind === 'plan') {
      window.location.hash = `#/plan/${encodeURIComponent(r.symbol)}`;
    } else if (r.kind === 'options') {
      window.location.hash = `#/options/${encodeURIComponent(r.symbol)}`;
    } else {
      window.location.hash = `#/brief/${encodeURIComponent(r.symbol)}`;
    }
  }, []);
  return [route, navigate];
}

export function App(): JSX.Element {
  const [route, navigate] = useHashRoute();
  // Demo mode is on whenever the backend is unreachable or ?demo=1 is set.
  const demoForced = typeof window !== 'undefined' && /[?&]demo=1\b/.test(window.location.search);
  const [demo, setDemo] = useState<boolean>(demoForced || true);
  // These hooks must be declared unconditionally so the order stays stable
  // across renders, even when a non-home route returns early below.
  const [active, setActive] = useState<string>(SAMPLE_TICKERS[0]!.symbol);
  const [tab, setTab] = useState<Tab>('briefing');
  const [query, setQuery] = useState('');

  // Probe the API once to decide if we should drop demo mode.
  useEffect(() => {
    if (demoForced) return;
    fetch('/api/health', { method: 'GET' })
      .then((r) => {
        if (r.ok) setDemo(false);
      })
      .catch(() => {
        /* stay in demo */
      });
  }, [demoForced]);

  const ticker: SampleTicker | undefined = useMemo(() => findSample(active), [active]);

  if (route.kind === 'settings') {
    return <Settings onClose={() => navigate('home')} />;
  }
  if (route.kind === 'watchlist') {
    return <WatchlistRoute onClose={() => navigate('home')} />;
  }
  if (route.kind === 'brief') {
    return <Brief symbol={route.symbol} onClose={() => navigate('home')} />;
  }
  if (route.kind === 'plan') {
    return <Plan symbol={route.symbol} onClose={() => navigate('home')} />;
  }
  if (route.kind === 'options') {
    return <Options symbol={route.symbol} onClose={() => navigate('home')} />;
  }

  return (
    <div className="min-h-screen bg-app text-fg">
      <TopBar demo={demo} onOpenSettings={() => navigate('settings')} onOpenWatchlist={() => navigate('watchlist')} />

      <div className="max-w-7xl mx-auto px-6 py-4 grid grid-cols-12 gap-6">
        {/* Sidebar: validated watchlist + filter + calendar strip */}
        <aside className="col-span-12 md:col-span-3 space-y-4">
          <TickerIntake demo={demo} />
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
              {tab === 'sentiment' && <SentimentTab t={ticker} />}
              {tab === 'news' && <NewsTab t={ticker} />}
              {tab === 'recommendation' && <RecommendationTab t={ticker} />}
              {tab === 'calendar' && <CalendarTab t={ticker} />}
              {tab === 'chart' && <ChartTab t={ticker} demo={demo} />}
              {tab === 'tech' && <TechTab t={ticker} demo={demo} />}
            </>
          ) : (
            <div className="text-fg-muted text-sm">No ticker selected.</div>
          )}
        </main>
      </div>
    </div>
  );
}
