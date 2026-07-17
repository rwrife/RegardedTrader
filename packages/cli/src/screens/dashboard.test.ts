import { describe, expect, it, vi } from 'vitest';
import {
  resolveDashboardUrl,
  formatConnectLine,
  fetchServerVersion,
  type ServerVersionInfo,
} from './dashboard.js';

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

describe('formatConnectLine (#179)', () => {
  const info: ServerVersionInfo = {
    server: '0.2.1',
    core: '0.2.1',
    node: 'v20.11.0',
    api: 1,
    startedAt: '2026-07-17T09:00:00.000Z',
  };

  it('snapshots the connect line with a fresh /version payload', () => {
    expect(formatConnectLine('http://127.0.0.1:4317', info)).toBe(
      'connected to server 0.2.1 (core 0.2.1, api 1)',
    );
  });

  it('falls back to a plain "connecting" line when /version is unavailable', () => {
    expect(formatConnectLine('http://127.0.0.1:4317', null)).toBe(
      'connecting to http://127.0.0.1:4317',
    );
  });
});

describe('fetchServerVersion (#179)', () => {
  it('returns the payload on a well-formed 200', async () => {
    const payload: ServerVersionInfo = {
      server: '0.2.1',
      core: '0.2.1',
      node: 'v20.11.0',
      api: 1,
      startedAt: '2026-07-17T09:00:00.000Z',
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    }) as unknown as typeof fetch;
    const out = await fetchServerVersion('http://127.0.0.1:4317', { fetchImpl });
    expect(out).toEqual(payload);
  });

  it('returns null on non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    }) as unknown as typeof fetch;
    expect(await fetchServerVersion('http://127.0.0.1:4317', { fetchImpl })).toBeNull();
  });

  it('returns null on malformed payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ nope: true }),
    }) as unknown as typeof fetch;
    expect(await fetchServerVersion('http://127.0.0.1:4317', { fetchImpl })).toBeNull();
  });

  it('returns null when fetch rejects (network error / abort)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch;
    expect(await fetchServerVersion('http://127.0.0.1:4317', { fetchImpl })).toBeNull();
  });
});
