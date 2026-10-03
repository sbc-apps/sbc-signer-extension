/**
 * Comment-presence indicator.
 *
 * Goals:
 *  - When a tab finishes loading or becomes active, look up whether
 *    any NIP-22 (kind 1111) comments exist for the page's canonical
 *    URL on a small set of relays.
 *  - If at least one comment exists, swap the toolbar icon for a copy
 *    of the icon with a small green dot painted in the top-right
 *    corner. Otherwise restore the plain icon.
 *  - Cache results per canonical URL with a short TTL so we don't
 *    hammer relays as the user navigates.
 *
 * Why repaint the icon instead of using `chrome.action.setBadgeText`?
 *  Chrome's badge API forces a fixed rounded-rectangle "pill" behind
 *  whatever character we put in it, so a true dot shape isn't
 *  achievable that way. Drawing the dot directly onto the icon via
 *  `OffscreenCanvas` + `chrome.action.setIcon({ imageData })` gives us
 *  a real notification dot.
 *
 * Constraints:
 *  - This runs in a Manifest V3 service worker, which can be torn down
 *    while idle. We open a fresh `NRelay1` per query and close it
 *    afterwards rather than keeping a long-lived pool. Caches live in
 *    module scope; if the worker is recycled, they're rebuilt on demand.
 *  - We don't want one stuck relay to block updates, so each relay
 *    query has a 4s timeout and we proceed with whatever responded.
 *  - Service workers don't have `document`, but they do have
 *    `OffscreenCanvas` and `createImageBitmap`, which is enough.
 */

import { NRelay1 } from '@nostrify/nostrify';
import type { NostrEvent } from '@nostrify/nostrify';
import { canonicalizePageUrl } from '@/lib/canonicalUrl';
import { APP_RELAYS } from '@/lib/appRelays';
import type { AppConfig } from '@/contexts/AppContext';
import { extStorage, STORAGE_KEYS, COMMENT_BADGE_ENABLED_DEFAULT } from '@/extension/storage';

/** Cache TTL for a successful count, in ms. */
const CACHE_TTL_MS = 60_000;
/** Per-relay query timeout, in ms. */
const RELAY_TIMEOUT_MS = 4_000;
/**
 * We don't display the exact count anymore — just a presence dot — but we
 * still cap how many events we pull per relay so a viral page can't spin
 * up an unbounded query.
 */
const MAX_QUERY_LIMIT = 100;

/**
 * Icon sizes we render. Chrome picks per-DPI from this map; 16/32/48
 * covers the toolbar at every density we care about. (128 is only
 * shown in management UI, which uses the manifest icons directly.)
 */
const ICON_SIZES = [16, 32, 48] as const;
type IconSize = (typeof ICON_SIZES)[number];

/** Color of the notification dot. */
const DOT_COLOR = '#22c55e'; // tailwind green-500

interface CacheEntry {
  count: number;
  fetchedAt: number;
}

/** canonical URL string -> last known count + when it was fetched. */
const countCache = new Map<string, CacheEntry>();
/** canonical URL string -> in-flight fetch promise (de-dupe). */
const inflight = new Map<string, Promise<number>>();
/** tabId -> last canonical URL we set an icon for. Lets us drop stale state. */
const lastUrlByTab = new Map<number, string | null>();
/** tabId -> last icon variant we applied, so we can skip redundant setIcon calls. */
const lastVariantByTab = new Map<number, 'plain' | 'dot'>();

/**
 * Resolve the read relays the badge should query. Mirrors the user's
 * configured NIP-65 read relays (written to chrome.storage.local by the
 * extension pages' AppProvider) so the background badge respects relay
 * settings. Falls back to the app defaults when no config is present or
 * the config has no read relays.
 *
 * Cached in module scope and refreshed reactively via the
 * `chrome.storage.onChanged` listener installed by `installBadgeHandlers`.
 */
let cachedReadRelays: string[] | null = null;
let readRelaysLoadPromise: Promise<string[]> | null = null;

function appDefaultReadRelays(): string[] {
  return APP_RELAYS.relays.filter((r) => r.read).map((r) => r.url);
}

