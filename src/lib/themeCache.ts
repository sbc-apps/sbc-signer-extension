/**
 * Synchronous, localStorage-backed cache of the user's active profile
 * theme so the popup, prompt, and options pages can paint the user's
 * theme on first frame instead of flashing the default colors while
 * the relay round-trip completes.
 *
 * Why localStorage and not chrome.storage.local?
 *   The login token lives in chrome.storage.local because the
 *   background service worker needs it. The theme cache is only
 *   consumed by the React surfaces (popup / prompt / options), which
 *   ALL have synchronous localStorage access. Using localStorage lets
 *   us apply the theme before React mounts; chrome.storage.local is
 *   async-only and would force at least one render of default colors.
 *
 *   The cache stores PUBLIC information (the user has chosen to
 *   publish their theme to relays), so storing it in window-scoped
 *   localStorage carries no extra security risk.
 *
 * Schema:
 *   ditto-extension:profile-theme:active-pubkey  → hex pubkey of the
 *                                                  user whose theme is
 *                                                  currently applied
 *   ditto-extension:profile-theme:<pubkey>       → CachedThemePayload
 */

import { z } from 'zod';

import type { CoreThemeColors, ThemeBackground, ThemeFont } from '@/lib/themeEvent';

// ─── Storage keys ─────────────────────────────────────────────────────

const ACTIVE_PUBKEY_KEY = 'ditto-extension:profile-theme:active-pubkey';
const THEME_KEY_PREFIX = 'ditto-extension:profile-theme:';

function themeKey(pubkey: string): string {
  return `${THEME_KEY_PREFIX}${pubkey}`;
}

// ─── Types & schema ───────────────────────────────────────────────────

/**
 * The minimum subset of a parsed kind 16767 event needed to render the
 * theme. We deliberately drop the original NostrEvent (it's not needed
 * after parsing and would bloat localStorage).
 */
export interface CachedThemePayload {
  colors: CoreThemeColors;
  font?: ThemeFont;
  titleFont?: ThemeFont;
  background?: ThemeBackground;
}

const HslSchema = z.string().regex(
  /^\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%$/,
  'must be a Ditto-style HSL string like "270 65% 55%"',
);

const FontSchema = z.object({
  family: z.string().min(1).max(120),
  url: z.url().optional(),
});

const BackgroundSchema = z.object({
  url: z.url(),
  mode: z.enum(['cover', 'tile']).optional(),
  mimeType: z.string().max(120).optional(),
  dimensions: z.string().max(40).optional(),
  blurhash: z.string().max(120).optional(),
});

const PayloadSchema: z.ZodType<CachedThemePayload> = z.object({
  colors: z.object({
    background: HslSchema,
    text: HslSchema,
    primary: HslSchema,
  }),
  font: FontSchema.optional(),
  titleFont: FontSchema.optional(),
  background: BackgroundSchema.optional(),
});

// ─── Read API (synchronous) ───────────────────────────────────────────

/** The pubkey whose theme was last applied, or undefined. */
export function readActivePubkey(): string | undefined {
  try {
    const raw = localStorage.getItem(ACTIVE_PUBKEY_KEY);
    return raw && /^[0-9a-f]{64}$/.test(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the cached theme for a given pubkey. Returns undefined if
 * nothing is cached or the cached value fails schema validation.
 */
export function readCachedTheme(pubkey: string): CachedThemePayload | undefined {
  try {
    const raw = localStorage.getItem(themeKey(pubkey));
    if (!raw) return undefined;
    const parsed = PayloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// ─── Write API ────────────────────────────────────────────────────────

/**
 * Persist a theme for the given pubkey and mark it as the active one
 * so the next page open can boot synchronously from the cache.
 */
export function writeCachedTheme(pubkey: string, payload: CachedThemePayload): void {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return;
  try {
    localStorage.setItem(themeKey(pubkey), JSON.stringify(payload));
    localStorage.setItem(ACTIVE_PUBKEY_KEY, pubkey);
  } catch {
    // QuotaExceeded or similar — non-fatal.
  }
}

/**
 * Drop the cached theme for the given pubkey AND clear the active
 * pointer if it was pointing at that pubkey.
 */
export function clearCachedTheme(pubkey: string): void {
  try {
    localStorage.removeItem(themeKey(pubkey));
    if (readActivePubkey() === pubkey) {
      localStorage.removeItem(ACTIVE_PUBKEY_KEY);
    }
  } catch {
    // Non-fatal.
  }
}

/** Forget who the active user is, but keep per-pubkey caches around. */
export function clearActivePubkey(): void {
  try {
    localStorage.removeItem(ACTIVE_PUBKEY_KEY);
  } catch {
    // Non-fatal.
  }
}
