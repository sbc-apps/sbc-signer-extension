/**
 * Synchronous boot of the user's last-known active profile theme.
 *
 * Called from popup.tsx / prompt.tsx / options.tsx BEFORE
 * `createRoot()` so the document already shows the user's colors,
 * fonts, and background image on the very first paint instead of
 * flashing the default Tailwind tokens while React mounts and
 * useActiveProfileTheme finishes its relay fetch.
 *
 * The theme is then refreshed in the background by useApplyProfileTheme
 * once React mounts, and the cache is rewritten with the latest event.
 *
 * If no theme is cached (logged out, or logged in with no kind 16767
 * published yet), still kicks off a one-off icon recolor based on the
 * default `--primary` from index.css so the favicon and toolbar icon
 * track SBC's default light/dark palette through the OS
 * `prefers-color-scheme`.
 */

import { applyActiveProfileTheme } from '@/lib/themeApply';
import { readActivePubkey, readCachedTheme } from '@/lib/themeCache';
import { applyThemedIconFromCurrentCss } from '@/lib/themeIcon';

export function bootCachedProfileTheme(): void {
  const pubkey = readActivePubkey();
  let appliedThemeFromCache = false;
  if (pubkey) {
    const cached = readCachedTheme(pubkey);
    if (cached) {
      applyActiveProfileTheme(cached);
      appliedThemeFromCache = true;
    }
  }

  if (!appliedThemeFromCache) {
    // No cached profile theme — paint the icon with the live default
    // primary so a logged-out / themeless user still sees a correctly
    // tinted icon (SBC blue, depending on the OS).
    applyThemedIconFromCurrentCss().catch(() => {});
  }

  // OS prefers-color-scheme changes flip the default --primary in
  // index.css automatically, but the canvas-rendered icon needs a
  // manual repaint to follow. Listen for the change and re-render
  // ONLY when no profile theme is active — when one is, its primary
  // is fixed regardless of the OS scheme so reacting here would just
  // race useApplyProfileTheme.
  if (typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', () => {
      if (readActivePubkey()) return; // a profile theme is active
      applyThemedIconFromCurrentCss().catch(() => {});
    });
  }
}
