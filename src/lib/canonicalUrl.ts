/**
 * URL canonicalization for the comment-on-current-page feature.
 *
 * Goals:
 *  - Group comments on the same logical page even when the URL has
 *    cosmetic variations (tracking params, fragments).
 *  - Be conservative: do NOT drop semantically meaningful query
 *    parameters (e.g. `?id=...` on a product page, `?q=...` on search).
 *  - Always lowercase the host but preserve case in the path/query.
 *
 * Returns null for URLs we don't comment on: chrome://, about:, file://,
 * the extension's own pages, view-source:, data:, javascript:, etc.
 *
 * The canonical form is stored as the `i` / `I` tag on a NIP-22 comment
 * and used as the comments query key, so changes here change which page
 * a comment "belongs" to. Don't change this casually.
 */

/** Tracking-only query parameters that are safe to strip. */
const TRACKING_PARAMS = new Set([
  // Google / generic
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  // Facebook
  'fbclid',
  // Google ads / analytics
  'gclid',
  'gclsrc',
  'dclid',
  'wbraid',
  'gbraid',
  'gad_source',
  'gad',
  // Microsoft / Bing ads
  'msclkid',
  // Yandex
  'yclid',
  // Mailchimp
  'mc_cid',
  'mc_eid',
  // HubSpot
  '_hsenc',
  '_hsmi',
  // Generic
  'ref',
  'ref_src',
  'ref_url',
  'igshid',
]);

/**
 * Canonicalize a page URL into the form used as the comment root.
 * Returns null if the URL isn't a normal http(s) page.
 */
export function canonicalizePageUrl(input: string | URL | undefined | null): URL | null {
  if (!input) return null;
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : new URL(input.toString());
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  // Skip the extension's own pages and chrome-extension://* in general.
  if (url.host === '' || url.host.includes('extension')) {
    if (url.protocol.startsWith('chrome-extension')) return null;
  }

  // Drop fragment (#section).
  url.hash = '';

  // Strip known tracking params. Iterate over a snapshot of keys because
  // we mutate searchParams while iterating.
  const keys = [...url.searchParams.keys()];
  for (const key of keys) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }

  // Lowercase the host (URLs are case-insensitive on the authority).
  url.hostname = url.hostname.toLowerCase();

  // Drop a trailing "?" if the search params became empty.
  if (url.search === '') {
    // Already handled by the URL implementation; nothing to do.
  }

  // Drop default ports (URL already does this for :80/:443 implicitly).
  return url;
}

/**
 * Returns true if the URL is a commentable web page from the user's
 * point of view: http(s) only, not chrome://, not the extension's own
 * pages, etc.
 */
export function isCommentablePageUrl(input: string | URL | undefined | null): boolean {
  return canonicalizePageUrl(input) !== null;
}
