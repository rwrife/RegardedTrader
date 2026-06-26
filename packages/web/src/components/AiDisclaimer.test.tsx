import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { AiDisclaimer } from './AiDisclaimer.js';
import { DISCLAIMER } from '@regardedtrader/core/constants';

afterEach(() => cleanup());

describe('AiDisclaimer', () => {
  it('renders the canonical core DISCLAIMER string', () => {
    render(<AiDisclaimer />);
    const el = screen.getByTestId('ai-disclaimer');
    expect(el.textContent).toBe(DISCLAIMER);
  });

  it('mentions "not financial advice" so a grep audit succeeds', () => {
    render(<AiDisclaimer />);
    const el = screen.getByTestId('ai-disclaimer');
    expect(el.textContent?.toLowerCase()).toContain('not financial advice');
  });

  it('uses the default footer styling when no overrides are provided', () => {
    render(<AiDisclaimer />);
    const el = screen.getByTestId('ai-disclaimer');
    expect(el.className).toContain('text-fg-muted');
    expect(el.className).toContain('italic');
    expect(el.className).toContain('mt-6');
  });

  it('respects marginTop="none"', () => {
    render(<AiDisclaimer marginTop="none" />);
    const el = screen.getByTestId('ai-disclaimer');
    expect(el.className).not.toContain('mt-6');
    expect(el.className).not.toContain('mt-2');
  });

  it('respects a fully custom className override', () => {
    render(<AiDisclaimer className="custom-x" />);
    const el = screen.getByTestId('ai-disclaimer');
    expect(el.className).toBe('custom-x');
  });
});
