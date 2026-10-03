/**
 * Validate that a string is a well-formed HTTPS URL.
 *
 * Returns the normalised `href` when valid, or `undefined` otherwise.
 * MUST be used whenever a URL originates from untrusted Nostr event
 * data (tags, metadata fields, etc.) and will be placed into an `href`,
 * `src`, `window.open()`, or interpolated into CSS via `url()`.
 *
 * Rejecting non-`https:` schemes blocks `javascript:`, `data:`, and
 * `file:` URIs; the `URL` parser also percent-encodes `"`, `)`, and `\`,
 * which prevents CSS-string breakout when the result is interpolated
 * into a `url("…")` declaration.
 */
export function sanitizeUrl(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch {
    // not a valid URL
  }
  return undefined;
}
