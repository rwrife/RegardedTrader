#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ACTIONS = ['BUY', 'SELL', 'HOLD', 'AVOID'];
const HORIZONS_DAYS = [1, 5];
const HOLD_BAND = 0.01;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshotsRoot = args.root ?? defaultSnapshotsRoot();
  const outDir =
    args.outDir ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'reports');
  const symbolsFilter = args.symbol
    ? new Set(args.symbol.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))
    : null;

  const symbols = await findSymbols(snapshotsRoot, symbolsFilter);
  if (symbols.length === 0) {
    throw new Error(`No symbol snapshot directories found under ${snapshotsRoot}`);
  }

  const aggregate = makeAggregate();
  const perSymbol = [];

  for (const symbol of symbols) {
    const [recs, quotes] = await Promise.all([
      loadRecommendations(snapshotsRoot, symbol),
      loadQuotes(snapshotsRoot, symbol),
    ]);
    if (recs.length === 0 || quotes.length === 0) {
      perSymbol.push({
        symbol,
        recCount: recs.length,
        quoteCount: quotes.length,
        byHorizon: makeAggregate(),
      });
      continue;
    }
    const byHorizon = evaluateSymbol(recs, quotes);
    foldAggregate(aggregate, byHorizon);
    perSymbol.push({
      symbol,
      recCount: recs.length,
      quoteCount: quotes.length,
      byHorizon,
    });
  }

  await fs.mkdir(outDir, { recursive: true });
  const reportPath = join(outDir, `recommender-eval-${stampForFile(new Date())}.md`);
  const markdown = renderReport({
    generatedAt: new Date().toISOString(),
    snapshotsRoot,
    symbols,
    perSymbol,
    aggregate,
  });
  await fs.writeFile(reportPath, markdown, 'utf8');
  console.log(`Recommender eval report written: ${reportPath}`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (!cur.startsWith('--')) continue;
    const key = cur.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[key] = val;
  }
  return out;
}

function defaultSnapshotsRoot() {
  const home = process.env.REGARDEDTRADER_HOME || join(homedir(), '.regardedtrader');
  return join(home, 'snapshots');
}

async function findSymbols(root, filter) {
  let names = [];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const symbols = [];
  for (const name of names) {
    if (filter && !filter.has(name.toUpperCase())) continue;
    const full = join(root, name);
    const st = await fs.stat(full).catch(() => null);
    if (!st?.isDirectory()) continue;
    symbols.push(name.toUpperCase());
  }
  symbols.sort();
  return symbols;
}

async function loadRecommendations(root, symbol) {
  const dir = join(root, symbol);
  const files = await gatherFiles(dir, /^recommendations(?:-\d{4}-\d{2}-\d{2})?\.jsonl(?:\.gz)?$/);
  const out = [];
  for (const file of files) {
    for await (const line of readJsonlFile(file)) {
      const action = line?.equity?.action;
      const generatedAt = line?.generatedAt;
      if (typeof action !== 'string' || typeof generatedAt !== 'string') continue;
      const t = Date.parse(generatedAt);
      if (!Number.isFinite(t)) continue;
      out.push({ action: action.toUpperCase(), t });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

async function loadQuotes(root, symbol) {
  const dir = join(root, symbol);
  const files = await gatherFiles(dir, /^quote(?:-\d{4}-\d{2}-\d{2})?\.jsonl(?:\.gz)?$/);
  const out = [];
  for (const file of files) {
    for await (const line of readJsonlFile(file)) {
      const ts = typeof line?.ts === 'string' ? Date.parse(line.ts) : NaN;
      const price = extractQuotePrice(line?.data);
      if (!Number.isFinite(ts) || !Number.isFinite(price) || price <= 0) continue;
      out.push({ t: ts, price });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return dedupeQuotes(out);
}

function extractQuotePrice(data) {
  if (!data || typeof data !== 'object') return NaN;
  const quotePrice = data?.quote?.price;
  if (typeof quotePrice === 'number') return quotePrice;
  if (typeof data?.price === 'number') return data.price;
  if (typeof data?.last?.price === 'number') return data.last.price;
  return NaN;
}

function dedupeQuotes(points) {
  const map = new Map();
  for (const point of points) map.set(point.t, point.price);
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([t, price]) => ({ t, price }));
}

async function gatherFiles(dir, pattern) {
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => pattern.test(n))
    .sort()
    .map((n) => join(dir, n));
}

async function* readJsonlFile(filePath) {
  const gz = filePath.endsWith('.gz');
  const stream = createReadStream(filePath);
  const input = gz ? stream.pipe(createGunzip()) : stream;
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed);
    } catch {
      // skip malformed lines
    }
  }
}

