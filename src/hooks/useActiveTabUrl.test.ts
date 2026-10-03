import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useActiveTabUrl } from './useActiveTabUrl';

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnop/';

type Listener = (...args: unknown[]) => void;

/**
 * Minimal `chrome` stub exposing the three surfaces the hook touches,
 * plus a handle to fire the tab events it subscribes to.
 */
function stubChrome(initialTab: chrome.tabs.Tab | undefined) {
  let current = initialTab;
  const activated: Listener[] = [];
  const updated: Listener[] = [];

  const query = vi.fn(async () => (current ? [current] : []));

  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `${EXTENSION_ORIGIN}${path}` },
    tabs: {
      query,
      onActivated: {
        addListener: (fn: Listener) => activated.push(fn),
        removeListener: () => {},
      },
      onUpdated: {
        addListener: (fn: Listener) => updated.push(fn),
        removeListener: () => {},
      },
    },
  });

  return {
    query,
    /** Change what the next query resolves to, then fire onActivated. */
    focus(tab: chrome.tabs.Tab | undefined) {
      current = tab;
      for (const fn of activated) fn();
    },
  };
}

function tab(url: string, overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return { id: 1, url, title: url, active: true, ...overrides } as chrome.tabs.Tab;
}

afterEach(() => {
  // Unmount before unstubbing: the hook's cleanup removes its tab
  // listeners, and Testing Library's own auto-cleanup runs after this
  // hook, by which point `chrome` would already be gone.
  cleanup();
  vi.unstubAllGlobals();
});

describe('useActiveTabUrl', () => {
  it('reports the active tab', async () => {
    stubChrome(tab('https://example.com/a', { title: 'A' }));

    const { result } = renderHook(() => useActiveTabUrl());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.url).toBe('https://example.com/a');
    expect(result.current.title).toBe('A');
  });

  it("keeps the user's page when one of our own windows takes focus", async () => {
    // The prompt / highlight / archive windows are created with
    // `focused: true`, so they become the last focused window and a
    // naive query answers with their chrome-extension:// tab. The
    // popup stays open behind them on some platforms and used to blank
    // itself out to "Extension not available here" mid-flow.
    const harness = stubChrome(tab('https://example.com/a'));

    const { result } = renderHook(() => useActiveTabUrl());
    await waitFor(() => expect(result.current.url).toBe('https://example.com/a'));

    harness.focus(tab(`${EXTENSION_ORIGIN}src/archive.html?id=ar-1`, { id: 99 }));

    await waitFor(() => expect(harness.query).toHaveBeenCalledTimes(2));
    expect(result.current.url).toBe('https://example.com/a');
    expect(result.current.tabId).toBe(1);
  });

  it('still follows the user to a different real page', async () => {
    const harness = stubChrome(tab('https://example.com/a'));

    const { result } = renderHook(() => useActiveTabUrl());
    await waitFor(() => expect(result.current.url).toBe('https://example.com/a'));

    harness.focus(tab('https://example.com/b', { id: 2 }));

    await waitFor(() => expect(result.current.url).toBe('https://example.com/b'));
    expect(result.current.tabId).toBe(2);
  });

  it('does not hang on loading if our own page is all there is', async () => {
    // No previous tab worth protecting, so take what we're given
    // rather than stall. Renders the honest "not available here".
    stubChrome(tab(`${EXTENSION_ORIGIN}src/options.html`));

    const { result } = renderHook(() => useActiveTabUrl());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.url).toBe(`${EXTENSION_ORIGIN}src/options.html`);
  });

  it('reports no tab when the query fails', async () => {
    vi.stubGlobal('chrome', {
      runtime: { getURL: (path: string) => `${EXTENSION_ORIGIN}${path}` },
      tabs: {
        query: vi.fn(async () => {
          throw new Error('no permission');
        }),
        onActivated: { addListener: () => {}, removeListener: () => {} },
        onUpdated: { addListener: () => {}, removeListener: () => {} },
      },
    });

    const { result } = renderHook(() => useActiveTabUrl());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.url).toBeUndefined();
  });
});
