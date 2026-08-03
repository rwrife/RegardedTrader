import React, { useEffect, useMemo, useState } from 'react';
import type { SampleTicker } from '../../sample-data.js';
import { AUTH_STORAGE_KEY } from '../../auth.js';
import { AiCard } from '../../components/primitives/AiCard.js';
import { Sparkline } from '../../components/primitives/Sparkline.js';
import { AiDisclaimer } from '../../components/AiDisclaimer.js';

interface SentimentBySource {
  score: number;
  volume: number;
}

interface SentimentSnapshot {
  symbol: string;
  score: number;
  confidence: number;
  volume: number;
  bySource: Record<string, SentimentBySource>;
}

interface MentionRow {
  id: string;
  source: string;
  body: string;
  url: string;
  publishedLabel: string;
  score: number;
  sentimentLabel: 'bullish' | 'neutral' | 'bearish';
}

function sourceLabel(src: string): string {
  return src.replace('googleNewsOpinion', 'google-news opinion');
}

function relativeLabel(publishedAt: string): string {
  const delta = Math.max(0, Date.now() - Date.parse(publishedAt));
  const mins = Math.round(delta / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function fromSample(t: SampleTicker): MentionRow[] {
  return t.mentions.map((m) => ({
    id: m.id,
    source: m.source,
    body: m.body,
    url: m.url || '#',
    publishedLabel: `${m.publishedAtMinutesAgo}m ago`,
    score: m.score,
    sentimentLabel: m.score >= 0.15 ? 'bullish' : m.score <= -0.15 ? 'bearish' : 'neutral',
  }));
}

function asSnapshot(raw: unknown): SentimentSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const x = raw as {
    symbol?: unknown;
    score?: unknown;
    confidence?: unknown;
    volume?: unknown;
    bySource?: unknown;
  };
  if (
    typeof x.symbol !== 'string' ||
    typeof x.score !== 'number' ||
    typeof x.confidence !== 'number' ||
    typeof x.volume !== 'number' ||
    !x.bySource ||
    typeof x.bySource !== 'object'
  ) {
    return null;
  }
  const bySource: Record<string, SentimentBySource> = {};
  for (const [k, v] of Object.entries(x.bySource as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const row = v as { score?: unknown; volume?: unknown };
    if (typeof row.score !== 'number' || typeof row.volume !== 'number') continue;
    bySource[k] = { score: row.score, volume: row.volume };
  }
  return {
    symbol: x.symbol,
    score: x.score,
    confidence: x.confidence,
    volume: x.volume,
    bySource,
  };
}

function asMentionRows(raw: unknown): MentionRow[] {
  if (!raw || typeof raw !== 'object') return [];
  const payload = raw as { items?: unknown };
  if (!Array.isArray(payload.items)) return [];
  const rows: MentionRow[] = [];
  for (const item of payload.items) {
    if (!item || typeof item !== 'object') continue;
    const x = item as {
      source?: unknown;
      sourceId?: unknown;
      text?: unknown;
      title?: unknown;
      url?: unknown;
      publishedAt?: unknown;
      score?: unknown;
      sentiment?: { score?: unknown; label?: unknown };
    };
    if (typeof x.source !== 'string' || typeof x.publishedAt !== 'string') continue;
    const score =
      typeof x.sentiment?.score === 'number'
        ? x.sentiment.score
        : typeof x.score === 'number'
          ? x.score
          : 0;
    const label =
      x.sentiment?.label === 'bullish' ||
      x.sentiment?.label === 'bearish' ||
      x.sentiment?.label === 'neutral'
        ? x.sentiment.label
        : score >= 0.15
          ? 'bullish'
          : score <= -0.15
            ? 'bearish'
            : 'neutral';
    const body = typeof x.text === 'string' ? x.text : typeof x.title === 'string' ? x.title : '';
    rows.push({
      id:
        typeof x.sourceId === 'string' ? `${x.source}:${x.sourceId}` : `${x.source}:${rows.length}`,
      source: x.source,
      body,
      url: typeof x.url === 'string' ? x.url : '#',
      publishedLabel: relativeLabel(x.publishedAt),
      score,
      sentimentLabel: label,
    });
  }
  return rows;
}

export function SentimentTab({
  t,
  demo = false,
}: {
  t: SampleTicker;
  demo?: boolean;
}): JSX.Element {
  const [liveSnapshot, setLiveSnapshot] = useState<SentimentSnapshot | null>(null);
  const [sparkline, setSparkline] = useState<number[]>(t.sentiment.sparkline);
  const [mentions, setMentions] = useState<MentionRow[]>(() => fromSample(t));
  const [pulse, setPulse] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setLiveSnapshot(null);
    setSparkline(t.sentiment.sparkline);
    setMentions(fromSample(t));
    setLoadError(null);
    if (demo) return;
    let cancelled = false;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    Promise.all([
      fetch(`/api/sentiment/${encodeURIComponent(t.symbol)}/latest`),
      fetch(`/api/sentiment/${encodeURIComponent(t.symbol)}?since=${encodeURIComponent(since)}`),
      fetch(
        `/api/mentions/${encodeURIComponent(t.symbol)}?limit=20&since=${encodeURIComponent(since)}`,
      ),
    ])
      .then(async ([latestRes, rangeRes, mentionsRes]) => {
        if (cancelled) return;
        if (latestRes.ok) {
          const latest = asSnapshot((await latestRes.json()) as unknown);
          if (latest) setLiveSnapshot(latest);
        }
        if (rangeRes.ok) {
          const rangeJson = (await rangeRes.json()) as { items?: Array<{ score?: number }> };
          const scores = Array.isArray(rangeJson.items)
            ? rangeJson.items
                .map((it) => it?.score)
                .filter((v): v is number => typeof v === 'number')
            : [];
          if (scores.length > 0) setSparkline(scores.slice(-48));
        }
        if (mentionsRes.ok) {
          const rows = asMentionRows((await mentionsRes.json()) as unknown);
          if (rows.length > 0) setMentions(rows.slice(0, 10));
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [demo, t]);

  useEffect(() => {
    if (demo || typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    const token = window.sessionStorage.getItem(AUTH_STORAGE_KEY);
    const query = token ? `?t=${encodeURIComponent(token)}` : '';
    const es = new EventSource(`/api/events${query}`);
    const onUpdate = (ev: MessageEvent<string>): void => {
      try {
        const payload = JSON.parse(ev.data) as { symbol?: unknown; snapshot?: unknown };
        if (typeof payload.symbol !== 'string' || payload.symbol !== t.symbol) return;
        const next = asSnapshot(payload.snapshot);
        if (!next) return;
        setLiveSnapshot(next);
        setSparkline((prev) => [...prev.slice(-47), next.score]);
        setPulse(true);
      } catch {
        /* ignore malformed SSE frames */
      }
    };
    es.addEventListener('sentiment.update', onUpdate as EventListener);
    return () => {
      es.removeEventListener('sentiment.update', onUpdate as EventListener);
      es.close();
    };
  }, [demo, t.symbol]);

  useEffect(() => {
    if (!pulse) return;
    const id = setTimeout(() => setPulse(false), 900);
    return () => clearTimeout(id);
  }, [pulse]);

  const s = liveSnapshot ?? t.sentiment;
  const gaugePct = Math.max(0, Math.min(100, ((s.score + 1) / 2) * 100));
  const bySourceRows = useMemo(() => {
    const entries = Object.entries(s.bySource);
    const maxVol = Math.max(1, ...entries.map(([, row]) => row.volume));
    return entries
      .sort((a, b) => b[1].volume - a[1].volume)
      .map(([src, row]) => ({
        src,
        score: row.score,
        volume: row.volume,
        width: (row.volume / maxVol) * 100,
      }));
  }, [s.bySource]);

  return (
    <AiCard label="SENTIMENT">
      <div className={`mb-4 ${pulse ? 'sentiment-live-pulse' : ''}`} data-testid="sentiment-gauge">
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="text-[10px] font-mono tracking-wider text-fg-muted uppercase">
            Aggregate · {s.volume.toLocaleString()} mentions · conf{' '}
            {(s.confidence * 100).toFixed(0)}%
          </span>
          <span className={`num text-lg ${s.score >= 0 ? 'text-up' : 'text-down'}`}>
            {s.score >= 0 ? '+' : ''}
            {s.score.toFixed(2)}
          </span>
        </div>
        <div className="relative h-4">
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded bg-surface-2" />
          <div className="absolute inset-y-0 left-1/2 w-px bg-border-subtle" />
          <div
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-3 w-3 rounded-full border border-ai bg-app"
            style={{ left: `${gaugePct}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[10px] font-mono text-fg-muted">
          <span>-1</span>
          <span>0</span>
          <span>+1</span>
        </div>
      </div>

      <div className="mb-4">
        <div className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mb-1.5">
          24h sparkline
        </div>
        <Sparkline values={sparkline} />
      </div>

      <div>
        <h3 className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mb-2">
          Source breakdown
        </h3>
        <ul className="space-y-2">
          {bySourceRows.map((row) => (
            <li key={row.src} className="text-xs">
              <div className="flex items-center gap-2 mb-1">
                <span className="px-1.5 py-0.5 rounded bg-surface-2 text-[10px] font-mono uppercase">
                  {sourceLabel(row.src)}
                </span>
                <span className="num text-fg-muted">{row.volume.toLocaleString()} vol</span>
                <span className={`ml-auto num ${row.score >= 0 ? 'text-up' : 'text-down'}`}>
                  {row.score >= 0 ? '+' : ''}
                  {row.score.toFixed(2)}
                </span>
              </div>
              <div className="h-1.5 rounded bg-surface-2 overflow-hidden">
                <div
                  className={`h-full ${row.score >= 0 ? 'bg-up/80' : 'bg-down/80'}`}
                  style={{ width: `${row.width}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      </div>

      <h3 className="text-[10px] font-mono tracking-wider text-fg-muted uppercase mt-5 mb-2">
        Recent mentions
      </h3>
      {loadError && !demo && (
        <div className="mb-2 text-xs text-amber-300">
          Live sentiment feed unavailable: {loadError}
        </div>
      )}
      <ul className="space-y-2 text-sm">
        {mentions.map((m) => (
          <li key={m.id} className="border border-border-subtle/60 rounded p-2">
            <div className="flex items-center gap-2 text-[11px] text-fg-muted flex-wrap">
              <span className="px-1.5 py-0.5 rounded bg-surface-2 font-mono uppercase">
                {sourceLabel(m.source)}
              </span>
              <span>{m.publishedLabel}</span>
              <span className="text-fg-muted">user:</span>
              <span className="font-mono border border-border-subtle/40 rounded px-1 min-w-6">
                &nbsp;
              </span>
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono tracking-wider ${
                  m.sentimentLabel === 'bullish'
                    ? 'bg-up/10 text-up'
                    : m.sentimentLabel === 'bearish'
                      ? 'bg-down/10 text-down'
                      : 'bg-surface-2 text-fg-secondary'
                }`}
              >
                {m.sentimentLabel.toUpperCase()}
              </span>
              <span className={`ml-auto num ${m.score >= 0 ? 'text-up' : 'text-down'}`}>
                {m.score >= 0 ? '+' : ''}
                {m.score.toFixed(2)}
              </span>
            </div>
            <div className="mt-1 leading-relaxed">
              {m.body}{' '}
              <a
                href={m.url}
                target="_blank"
                rel="noreferrer"
                className="text-ai hover:underline text-xs"
              >
                ({sourceLabel(m.source)})
              </a>
            </div>
          </li>
        ))}
      </ul>
      <AiDisclaimer marginTop="md" />
    </AiCard>
  );
}
