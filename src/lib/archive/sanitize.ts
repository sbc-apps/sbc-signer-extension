/**
 * Turn a captured DOM into an inert, self-contained document.
 *
 * Two jobs, and it's worth being clear which is which:
 *
 *  1. *Fidelity.* An archive has to render the same way years from now
 *     with no network and no JS. Scripts would re-run against a world
 *     that no longer exists, and preload hints point at origins that
 *     may be gone, so both come out.
 *  2. *Safety.* The output is published under the user's key and viewed
 *     by other people. Anything executable that survives capture would
 *     run on a gateway origin in someone else's browser.
 *
 * This runs twice — once in the content script on the live clone, and
 * again in the archive window on the reparsed document. The second pass
 * is defence in depth: the payload crosses a message boundary and gets
 * reparsed in between, and the cost of running it again is nil.
 */

/** Attribute-based script vectors. */
const EVENT_HANDLER_RE = /^on/i;

/** `<link rel>` values that only make sense against the live origin. */
const DEAD_LINK_RELS = new Set([
  'preload',
  'prefetch',
  'modulepreload',
  'dns-prefetch',
  'preconnect',
  'prerender',
  'manifest',
]);

export interface SanitizeResult {
  /** Number of `<script>` elements removed. */
  scripts: number;
  /** Number of frames removed (they'd otherwise load the live web). */
  frames: number;
  /** Number of inline event handler attributes removed. */
  handlers: number;
}

/**
 * Strip everything executable or origin-bound from `doc`, in place.
 */
export function sanitizeArchiveDocument(doc: Document): SanitizeResult {
  const result: SanitizeResult = { scripts: 0, frames: 0, handlers: 0 };

  for (const script of Array.from(doc.querySelectorAll('script'))) {
    script.remove();
    result.scripts++;
  }

  // Frames would fetch live content when the archive is viewed, which
  // defeats the point and leaks the viewer to the original host.
  for (const frame of Array.from(doc.querySelectorAll('iframe, frame, object, embed'))) {
    frame.remove();
    result.frames++;
  }

  // `<base>` would re-root every relative URL in the archive.
  for (const base of Array.from(doc.querySelectorAll('base'))) {
    base.remove();
  }

  for (const meta of Array.from(doc.querySelectorAll('meta[http-equiv]'))) {
    const value = meta.getAttribute('http-equiv')?.toLowerCase() ?? '';
    // A stored `refresh` would redirect the viewer off the archive; a
    // stored CSP would apply to the gateway origin, not the original.
    if (value === 'refresh' || value === 'content-security-policy') meta.remove();
  }

  for (const link of Array.from(doc.querySelectorAll('link[rel]'))) {
    const rels = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    if (rels.some((rel) => DEAD_LINK_RELS.has(rel))) link.remove();
  }

  for (const element of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(element.attributes)) {
      if (EVENT_HANDLER_RE.test(attr.name)) {
        element.removeAttribute(attr.name);
        result.handlers++;
      }
    }

    for (const attr of ['href', 'src', 'action', 'formaction'] as const) {
      const value = element.getAttribute(attr);
      if (value && /^\s*javascript:/i.test(value)) {
        element.removeAttribute(attr);
      }
    }
  }

  return result;
}

/**
 * Add provenance metadata and a belt-and-braces CSP.
 *
 * The CSP is the last line of defence for whoever opens the archive: if
 * any script vector survived sanitization, the viewer's browser refuses
 * to run it anyway. It deliberately constrains only active content —
 * images, styles and fonts must still load or the archive won't render.
 */
export function annotateArchiveDocument(
  doc: Document,
  meta: { sourceUrl: string; capturedAt: number },
): void {
  const head = doc.head ?? doc.documentElement;
  if (!head) return;

  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', "script-src 'none'; object-src 'none'; frame-src 'none'");
  head.insertBefore(csp, head.firstChild);

  for (const [name, content] of [
    ['archive:source', meta.sourceUrl],
    ['archive:captured-at', new Date(meta.capturedAt * 1000).toISOString()],
  ]) {
    const element = doc.createElement('meta');
    element.setAttribute('name', name);
    element.setAttribute('content', content);
    head.appendChild(element);
  }
}

/** Serialize a document back to a full HTML string. */
export function serializeDocument(doc: Document): string {
  const doctype = doc.doctype ? '<!DOCTYPE html>\n' : '';
  return `${doctype}${doc.documentElement.outerHTML}`;
}
