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

if (filter !== null && filter !== 'tickers') {
  console.error(`Unsupported --filter value: ${filter}`);
  console.error('Supported values: tickers');
  process.exit(1);
}

if (filter === null) {
  console.error('Missing --filter. Example: npm run test:live -- --filter=tickers');
  process.exit(1);
}

const forwarded = args.filter((arg, idx) => {
  if (arg === '--filter') return false;
  if (idx > 0 && args[idx - 1] === '--filter') return false;
  return !arg.startsWith('--filter=');
});

const run = spawnSync(
  'npm',
  ['--workspace', '@regardedtrader/core', 'run', 'test:live:tickers', '--', ...forwarded],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      RUN_LIVE_TICKER_TESTS: '1',
    },
  },
);

if (run.error) {
  throw run.error;
}

process.exit(run.status ?? 1);
