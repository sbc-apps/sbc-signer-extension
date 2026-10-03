import { useEffect } from 'react';

import { useActiveProfileTheme } from '@/hooks/useActiveProfileTheme';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { applyActiveProfileTheme, clearActiveProfileTheme } from '@/lib/themeApply';
import {
  clearActivePubkey,
  clearCachedTheme,
  readCachedTheme,
  writeCachedTheme,
} from '@/lib/themeCache';

/**
 * Fetch the logged-in user's active profile theme (kind 16767) and
 * apply it to the document.
 *
 * Two layers of latency hiding:
 *
 * 1. **Synchronous cache.**
 *    `bootCachedProfileTheme()` is called before React mounts, so by
 *    the time this hook runs the document is already showing the
 *    user's last-known theme.
 *
 * 2. **Background refresh.**
 *    `useActiveProfileTheme` issues a relay query; when a fresh event
 *    arrives we re-apply, then write through to the cache so the next
 *    page open picks it up synchronously.
 *
 * Logout / account switch:
 *    When the active pubkey goes away we clear the active pointer (so
 *    next sync boot doesn't apply a stranger's theme) but we keep the
 *    per-pubkey cached payload around so logging back in is still
 *    flicker-free.
 *
 * Mount once near the top of the React tree (App.tsx).
 */
export function useApplyProfileTheme(): void {
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;

  // Refetch in the background; first paint already came from the
  // synchronous boot path, so even a slow relay is invisible to the user.
  const { data: theme } = useActiveProfileTheme(pubkey);

  // Active user changed → switch to whatever's cached for this pubkey
  // (if anything) so we don't keep showing the previous user's theme
  // while the fresh fetch is in flight.
  useEffect(() => {
    if (!pubkey) {
      // Logged out: reset both the on-page styles and the active pointer,
      // but leave any per-pubkey cached payloads in place so logging
      // back in is still flicker-free.
      clearActiveProfileTheme();
      clearActivePubkey();
      return;
    }
    const cached = readCachedTheme(pubkey);
    if (cached) {
      applyActiveProfileTheme(cached);
    } else {
      // No cached theme for this user yet — fall back to defaults
      // until the relay fetch lands.
      clearActiveProfileTheme();
    }
  }, [pubkey]);

  // Fresh fetch landed → re-apply and write through the cache.
  useEffect(() => {
    if (!pubkey) return;
    if (theme) {
      const payload = {
        colors: theme.colors,
        font: theme.font,
        titleFont: theme.titleFont,
        background: theme.background,
      };
      applyActiveProfileTheme(payload);
      writeCachedTheme(pubkey, payload);
    } else if (theme === null) {
      // Relay confirmed the user has no kind 16767 event published.
      // Drop any stale cache and revert to defaults.
      clearCachedTheme(pubkey);
      clearActiveProfileTheme();
    }
    // theme === undefined (still loading) → leave the synchronously
    // applied theme in place.
  }, [pubkey, theme]);
}