async function getReadRelays(): Promise<string[]> {
  if (cachedReadRelays !== null) return cachedReadRelays;
  if (!readRelaysLoadPromise) {
    readRelaysLoadPromise = (async () => {
      const config = await extStorage.get<Partial<AppConfig> | null>(STORAGE_KEYS.appConfig, null);
      const relays = config?.relayMetadata?.relays
        ?.filter((r) => r.read)
        .map((r) => r.url) ?? [];
      cachedReadRelays = relays.length > 0 ? relays : appDefaultReadRelays();
      return cachedReadRelays;
    })();
  }
  return readRelaysLoadPromise;
}

/**
 * Fetch the comment count for a canonical URL across the configured
 * read relays, de-duplicated. Closes each relay connection after the
 * query finishes so the service worker can suspend cleanly.
 */
async function fetchCommentCount(canonical: string): Promise<number> {
  const cached = countCache.get(canonical);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.count;
  }
  const existing = inflight.get(canonical);
  if (existing) return existing;

  const promise = (async () => {
    const relays = await getReadRelays();
    const seenIds = new Set<string>();

    const queryRelay = async (url: string): Promise<NostrEvent[]> => {
      const relay = new NRelay1(url);
      try {
        return await relay.query(
          [{ kinds: [1111], '#I': [canonical], limit: MAX_QUERY_LIMIT }],
          { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) },
        );
      } finally {
        // Best-effort close; don't let socket teardown errors propagate.
        try {
          await relay.close();
        } catch {
          /* noop */
        }
      }
    };

    const settled = await Promise.allSettled(relays.map(queryRelay));
    for (const r of settled) {
      if (r.status !== 'fulfilled') continue;
      for (const ev of r.value) seenIds.add(ev.id);
    }

    const count = seenIds.size;
    countCache.set(canonical, { count, fetchedAt: Date.now() });
    return count;
  })();

  inflight.set(canonical, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(canonical);
  }
}

// ---------------------------------------------------------------------------
// Icon rendering
// ---------------------------------------------------------------------------

/**
 * Cached `ImageBitmap`s of the base toolbar icon, keyed by size. Built
 * lazily on first use and reused across tabs. If the service worker
 * sleeps, these get rebuilt on the next call.
 *
 * The bitmap holds the silhouette + alpha channel from the static PNG
 * — the actual color is applied later in `renderIcon` so that when the
 * user's profile theme changes its primary color, we can swap the tint
 * without re-fetching.
 */
const baseBitmaps = new Map<IconSize, ImageBitmap>();

/**
 * Cached `ImageData` variants we hand to `chrome.action.setIcon`,
 * keyed by `${size}|${primaryHex}` so a primary-color change
 * automatically misses the cache and re-renders. Background variants
 * (with the comment-presence dot) are stored in `dotIconData`.
 */
const plainIconData = new Map<string, ImageData>();
const dotIconData = new Map<string, ImageData>();

/** Browser icons always use SBC blue, including after a profile theme change. */
const DEFAULT_PRIMARY_HEX = '#0098ea';

async function getActivePrimary(): Promise<string> {
  return DEFAULT_PRIMARY_HEX;
}

async function loadBaseBitmap(size: IconSize): Promise<ImageBitmap> {
  const existing = baseBitmaps.get(size);
  if (existing) return existing;
  const url = chrome.runtime.getURL(`public/icons/icon-${size}.png`);
  const res = await fetch(url);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  baseBitmaps.set(size, bitmap);
  return bitmap;
}

/**
 * Render the icon at `size`, tinted with the active theme primary,
 * optionally with a notification dot in the top-right corner. Results
 * are memoized per (size, primary, dot) tuple.
 */
