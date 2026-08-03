export const AUTH_STORAGE_KEY = 'rt.auth';
export const AUTH_EXPIRED_EVENT = 'rt:auth-expired';

function sameOrigin(url: string): boolean {
  if (url.startsWith('/')) return true;
  try {
    const u = new URL(url, window.location.origin);
    return u.origin === window.location.origin;
  } catch {
    return false;
  }
}

function shouldAttachAuth(url: string): boolean {
  if (!sameOrigin(url)) return false;
  return (
    url.startsWith('/api/') ||
    url === '/api' ||
    url.startsWith('/calendar/') ||
    url === '/calendar' ||
    url.startsWith('/version') ||
    url.startsWith('/tickers/')
  );
}

export function initDashboardAuth(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const token = url.searchParams.get('t');
  if (!token) return;
  window.sessionStorage.setItem(AUTH_STORAGE_KEY, token);
  url.searchParams.delete('t');
  const clean = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState({}, document.title, clean);
}

export function installAuthorizedFetch(): void {
  if (typeof window === 'undefined') return;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const token = window.sessionStorage.getItem(AUTH_STORAGE_KEY);
    if (!token || !shouldAttachAuth(url)) {
      const out = await nativeFetch(input, init);
      if (out.status === 401) {
        window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
      }
      return out;
    }

    const headers = new Headers(init?.headers ?? {});
    headers.set('Authorization', `Bearer ${token}`);

    const out = await nativeFetch(input, { ...init, headers });
    if (out.status === 401) {
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    }
    return out;
  };
}
