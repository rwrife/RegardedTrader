/**
 * WebSearch client interface.
 *
 * Why an abstraction instead of calling fetch directly inside the validator?
 * - Tests must run without network. Validators inject a fake client.
 * - In production we may swap DuckDuckGo HTML for an OpenAI tool call, a
 *   Brave/Tavily search API, or a market-data vendor's name-search.
 *
 * The interface is intentionally tiny: a query in, a list of results out.
 */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearch {
  search(query: string, opts?: { limit?: number }): Promise<WebSearchResult[]>;
}

/**
 * Default implementation: scrapes DuckDuckGo's HTML endpoint.
 *
 * Notes:
 * - No API key required, no per-user signup, no telemetry.
 * - Output is best-effort HTML parsing; we keep the parser deliberately small
 *   and tolerant. If the markup changes, downstream tests with mocked clients
 *   still pass and we swap the parser.
 * - User-Agent is set to a plain desktop browser string to avoid being served
 *   the JavaScript-only homepage.
 */
export class DuckDuckGoSearch implements WebSearch {
  constructor(
    private readonly endpoint = 'https://html.duckduckgo.com/html/',
    private readonly userAgent = 'Mozilla/5.0 (X11; Linux x86_64) RegardedTrader/0.1 (research)',
    private readonly timeoutMs = 8_000,
  ) {}

  async search(query: string, opts: { limit?: number } = {}): Promise<WebSearchResult[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 8, 25));
    const body = new URLSearchParams({ q: query }).toString();

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    let html: string;
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': this.userAgent,
          accept: 'text/html',
        },
        body,
        signal: ctl.signal,
      });
      if (!res.ok) {
        throw new Error(`DuckDuckGo HTML returned ${res.status} ${res.statusText}`);
      }
      html = await res.text();
    } finally {
      clearTimeout(t);
    }

    return parseDdgHtml(html).slice(0, limit);
  }
}

/**
 * Tolerant DDG HTML result parser. Pulls anchors that look like result links
 * and the immediately-following snippet block. Handles the common
 * `result__a` / `result__snippet` layout used by html.duckduckgo.com.
 *
 * Exported for tests.
 */
export function parseDdgHtml(html: string): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  // Pair: anchor with class="result__a" then optional snippet "result__snippet".
  const blockRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>)?/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const rawUrl = decodeHtmlEntities(m[1] ?? '');
    const title = stripTags(m[2] ?? '').trim();
    const snippet = stripTags(m[3] ?? '').trim();
    const url = unwrapDdgRedirect(rawUrl);
    if (!url || !title) continue;
    out.push({ title, url, snippet });
    if (out.length >= 50) break;
  }
  return out;
}

function stripTags(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]+>/g, ''));
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function unwrapDdgRedirect(href: string): string | null {
  if (!href) return null;
  // DDG sometimes returns //duckduckgo.com/l/?uddg=<encoded>
  try {
    const normalized = href.startsWith('//') ? `https:${href}` : href;
    const u = new URL(normalized, 'https://duckduckgo.com');
    if (u.pathname === '/l/' && u.searchParams.has('uddg')) {
      return decodeURIComponent(u.searchParams.get('uddg') ?? '');
    }
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
    return null;
  } catch {
    return null;
  }
}
