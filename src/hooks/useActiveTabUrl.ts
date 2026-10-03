import { useEffect, useState } from 'react';

interface ActiveTabState {
  url: string | undefined;
  tabId: number | undefined;
  /** The active tab's `<title>`, as Chrome reports it. May be undefined for fresh navigations. */
  title: string | undefined;
  /** The active tab's favicon URL, as Chrome resolves it. May be undefined until the page declares one. */
  favIconUrl: string | undefined;
  loading: boolean;
}

/**
 * Prefix shared by every page this extension owns
 * (`chrome-extension://<id>/`). Computed lazily so the hook still
 * works outside an extension context (dev preview, tests).
 */
function ownPagePrefix(): string {
  try {
    return chrome.runtime?.getURL?.('') ?? '';
  } catch {
    return '';
  }
}

/**
 * Tracks the URL (and title / favicon) of the user's currently active
 * tab in the focused window. Re-queries when the active tab or its
 * URL/title/favicon changes so the popup stays in sync if the user
 * navigates with the popup open.
 *
 * Our own pages are deliberately never reported. The prompt, highlight
 * and archive windows are all created with `focused: true`, which makes
 * each of them the *last focused window* the moment it opens — so a
 * naive query answers with that window's `chrome-extension://` tab
 * instead of the page the user is actually looking at. The popup stays
 * open behind those windows on some platforms, and would then blank
 * itself out to "Extension not available here" mid-flow. These windows
 * are transient overlays, not a browsing context, so we hold on to the
 * last real tab instead.
 *
 * `url` may still be a non-http URL like `chrome://newtab`. Callers
 * should run it through `canonicalizePageUrl` to filter to commentable
 * pages.
 *
 * `title` and `favIconUrl` come straight from `chrome.tabs.Tab` and
 * are *not* tied to any Nostr account — they describe the tab itself,
 * so they're safe to show regardless of which account is logged in.
 */
export function useActiveTabUrl(): ActiveTabState {
  const [state, setState] = useState<ActiveTabState>({
    url: undefined,
    tabId: undefined,
    title: undefined,
    favIconUrl: undefined,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    // Whether we've ever resolved a tab. Until we have, there's no
    // previous value worth protecting, so we take whatever we're given
    // rather than risk being stuck on `loading` forever.
    let resolved = false;
    const ownPrefix = ownPagePrefix();

    const apply = (tab: chrome.tabs.Tab | undefined) => {
      if (cancelled) return;
      resolved = true;
      setState({
        url: tab?.url,
        tabId: tab?.id,
        title: tab?.title,
        favIconUrl: tab?.favIconUrl,
        loading: false,
      });
    };

    const refresh = async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        // One of our own windows just took focus — keep showing the
        // page the user was on. See the note on this hook.
        if (resolved && ownPrefix && tab?.url?.startsWith(ownPrefix)) return;
        apply(tab);
      } catch {
        if (cancelled) return;
        setState({
          url: undefined,
          tabId: undefined,
          title: undefined,
          favIconUrl: undefined,
          loading: false,
        });
      }
    };

    refresh();

    // Fire when the focused tab changes (e.g. user clicks another tab
    // before opening the popup, or in dev tools the popup stays open).
    const onActivated = () => {
      refresh();
    };
    // Fire when the active tab navigates, retitles, or resolves a
    // favicon. Wikipedia, for example, sets `<title>` and the favicon
    // link tag during load, so we need to react to those updates and
    // not just `url` changes — otherwise the popup keeps showing the
    // host + globe fallback even after the page has finished loading.
    const onUpdated = (_tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (!tab.active) return;
      if (changeInfo.url || changeInfo.title || changeInfo.favIconUrl || changeInfo.status === 'complete') {
        refresh();
      }
    };

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);

    return () => {
      cancelled = true;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  return state;
}
