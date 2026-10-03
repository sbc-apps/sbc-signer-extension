/**
 * `NLoginStorage` adapter backed by `chrome.storage.local` so popup,
 * options, and background service worker share login state.
 *
 * Falls back to `localStorage` when running outside the extension (e.g.
 * in `vite dev` previewed in a plain tab or under vitest).
 */
import type { NLoginStorage } from '@nostrify/react/login';

const hasChromeStorage = (): boolean =>
  typeof chrome !== 'undefined' &&
  !!chrome.storage &&
  !!chrome.storage.local;

export const extensionLoginStorage: NLoginStorage = {
  async getItem(key: string): Promise<string | null> {
    if (hasChromeStorage()) {
      const result = await chrome.storage.local.get(key);
      const value = result[key];
      return typeof value === 'string' ? value : null;
    }
    return localStorage.getItem(key);
  },
  async setItem(key: string, value: string): Promise<void> {
    if (hasChromeStorage()) {
      await chrome.storage.local.set({ [key]: value });
      return;
    }
    localStorage.setItem(key, value);
  },
};

/**
 * Low-level helpers for non-login extension state (app config, permission
 * store). Always prefer `chrome.storage.local` so any surface can read.
 */
export const extStorage = {
  async get<T>(key: string, fallback: T): Promise<T> {
    if (hasChromeStorage()) {
      const result = await chrome.storage.local.get(key);
      const value = result[key];
      if (value === undefined) return fallback;
      if (typeof value === 'string') {
        try {
          return JSON.parse(value) as T;
        } catch {
          return fallback;
        }
      }
      return value as T;
    }
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  async set<T>(key: string, value: T): Promise<void> {
    const serialized = JSON.stringify(value);
    if (hasChromeStorage()) {
      await chrome.storage.local.set({ [key]: serialized });
      return;
    }
    localStorage.setItem(key, serialized);
  },
  async remove(key: string): Promise<void> {
    if (hasChromeStorage()) {
      await chrome.storage.local.remove(key);
      return;
    }
    localStorage.removeItem(key);
  },
  /**
   * Subscribe to changes for a specific key. Returns an unsubscribe fn.
   * No-op in non-extension environments.
   */
  onChange<T>(key: string, handler: (newValue: T | undefined) => void): () => void {
    if (!hasChromeStorage() || !chrome.storage.onChanged) {
      return () => {};
    }
    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== 'local') return;
      if (!(key in changes)) return;
      const change = changes[key];
      const raw = change.newValue;
      if (typeof raw === 'string') {
        try {
          handler(JSON.parse(raw) as T);
          return;
        } catch {
          handler(undefined);
          return;
        }
      }
      handler(raw as T | undefined);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  },
};

/** Storage keys retain the legacy namespace to preserve existing accounts and permissions. */
export const STORAGE_KEYS = {
  login: 'ditto-extension:login',
  appConfig: 'ditto-extension:app-config',
  permissions: 'ditto-extension:permissions',
  /**
   * The current theme primary color as a `#rrggbb` hex string. Written
   * by the extension pages whenever a theme is applied (sync boot or
   * relay refresh) and read by the background service worker so the
   * toolbar action icon (chrome.action.setIcon) stays in sync with
   * whatever primary color the user's active profile theme defines.
   */
  themePrimary: 'ditto-extension:theme-primary',
  /**
   * Whether the comment-presence toolbar badge is enabled. When this is
   * off (the default), the background service worker does NOT query
   * relays on navigation/tab switches, so your browsing history isn't
   * broadcast to relays. Turning it on opts into the per-page lookup.
   *
   * This only affects the passive background badge; opening the popup
   * always fetches comments for the current page on demand regardless.
   */
  commentBadgeEnabled: 'ditto-extension:comment-badge-enabled',
} as const;

/** Default for {@link STORAGE_KEYS.commentBadgeEnabled}: off for privacy. */
export const COMMENT_BADGE_ENABLED_DEFAULT = false;
