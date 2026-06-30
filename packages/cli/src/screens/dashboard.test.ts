import { describe, expect, it } from 'vitest';
import { resolveDashboardUrl } from './dashboard.js';

describe('resolveDashboardUrl', () => {
  it('returns the running serverUrl in production (no hard-coded 5173)', () => {
    const url = resolveDashboardUrl({
      serverUrl: 'http://127.0.0.1:4317',
      nodeEnv: 'production',
    });
    expect(url).toBe('http://127.0.0.1:4317');
    expect(url).not.toContain('5173');
  });

  it('defaults to production semantics when nodeEnv is undefined', () => {
    const url = resolveDashboardUrl({ serverUrl: 'http://127.0.0.1:4317' });
    expect(url).toBe('http://127.0.0.1:4317');
  });

  it('prefers an explicit dev URL in development', () => {
    const url = resolveDashboardUrl({
      serverUrl: 'http://127.0.0.1:4317',
      nodeEnv: 'development',
      devUrl: 'http://127.0.0.1:5173',
    });
    expect(url).toBe('http://127.0.0.1:5173');
  });

  it('falls back to serverUrl in development when no dev URL is configured', () => {
    const url = resolveDashboardUrl({
      serverUrl: 'http://127.0.0.1:4317',
      nodeEnv: 'development',
    });
    expect(url).toBe('http://127.0.0.1:4317');
  });

  it('ignores blank/whitespace dev URLs', () => {
    const url = resolveDashboardUrl({
      serverUrl: 'http://127.0.0.1:4317',
      nodeEnv: 'development',
      devUrl: '   ',
    });
    expect(url).toBe('http://127.0.0.1:4317');
  });

  it('ignores the dev URL in production even if one is configured', () => {
    const url = resolveDashboardUrl({
      serverUrl: 'http://127.0.0.1:4317',
      nodeEnv: 'production',
      devUrl: 'http://127.0.0.1:5173',
    });
    expect(url).toBe('http://127.0.0.1:4317');
  });
});
