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
    testActive: vi.fn(async () => ({
      ok: true as const,
      latencyMs: 42,
      model: 'gpt-4o-mini',
      providerId: 'openai',
    })),
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
    updateRiskCaps: vi.fn(async (risk) => ({
      ok: true,
      aiConfigured: true,
      config: makeConfig({ risk }),
    })),
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

function setInputValue(input: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
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

  it('renders the risk-caps editor with current values', async () => {
    const harness = await mount(makeApi());
    try {
      expect(harness.container.textContent).toContain('Risk caps');
      const lossInput = harness.container.querySelector(
        'input[aria-label="Max loss USD"]',
      ) as HTMLInputElement | null;
      const legsInput = harness.container.querySelector(
        'input[aria-label="Max legs"]',
      ) as HTMLInputElement | null;
      const forbid = harness.container.querySelector(
        'input[aria-label="Forbid naked shorts"]',
      ) as HTMLInputElement | null;
      expect(lossInput?.value).toBe('500');
      expect(legsInput?.value).toBe('4');
      expect(forbid?.checked).toBe(true);
    } finally {
      unmount(harness);
    }
  });

  it('saves edited risk caps via updateRiskCaps', async () => {
    const api = makeApi();
    const harness = await mount(api);
    try {
      const lossInput = harness.container.querySelector(
        'input[aria-label="Max loss USD"]',
      ) as HTMLInputElement;
      const legsInput = harness.container.querySelector(
        'input[aria-label="Max legs"]',
      ) as HTMLInputElement;
      const forbid = harness.container.querySelector(
        'input[aria-label="Forbid naked shorts"]',
      ) as HTMLInputElement;
      await act(async () => {
        setInputValue(lossInput, '750');
        setInputValue(legsInput, '2');
        forbid.click();
      });
      const saveBtn = Array.from(harness.container.querySelectorAll('button')).find(
        (b) => b.textContent?.trim().startsWith('Save risk caps'),
      ) as HTMLButtonElement | undefined;
      expect(saveBtn).toBeTruthy();
      const form = saveBtn!.closest('form') as HTMLFormElement;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(api.updateRiskCaps).toHaveBeenCalledWith({
        maxLossUsd: 750,
        maxLegs: 2,
        forbidNakedShorts: false,
      });
    } finally {
      unmount(harness);
    }
  });

  it('rejects invalid risk-cap inputs client-side', async () => {
    const api = makeApi();
    const harness = await mount(api);
    try {
      const lossInput = harness.container.querySelector(
        'input[aria-label="Max loss USD"]',
      ) as HTMLInputElement;
      await act(async () => {
        setInputValue(lossInput, '-1');
      });
      const saveBtn = Array.from(harness.container.querySelectorAll('button')).find(
        (b) => b.textContent?.trim().startsWith('Save risk caps'),
      ) as HTMLButtonElement;
      const form = saveBtn.closest('form') as HTMLFormElement;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
      expect(api.updateRiskCaps).not.toHaveBeenCalled();
      expect(harness.container.textContent).toMatch(/Max loss must be a positive number/);
    } finally {
      unmount(harness);
    }
  });
});