async function renderIcon(size: IconSize, withDot: boolean): Promise<ImageData> {
  const primary = await getActivePrimary();
  const cacheKey = `${size}|${primary}`;
  const cache = withDot ? dotIconData : plainIconData;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const bitmap = await loadBaseBitmap(size);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');

  // Fill with the primary color, then keep only pixels where the base
  // icon's silhouette is opaque. The base PNG ships pre-filled with
  // the original purple, but `destination-in` discards its color and
  // keeps only the alpha mask, leaving us a clean silhouette in the
  // active theme primary.
  ctx.fillStyle = primary;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(bitmap, 0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';

  if (withDot) {
    // Small dot tucked into the top-right corner. Kept intentionally
    // tiny (~14% of the icon) so it reads as an unobtrusive presence
    // indicator and doesn't crowd the logo, especially at 16px.
    const radius = Math.max(2, Math.round(size * 0.14));
    const cx = size - radius;
    const cy = radius;

    ctx.fillStyle = DOT_COLOR;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  const data = ctx.getImageData(0, 0, size, size);
  cache.set(cacheKey, data);
  return data;
}

/** Build the multi-size `imageData` map `chrome.action.setIcon` expects. */
async function buildIconImageData(withDot: boolean): Promise<Record<number, ImageData>> {
  const entries = await Promise.all(
    ICON_SIZES.map(async (s) => [s, await renderIcon(s, withDot)] as const),
  );
  return Object.fromEntries(entries);
}

/**
 * Apply (or clear) the notification dot on the toolbar icon for a
 * specific tab. `null` or a non-positive count restores the plain icon
 * (e.g. when the user is on chrome://newtab or the page has no
 * comments).
 */
async function setTabIcon(tabId: number, count: number | null): Promise<void> {
  const variant: 'plain' | 'dot' = count !== null && count > 0 ? 'dot' : 'plain';
  if (lastVariantByTab.get(tabId) === variant) return;

  try {
    const imageData = await buildIconImageData(variant === 'dot');
    await chrome.action.setIcon({ tabId, imageData });
    lastVariantByTab.set(tabId, variant);
  } catch {
    // Tab may have been closed, or canvas/setIcon hit an unexpected
    // error. Leave whatever icon is currently set; we'll retry on the
    // next navigation.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Whether the passive comment-presence badge is enabled. Defaults to
 * OFF: when disabled we never query relays on navigation, so the user's
 * browsing history is not broadcast. Read lazily from storage on first
 * use and kept in sync via the `chrome.storage.onChanged` listener
 * installed by `installBadgeHandlers`.
 *
 * This gate only governs the background, per-navigation lookup. The
 * popup fetches comments for the current page on demand when opened,
 * independently of this setting.
 */
let badgeEnabled: boolean | null = null;
let badgeEnabledLoadPromise: Promise<boolean> | null = null;

async function isBadgeEnabled(): Promise<boolean> {
  if (badgeEnabled !== null) return badgeEnabled;
  if (!badgeEnabledLoadPromise) {
    badgeEnabledLoadPromise = (async () => {
      badgeEnabled = await extStorage.get<boolean>(
        STORAGE_KEYS.commentBadgeEnabled,
        COMMENT_BADGE_ENABLED_DEFAULT,
      );
      return badgeEnabled;
    })();
  }
  return badgeEnabledLoadPromise;
}

/**
 * Refresh the icon for a tab based on its current URL. Safe to call
 * repeatedly; the count cache + in-flight de-dup prevents storms.
 *
 * No-ops (and clears any existing dot) when the comment badge is
 * disabled, so disabling it stops all relay traffic on navigation.
 */
export async function refreshBadgeForTab(tabId: number, rawUrl: string | undefined): Promise<void> {
  if (!(await isBadgeEnabled())) {
    await setTabIcon(tabId, null);
    lastUrlByTab.set(tabId, null);
    return;
  }

  const canonical = canonicalizePageUrl(rawUrl);
  const canonicalStr = canonical?.toString() ?? null;
  lastUrlByTab.set(tabId, canonicalStr);

  if (!canonicalStr) {
    await setTabIcon(tabId, null);
    return;
  }

  // Show whatever we have cached immediately, then revalidate in the
  // background so the icon updates if relays return more results.
  const cached = countCache.get(canonicalStr);
  if (cached) {
    await setTabIcon(tabId, cached.count);
    if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) return;
  }

  try {
    const count = await fetchCommentCount(canonicalStr);
    // Bail if the tab navigated again while we were fetching.
    if (lastUrlByTab.get(tabId) !== canonicalStr) return;
    await setTabIcon(tabId, count);
  } catch {
    // Network failure — leave whatever icon is currently set.
  }
}

/** Refresh the icon for whichever tab is currently active. */
export async function refreshActiveTabBadge(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return;
    await refreshBadgeForTab(tab.id, tab.url);
  } catch {
    /* ignore */
  }
}

/**
 * Re-paint the icon on every open tab.
 *
 * Used when the active theme primary changes (e.g. user switches
 * accounts in the popup): a per-tab icon override installed by
 * chrome.action.setIcon({ tabId }) wins over the manifest's default
 * forever, so without this every tab the SW had touched would keep
 * showing the previous user's tint until its next navigation.
 *
 * We iterate every open tab — not just `lastUrlByTab` — so that tabs
 * the SW hasn't yet observed (e.g. opened before the SW woke) also
 * get the right tint installed.
 */
async function repaintAllTrackedTabs(): Promise<void> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  await Promise.allSettled(
    tabs.map(async (tab) => {
      if (typeof tab.id !== 'number') return;
      try {
        await refreshBadgeForTab(tab.id, tab.url);
      } catch {
        // Tab gone — drop our trackers so we don't keep retrying.
        lastUrlByTab.delete(tab.id);
        lastVariantByTab.delete(tab.id);
      }
    }),
  );
}

/**
 * Invalidate cached counts for a canonical URL — call after the user
 * posts a new comment so the icon reflects it on the next refresh.
 */
export function invalidateCommentCount(canonicalUrl: string): void {
  countCache.delete(canonicalUrl);
}

/** Wire up Chrome event listeners that drive the icon. */
export function installBadgeHandlers(): void {
  // Tab finished loading (or its URL changed mid-load).
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' || changeInfo.url) {
      refreshBadgeForTab(tabId, tab.url).catch(() => {});
    }
  });

  // User switched to a different tab in the focused window.
  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      await refreshBadgeForTab(tabId, tab.url);
    } catch {
      /* tab gone */
    }
  });

  // Tab closed — drop any cached state for it.
  chrome.tabs.onRemoved.addListener((tabId) => {
    lastUrlByTab.delete(tabId);
    lastVariantByTab.delete(tabId);
  });

  // Repaint existing per-tab overrides when a page updates the icon.
  // Ignore theme colors stored by older versions; browser icons stay blue.
  extStorage.onChange<string | undefined>(STORAGE_KEYS.themePrimary, () => {
    plainIconData.clear();
    dotIconData.clear();
    // Drop the per-tab variant memo so setTabIcon repaints even though
    // the abstract variant ('plain'/'dot') hasn't changed.
    lastVariantByTab.clear();

    // Replace any per-tab override left by an older extension version.
    repaintAllTrackedTabs();
  });

  // Comment-badge setting toggled in the options page. Update our
  // cached flag and reconcile every open tab: when turned off, clear
  // any presence dots (and stop all future navigation queries); when
  // turned on, repaint so dots appear without waiting for the next
  // navigation.
  extStorage.onChange<boolean>(STORAGE_KEYS.commentBadgeEnabled, (next) => {
    badgeEnabled = next ?? COMMENT_BADGE_ENABLED_DEFAULT;
    badgeEnabledLoadPromise = null;
    repaintAllTrackedTabs();
  });

  // Relay configuration changed in a settings page. Drop the cached
  // read-relay list + any cached counts (which were computed against
  // the old relays) and re-query the active tab so the dot reflects the
  // new relay set.
  extStorage.onChange<Partial<AppConfig> | undefined>(STORAGE_KEYS.appConfig, () => {
    cachedReadRelays = null;
    readRelaysLoadPromise = null;
    countCache.clear();
    refreshActiveTabBadge().catch(() => {});
  });

  // Cold start / service worker wake-up: refresh whatever's active now.
  refreshActiveTabBadge().catch(() => {});
}
