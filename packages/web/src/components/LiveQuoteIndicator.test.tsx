import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { LiveQuoteIndicator } from './LiveQuoteIndicator.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-02T15:00:00.000Z'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('LiveQuoteIndicator (#28)', () => {
  it('renders waiting state when no quote has landed yet', () => {
    render(<LiveQuoteIndicator lastUpdatedAt={null} isLoading={false} error={null} />);
    expect(screen.getByText('waiting…')).toBeDefined();
  });

  it('surfaces provider setup hint on no-provider errors', () => {
    render(
      <LiveQuoteIndicator
        lastUpdatedAt={null}
        isLoading={false}
        error="No market-data provider configured"
      />,
    );
    expect(screen.getByText('⚠ configure provider in Settings')).toBeDefined();
  });

  it('shows live freshness text without stale dot inside regular-session threshold', () => {
    render(
      <LiveQuoteIndicator
        lastUpdatedAt={new Date('2026-01-02T14:59:42.000Z')}
        isLoading={false}
        error={null}
        marketState="REGULAR"
      />,
    );

    expect(screen.getByText('live · updated 18s ago')).toBeDefined();
    expect(screen.queryByTestId('live-quote-stale-dot')).toBeNull();
  });

  it('shows a warn dot when quote age exceeds 2× regular cadence', () => {
    render(
      <LiveQuoteIndicator
        lastUpdatedAt={new Date('2026-01-02T14:59:39.000Z')}
        isLoading={false}
        error={null}
        marketState="REGULAR"
      />,
    );

    expect(screen.getByText('live · updated 21s ago')).toBeDefined();
    expect(screen.getByTestId('live-quote-stale-dot').className).toMatch(/bg-warn/);
  });

  it('uses the slower off-hours threshold before marking stale', () => {
    render(
      <LiveQuoteIndicator
        lastUpdatedAt={new Date('2026-01-02T14:58:20.000Z')}
        isLoading={false}
        error={null}
        marketState="POST"
      />,
    );

    expect(screen.getByText('live · updated 100s ago')).toBeDefined();
    expect(screen.queryByTestId('live-quote-stale-dot')).toBeNull();
  });

  it('marks off-hours quotes stale after 120 seconds', () => {
    render(
      <LiveQuoteIndicator
        lastUpdatedAt={new Date('2026-01-02T14:57:59.000Z')}
        isLoading={false}
        error={null}
        marketState="CLOSED"
      />,
    );

    expect(screen.getByText('live · updated 121s ago')).toBeDefined();
    expect(screen.getByTestId('live-quote-stale-dot')).toBeDefined();
  });
});
