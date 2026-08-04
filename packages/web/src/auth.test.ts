import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AUTH_EXPIRED_EVENT,
  AUTH_STORAGE_KEY,
  initDashboardAuth,
  installAuthorizedFetch,
} from './auth.js';

const nativeFetch = window.fetch;

describe('dashboard auth bootstrap', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/');
    vi.restoreAllMocks();
    window.fetch = nativeFetch;
  });

  it('moves ?t token to sessionStorage and removes it from URL', () => {
    window.history.replaceState({}, '', '/?t=abc123#/watchlist');
    initDashboardAuth();
    expect(window.sessionStorage.getItem(AUTH_STORAGE_KEY)).toBe('abc123');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#/watchlist');
  });

  it('injects Authorization for same-origin API calls and emits event on 401', async () => {
    window.sessionStorage.setItem(AUTH_STORAGE_KEY, 'tok');
    const seen: Array<{ url: string; auth: string | null }> = [];
    vi.spyOn(window, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers ?? {});
      seen.push({ url, auth: headers.get('Authorization') });
      return new Response('{}', { status: url.endsWith('/401') ? 401 : 200 });
    });
    const onExpired = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);

    installAuthorizedFetch();
    await fetch('/api/health');
    await fetch('/api/401');

    expect(seen[0]?.auth).toBe('Bearer tok');
    expect(seen[1]?.auth).toBe('Bearer tok');
    expect(onExpired).toHaveBeenCalledTimes(1);
  });
});
