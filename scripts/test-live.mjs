import { spawnSync } from 'node:child_process';

function parseFilter(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) continue;
    if (token.startsWith('--filter=')) {
      return token.slice('--filter='.length);
    }
    if (token === '--filter') {
      return argv[i + 1] ?? null;
    }
  }
  return null;
}

const args = process.argv.slice(2);
const filter = parseFilter(args);
const supportedFilters = new Set(['tickers', 'polling', 'calendar']);

if (filter !== null && !supportedFilters.has(filter)) {
  console.error(`Unsupported --filter value: ${filter}`);
  console.error(`Supported values: ${Array.from(supportedFilters).join(', ')}`);
  process.exit(1);
}

if (filter === null) {
  console.error('Missing --filter. Example: npm run test:live -- --filter=calendar');
  process.exit(1);
}

const forwarded = args.filter((arg, idx) => {
  if (arg === '--filter') return false;
  if (idx > 0 && args[idx - 1] === '--filter') return false;
  return !arg.startsWith('--filter=');
});

const testByFilter = {
  tickers: 'test:live:tickers',
  polling: 'test:live:polling',
  calendar: 'test:live:calendar',
};

const run = spawnSync(
  'npm',
  ['--workspace', '@regardedtrader/core', 'run', testByFilter[filter], '--', ...forwarded],
  {
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      RUN_LIVE_TICKER_TESTS: filter === 'tickers' ? '1' : process.env.RUN_LIVE_TICKER_TESTS,
      RUN_LIVE_POLLING_TESTS: filter === 'polling' ? '1' : process.env.RUN_LIVE_POLLING_TESTS,
      RUN_LIVE_CALENDAR_TESTS: filter === 'calendar' ? '1' : process.env.RUN_LIVE_CALENDAR_TESTS,
    },
  },
);

if (run.error) {
  throw run.error;
}

process.exit(run.status ?? 1);
