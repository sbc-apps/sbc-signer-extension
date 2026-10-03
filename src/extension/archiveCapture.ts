/**
 * Snapshot the live page for archiving.
 *
 * Runs in the content script because this is the only place the *post-
 * JavaScript* DOM exists. Refetching the URL from the background would
 * get the server's HTML, which on any app-rendered site is an empty
 * shell — the whole reason a "save this page" feature has to work from
 * inside the page.
 *
 * What leaves here is a serialized, script-free HTML string plus a
 * little metadata. Subresources are *not* fetched here: in MV3 a
 * content script's `fetch` is bound by the page's CORS rules, so most
 * assets are unreadable. That job belongs to the archive window, which
 * inherits the extension's `host_permissions`.
 */
import { sanitizeArchiveDocument, serializeDocument } from '@/lib/archive/sanitize';

import type { ArchiveCollection } from './messages';

/**
 * Serialize `document.adoptedStyleSheets` into a real `<style>`.
 *
 * Constructed stylesheets — what web components and most CSS-in-JS
 * runtimes use — have no representation in the markup at all. Without
 * this the archive of such a page renders completely unstyled, and
 * there's no URL to fetch later to recover it.
 */
function inlineAdoptedStyleSheets(source: Document, clone: Document): void {
  const sheets = source.adoptedStyleSheets ?? [];
  if (sheets.length === 0) return;

  const rules: string[] = [];
  for (const sheet of sheets) {
    try {
      for (const rule of Array.from(sheet.cssRules)) rules.push(rule.cssText);
    } catch {
      // Cross-origin constructed sheets can't be read; nothing to do.
    }
  }

  if (rules.length === 0) return;

  const style = clone.createElement('style');
  style.setAttribute('data-archive', 'adopted-stylesheets');
  style.textContent = rules.join('\n');
  (clone.head ?? clone.documentElement).appendChild(style);
}

/**
 * Freeze `<canvas>` contents into `<img>` elements.
 *
 * A canvas in the archive would be blank — whatever drew it is gone
 * with the scripts. Canvases tainted by cross-origin drawing throw on
 * `toDataURL`, in which case the element is left as-is.
 */
function freezeCanvases(source: Document, clone: Document): number {
  const originals = Array.from(source.querySelectorAll('canvas'));
  const clones = Array.from(clone.querySelectorAll('canvas'));
  let frozen = 0;

  for (const [index, original] of originals.entries()) {
    const target = clones[index];
    if (!target) continue;

    let dataUrl: string;
    try {
      dataUrl = original.toDataURL('image/png');
    } catch {
      continue;
    }

    const image = clone.createElement('img');
    image.setAttribute('src', dataUrl);
    image.setAttribute('width', String(original.width));
    image.setAttribute('height', String(original.height));
    const style = target.getAttribute('style');
    if (style) image.setAttribute('style', style);

    target.replaceWith(image);
    frozen++;
  }

  return frozen;
}

/**
 * Persist the *current* value of form controls.
 *
 * Values live in the DOM's property state, not its attributes, so a
 * plain `outerHTML` of a filled-in form serializes as empty.
 */
function persistFormState(source: Document, clone: Document): void {
  const pairs: Array<[string, string]> = [
    ['input', 'value'],
    ['textarea', 'value'],
  ];

  for (const [selector] of pairs) {
    const originals = Array.from(source.querySelectorAll(selector));
    const clones = Array.from(clone.querySelectorAll(selector));

    for (const [index, original] of originals.entries()) {
      const target = clones[index];
      if (!target) continue;

      if (original instanceof HTMLInputElement && target instanceof HTMLInputElement) {
        // Never serialize secrets into a document we're about to publish.
        if (original.type === 'password') {
          target.removeAttribute('value');
          continue;
        }
        if (original.type === 'checkbox' || original.type === 'radio') {
          if (original.checked) target.setAttribute('checked', '');
          else target.removeAttribute('checked');
          continue;
        }
        target.setAttribute('value', original.value);
      } else if (
        original instanceof HTMLTextAreaElement &&
        target instanceof HTMLTextAreaElement
      ) {
        target.textContent = original.value;
      }
    }
  }
}

function readCanonicalUrl(): string {
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  return canonical?.href || location.href;
}

function readFavicon(): string | undefined {
  const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  return link?.href || undefined;
}

/** Capture the current document as an archivable HTML string. */
export function captureArchive(): ArchiveCollection {
  const clone = document.implementation.createHTMLDocument('');
  clone.replaceChild(clone.importNode(document.documentElement, true), clone.documentElement);

  inlineAdoptedStyleSheets(document, clone);
  const canvases = freezeCanvases(document, clone);
  persistFormState(document, clone);

  const sanitized = sanitizeArchiveDocument(clone);

  return {
    html: serializeDocument(clone),
    // `location.href` rather than the canonical URL: an archive should
    // record the page the user actually looked at, and a canonical tag
    // can point somewhere with different content.
    pageUrl: location.href,
    canonicalUrl: readCanonicalUrl(),
    pageTitle: document.title || undefined,
    pageIcon: readFavicon(),
    capturedAt: Math.floor(Date.now() / 1000),
    stats: { ...sanitized, canvases },
  };
}
