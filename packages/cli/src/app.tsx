import React from 'react';
import { Box, Text } from 'ink';
import { BriefingScreen } from './screens/briefing.js';
import { QuoteScreen } from './screens/quote.js';
import { PlanScreen } from './screens/plan.js';
import { DashboardScreen } from './screens/dashboard.js';

export interface AppProps {
  command: string;
  args: string[];
  serverUrl: string;
}

export function App({ command, args, serverUrl }: AppProps) {
  switch (command) {
    case 'briefing':
      return <BriefingScreen symbol={args[0] ?? ''} serverUrl={serverUrl} />;
    case 'quote':
      return <QuoteScreen symbol={args[0] ?? ''} serverUrl={serverUrl} />;
    case 'plan':
      return <PlanScreen symbol={args[0] ?? ''} serverUrl={serverUrl} />;
    case 'dashboard':
      return <DashboardScreen serverUrl={serverUrl} />;
    default:
      return (
        <Box flexDirection="column">
          <Text color="red">Unknown command: {command}</Text>
          <Text>Run with --help for usage.</Text>
        </Box>
      );
  }
}
