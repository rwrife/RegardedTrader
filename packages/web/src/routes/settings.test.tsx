import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from './settings.js';
import type { ApiClient } from '../api.js';
import type { AiProvider, AppConfig } from '@regardedtrader/core';

function makeConfig(extra: Partial<AppConfig> = {}): AppConfig {
  return {
    version: 1,
    providers: {
      openai: {
        kind: 'openai-compatible',
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        apiKey: 'sk-1••••cdef',
      },
    },
    activeProvider: 'openai',
    risk: { maxLossUsd: 500, maxLegs: 4, forbidNakedShorts: true },
    server: { host: '127.0.0.1', port: 4317 },
    marketData: { providers: {}, activeProvider: null },
    ...extra,
  } as AppConfig;
}

function makeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getConfig: vi.fn(async () => makeConfig()),
    upsertProvider: vi.fn(async (id, provider: AiProvider) => ({
      ok: true,
      aiConfigured: true,
      config: makeConfig({ providers: { [id]: provider } }),
    })),
    removeProvider: vi.fn(async () => ({
      ok: true,
      aiConfigured: false,
      config: makeConfig({ providers: {}, activeProvider: null }),
    })),
    activateProvider: vi.fn(async (id) => ({
      ok: true,
      aiConfigured: true,
      config: makeConfig({ activeProvider: id }),
    })),
    testActive: vi.fn(async () => ({ ok: true, sample: 'OK' })),
    upsertMarketProvider: vi.fn(async (id, provider) => ({
      ok: true,
      activeMarketProvider: id,
      config: makeConfig({ marketData: { providers: { [id]: provider }, activeProvider: id } }),
    })),
    removeMarketProvider: vi.fn(async () => ({
      ok: true,
      activeMarketProvider: null,
      config: makeConfig({ marketData: { providers: {}, activeProvider: null } }),
    })),
    activateMarketProvider: vi.fn(async (id) => ({
      ok: true,
      activeMarketProvider: id,
      config: makeConfig({ marketData: { providers: {}, activeProvider: id } }),
    })),
    testMarketProvider: vi.fn(async () => ({ ok: true, provider: 'finnhub', symbol: 'AAPL', price: 100 })),
    ...overrides,
  };
}

async function mount(api: ApiClient): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Settings api={api} />);
  });
  // Flush the initial getConfig() effect.
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root };
}

function unmount({ container, root }: { container: HTMLDivElement; root: Root }): void {
  act(() => root.unmount());
  container.remove();
}

describe('<Settings>', () => {
  it('lists configured providers with a redacted key, never plaintext', async () => {
    const harness = await mount(makeApi());
    try {
      expect(harness.container.textContent).toContain('OpenAI');
      expect(harness.container.textContent).toContain('sk-1••••cdef');
      // The plaintext key from a hypothetical store value is never rendered.
      expect(harness.container.textContent).not.toContain('sk-1234abcd5678cdef');
    } finally {
      unmount(harness);
    }
  });

  it('prompts before removing a provider and calls removeProvider on confirm', async () => {
    const api = makeApi();
    const harness = await mount(api);
    try {
      const removeBtn = harness.container.querySelector(
        'button[aria-label="Remove openai"]',
      ) as HTMLButtonElement | null;
      expect(removeBtn).not.toBeNull();
      await act(async () => {
        removeBtn!.click();
      });
      expect(harness.container.textContent).toContain('delete?');
      expect(api.removeProvider).not.toHaveBeenCalled();
      const yes = Array.from(harness.container.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Yes',
      ) as HTMLButtonElement | undefined;
      expect(yes).toBeTruthy();
      await act(async () => {
        yes!.click();
        await Promise.resolve();
      });
      expect(api.removeProvider).toHaveBeenCalledWith('openai');
    } finally {
      unmount(harness);
    }
  });

  it('runs Test connection via /config/test and shows the sample', async () => {
    const api = makeApi();
    const harness = await mount(api);
    try {
      const testBtn = Array.from(harness.container.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Test',
      ) as HTMLButtonElement | undefined;
      expect(testBtn).toBeTruthy();
      await act(async () => {
        testBtn!.click();
        await Promise.resolve();
      });
      expect(api.testActive).toHaveBeenCalled();
      expect(harness.container.textContent).toMatch(/OK/);
    } finally {
      unmount(harness);
    }
  });

  it('renders an error banner when getConfig fails', async () => {
    const api = makeApi({
      getConfig: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const harness = await mount(api);
    try {
      const alert = harness.container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('boom');
    } finally {
      unmount(harness);
    }
  });

  it('includes the educational disclaimer', async () => {
    const harness = await mount(makeApi());
    try {
      expect(harness.container.textContent).toMatch(/Not financial advice/);
    } finally {
      unmount(harness);
    }
  });
});
