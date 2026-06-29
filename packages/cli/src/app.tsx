import React from 'react';
import { Box, Text } from 'ink';
import { BriefingScreen } from './screens/briefing.js';
import { BriefScreen } from './screens/brief.js';
import { QuoteScreen } from './screens/quote.js';
import { TechScreen } from './screens/tech.js';
import { PlanScreen } from './screens/plan.js';
import { DashboardScreen } from './screens/dashboard.js';
import { ConfigScreen } from './screens/config.js';
import { AddScreen } from './screens/add.js';
import { ListScreen, RemoveScreen } from './screens/watchlist.js';
import { WatchScreen } from './screens/watch.js';
import { OptionsScreen } from './screens/options.js';

export interface AppProps {
  command: string;
  args: string[];
  serverUrl: string;
  flags?: {
    refresh?: boolean;
    thesis?: string;
    maxLoss?: number;
    expiry?: string;
  };
}

export function App({ command, args, serverUrl, flags }: AppProps) {
  switch (command) {
    case 'options':
      return (
        <OptionsScreen
          symbol={args[0] ?? ''}
          serverUrl={serverUrl}
          expiry={flags?.expiry}
        />
      );
    case 'briefing':
      return <BriefingScreen symbol={args[0] ?? ''} serverUrl={serverUrl} />;
    case 'brief':
      return (
        <BriefScreen
          symbol={args[0] ?? ''}
          serverUrl={serverUrl}
          thesis={flags?.thesis}
          maxLossUsd={flags?.maxLoss}
          expiry={flags?.expiry}
        />
      );
    case 'quote':
      return <QuoteScreen symbol={args[0] ?? ''} serverUrl={serverUrl} />;
    case 'tech':
      return <TechScreen symbol={args[0] ?? ''} serverUrl={serverUrl} />;
    case 'plan':
      return <PlanScreen symbol={args[0] ?? ''} serverUrl={serverUrl} />;
    case 'dashboard':
      return <DashboardScreen serverUrl={serverUrl} />;
    case 'config':
      return <ConfigScreen sub={args[0]} testProviderId={args[1]} serverUrl={serverUrl} />;
    case 'add':
      return (
        <AddScreen
          symbols={args.map((a) => a.toUpperCase())}
          refresh={!!flags?.refresh}
          serverUrl={serverUrl}
        />
      );
    case 'ls':
      return <ListScreen serverUrl={serverUrl} />;
    case 'rm':
      return <RemoveScreen symbol={args[0] ?? ''} serverUrl={serverUrl} />;
    case 'watch':
      return <WatchScreen args={args} serverUrl={serverUrl} />;
    default:
      return (
        <Box flexDirection="column">
          <Text color="red">Unknown command: {command}</Text>
          <Text>Run with --help for usage.</Text>
        </Box>
      );
  }
}