function evaluateSymbol(recs, quotes) {
  const byHorizon = makeAggregate();
  const quoteTimes = quotes.map((q) => q.t);

  for (const rec of recs) {
    if (!ACTIONS.includes(rec.action)) continue;
    const baseIdx = indexAtOrBefore(quoteTimes, rec.t);
    if (baseIdx < 0) continue;
    const base = quotes[baseIdx].price;
    if (!(base > 0)) continue;

    for (const days of HORIZONS_DAYS) {
      const target = rec.t + days * 24 * 60 * 60 * 1000;
      const fwdIdx = indexAtOrAfter(quoteTimes, target);
      if (fwdIdx < 0) continue;
      const fwd = quotes[fwdIdx].price;
      const ret = (fwd - base) / base;
      applyScore(byHorizon, days, rec.action, ret);
    }
  }
  return byHorizon;
}

function applyScore(byHorizon, days, action, ret) {
  const bucket = byHorizon[days][action];
  bucket.count += 1;
  bucket.sumReturn += ret;
  if (isHit(action, ret)) bucket.hits += 1;
  bucket.sumExpectancy += expectancy(action, ret);
}

function isHit(action, ret) {
  if (action === 'BUY') return ret > 0;
  if (action === 'SELL') return ret < 0;
  return Math.abs(ret) <= HOLD_BAND;
}

function expectancy(action, ret) {
  if (action === 'BUY') return ret;
  if (action === 'SELL') return -ret;
  return -Math.abs(ret);
}

function makeAggregate() {
  return Object.fromEntries(
    HORIZONS_DAYS.map((d) => [
      d,
      Object.fromEntries(
        ACTIONS.map((a) => [a, { count: 0, hits: 0, sumReturn: 0, sumExpectancy: 0 }]),
      ),
    ]),
  );
}

function foldAggregate(target, from) {
  for (const days of HORIZONS_DAYS) {
    for (const action of ACTIONS) {
      const t = target[days][action];
      const s = from[days][action];
      t.count += s.count;
      t.hits += s.hits;
      t.sumReturn += s.sumReturn;
      t.sumExpectancy += s.sumExpectancy;
    }
  }
}

function indexAtOrBefore(sorted, value) {
  let lo = 0;
  let hi = sorted.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function indexAtOrAfter(sorted, value) {
  let lo = 0;
  let hi = sorted.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] >= value) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

function renderReport({ generatedAt, snapshotsRoot, symbols, perSymbol, aggregate }) {
  const lines = [];
  lines.push('# Recommender Offline Eval');
  lines.push('');
  lines.push(`Generated at: ${generatedAt}`);
  lines.push(`Snapshots root: \`${snapshotsRoot}\``);
  lines.push(`Symbols evaluated: ${symbols.join(', ')}`);
  lines.push('');
  lines.push('Method: each recommendation is scored versus cached quote moves at +1d and +5d.');
  lines.push(`HOLD/AVOID hit band: ±${(HOLD_BAND * 100).toFixed(1)}%.`);
  lines.push('');
  lines.push('## Aggregate');
  lines.push('');
  for (const days of HORIZONS_DAYS) {
    lines.push(`### +${days}d`);
    lines.push('');
    lines.push('| Action | N | Hit Rate | Avg Return | Expectancy |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const action of ACTIONS) {
      const row = aggregate[days][action];
      lines.push(
        `| ${action} | ${row.count} | ${fmtPct(safeDiv(row.hits, row.count))} | ${fmtPct(
          safeDiv(row.sumReturn, row.count),
        )} | ${fmtPct(safeDiv(row.sumExpectancy, row.count))} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Per Symbol');
  lines.push('');
  for (const entry of perSymbol) {
    lines.push(`### ${entry.symbol}`);
    lines.push('');
    lines.push(`Recommendations parsed: ${entry.recCount}`);
    lines.push(`Quotes parsed: ${entry.quoteCount}`);
    lines.push('');
    for (const days of HORIZONS_DAYS) {
      lines.push(`#### +${days}d`);
      lines.push('');
      lines.push('| Action | N | Hit Rate | Avg Return | Expectancy |');
      lines.push('|---|---:|---:|---:|---:|');
      for (const action of ACTIONS) {
        const row = entry.byHorizon[days][action];
        lines.push(
          `| ${action} | ${row.count} | ${fmtPct(safeDiv(row.hits, row.count))} | ${fmtPct(
            safeDiv(row.sumReturn, row.count),
          )} | ${fmtPct(safeDiv(row.sumExpectancy, row.count))} |`,
        );
      }
      lines.push('');
    }
  }
  return lines.join('\n') + '\n';
}

function safeDiv(a, b) {
  if (!b) return 0;
  return a / b;
}

function fmtPct(x) {
  return `${(x * 100).toFixed(2)}%`;
}

function stampForFile(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

main().catch((err) => {
  console.error(`[eval:recommender] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
