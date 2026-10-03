/**
 * Content script — bridges the inpage `window.nostr` provider with the
 * background service worker.
 *
 * Runs in the page's ISOLATED world. The companion `inpage.ts` runs in
 * the MAIN world (declared separately in `manifest.json` with
 * `"world": "MAIN"`) and can't call `chrome.runtime.sendMessage`
 * directly, so we relay requests here.
 *
 *  page           content                 background
 *  ────▶  window.postMessage  ────▶  chrome.runtime.sendMessage
 *  ◀────  window.postMessage  ◀────  sendResponse
 */
import {
  clipContext,
  MAX_CONTEXT_LENGTH,
  normalizeText,
} from '@/lib/highlightContext';

import { captureArchive } from './archiveCapture';

import type {
  HighlightCollection,
  InternalMessage,
  NostrEventPush,
  NostrRpcRequest,
  NostrRpcResponse,
  PageMessage,
} from './messages';

const MESSAGE_SCOPE = 'sbc-signer-extension' as const;

function isPageMessage(data: unknown): data is PageMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { scope?: unknown }).scope === MESSAGE_SCOPE
  );
}

// Listen for requests from the page.
window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  if (!isPageMessage(event.data)) return;
  const msg = event.data;
  if (msg.kind !== 'request') return;
  const req: NostrRpcRequest = msg;

  const internal: InternalMessage = {
    kind: 'signer-rpc',
    method: req.method,
    params: req.params,
    origin: req.origin,
    userActivated: req.userActivated,
  };

  let response: NostrRpcResponse;
  try {
    const result = await chrome.runtime.sendMessage(internal);
    if (
      result &&
      typeof result === 'object' &&
      'error' in result &&
      typeof result.error === 'string'
    ) {
      response = {
        scope: MESSAGE_SCOPE,
        kind: 'response',
        id: req.id,
        error: result.error,
      };
    } else {
      response = {
        scope: MESSAGE_SCOPE,
        kind: 'response',
        id: req.id,
        result: (result as { result?: unknown })?.result,
      };
    }
  } catch (err) {
    response = {
      scope: MESSAGE_SCOPE,
      kind: 'response',
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  window.postMessage(response, window.location.origin);
});

// Relay pushes (e.g. `accountChanged`) from background to the page.
chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isPageMessage(message)) return;
  if (message.kind !== 'event') return;
  const push: NostrEventPush = message;
  window.postMessage(push, window.location.origin);
});

// ---------------------------------------------------------------------------
// "Highlight on Nostr" — selection collector
// ---------------------------------------------------------------------------

/**
 * Tags that always qualify as a "paragraph" for the NIP-84 `context`
 * tag, regardless of how the page styles them.
 */
const PARAGRAPH_SELECTOR =
  'p, li, blockquote, figcaption, dd, dt, h1, h2, h3, h4, h5, h6';

/** Don't climb forever on pathologically deep DOMs. */
const MAX_CONTEXT_ANCESTORS = 24;

/**
 * Landmarks and controls that only show up in page furniture, never
 * inside a passage of prose. Reaching one means the climb has left the
 * article body and started scraping UI chrome — on a Reddit post card
 * that's the subreddit crumb, the byline, the timestamp and the
 * "Share" button, none of which belong in a `context` tag.
 */
const CHROME_SELECTOR = [
  'button',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'input',
  'select',
  'textarea',
  'menu',
  '[role="button"]',
  '[role="navigation"]',
  '[role="toolbar"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="tablist"]',
  '[contenteditable="true"]',
].join(', ');

/**
 * Whether an element frames a passage of prose. Plenty of sites never
 * emit a `<p>` — editors and app-rendered content wrap each paragraph
 * in a `<div>`/`<span>` soup (e.g. Slate's `<span data-text="true">`)
 * — so fall back to the computed `display` rather than trusting tag
 * names alone. Pure `inline` boxes are skipped because they usually
 * wrap a fragment of a sentence rather than its surroundings;
 * `inline-block` and friends still establish a block container, so
 * they count.
 */
function isContextBlock(element: Element): boolean {
  if (element.matches(PARAGRAPH_SELECTOR)) return true;
  const { display } = getComputedStyle(element);
  return display !== 'inline' && display !== 'contents' && display !== 'none';
}

/** Whether this subtree mixes UI chrome in with the prose. */
function containsChrome(element: Element): boolean {
  return element.matches(CHROME_SELECTOR) || element.querySelector(CHROME_SELECTOR) !== null;
}

/**
 * The element's *rendered* text.
 *
 * `textContent` is wrong here: it returns the source text of every
 * descendant, including `<script>` and `<style>` bodies and anything
 * behind `display: none`. Reddit inlines a `SML.load([...])` call
 * inside the post card, so a `textContent`-derived context shipped ~1.3
 * KB of minified asset IDs as if it were prose. `innerText` is defined
 * in terms of what's actually painted, which also matches
 * `Selection.toString()` — the source of the excerpt we have to stay
 * consistent with.
 *
 * Falls back to `textContent` for non-HTML elements (SVG, MathML) and
 * for environments without `innerText` (jsdom).
 */
function renderedText(element: Element): string {
  if (element instanceof HTMLElement && typeof element.innerText === 'string') {
    return element.innerText;
  }
  return element.textContent ?? '';
}

/**
 * Walk up from the selection to the nearest block that actually adds
 * surrounding prose. Climbing (rather than taking the first block)
 * matters when the user selects a whole paragraph: the paragraph
 * itself is not context, but its wrapper — a few paragraphs of the
 * article — is. Whatever we land on is then clipped to the length cap
 * rather than discarded, so a single-`<div>` page still yields context.
 *
 * The climb stops at the first ancestor that drags in UI chrome. On a
 * single-paragraph post there is no surrounding prose to find, and
 * every ancestor above that point is a superset of the same chrome, so
 * no context is the honest answer.
 */
function findContext(selection: Selection, normalizedSelection: string): string | null {
  if (selection.isCollapsed || selection.rangeCount === 0) return null;
  // No room left for surroundings — there'd be nothing to clip to.
  if (normalizedSelection.length >= MAX_CONTEXT_LENGTH) return null;

  const range = selection.getRangeAt(0);
  const anchor: Node = range.commonAncestorContainer;
  let element =
    anchor.nodeType === Node.ELEMENT_NODE
      ? (anchor as Element)
      : anchor.parentElement;

  for (let depth = 0; element && depth < MAX_CONTEXT_ANCESTORS; depth++) {
    if (containsChrome(element)) return null;
    const text = normalizeText(renderedText(element));
    if (
      text.length > normalizedSelection.length &&
      text.includes(normalizedSelection) &&
      isContextBlock(element)
    ) {
      return clipContext(text, normalizedSelection);
    }
    element = element.parentElement;
  }

  return null;
}

function readPageUrl(): string {
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (canonical?.href) return canonical.href;
  return location.href;
}

function readFavicon(): string | undefined {
  const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  return link?.href || undefined;
}

/**
 * Collect every `<link rel="me">` (or `rel~="me"`) whose `href`
 * starts with `nostr:`. Returns the raw href strings; the background
 * decodes them so we don't pull `@nostrify/nostrify` into the
 * content bundle.
 */
function collectMeNostrHrefs(): string[] {
  const links = document.querySelectorAll<HTMLLinkElement>('link[rel~="me"]');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const link of Array.from(links)) {
    const href = link.getAttribute('href');
    if (!href) continue;
    if (!href.toLowerCase().startsWith('nostr:')) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

function collectHighlight(fallbackSelection: string): HighlightCollection | null {
  const selection = window.getSelection();
  // Prefer the live selection: it preserves the user's exact whitespace.
  // Fall back to `info.selectionText` from the context-menu event if
  // a page handler cleared the selection between mousedown and the
  // message arriving (rare, but possible).
  const rawSelection =
    (selection && !selection.isCollapsed && selection.toString()) || fallbackSelection || '';
  const normalizedSelection = normalizeText(rawSelection);
  if (!normalizedSelection) return null;

  const contextText = selection
    ? findContext(selection, normalizedSelection)
    : null;

  return {
    selectionText: normalizedSelection,
    contextText,
    pageUrl: readPageUrl(),
    pageTitle: document.title || undefined,
    pageIcon: readFavicon(),
    meNostrHrefs: collectMeNostrHrefs(),
  };
}

chrome.runtime.onMessage.addListener((rawMessage, _sender, sendResponse) => {
  const message = rawMessage as InternalMessage;
  if (!message || typeof message !== 'object' || !('kind' in message)) return false;

  if (message.kind === 'collect-highlight') {
    // Synchronous handling — `getSelection()` must be read on the same
    // task as the message arrival so a content-menu-triggered selection
    // clear in the page can't race us.
    try {
      const payload = collectHighlight(message.fallbackSelection);
      sendResponse({ ok: true, payload });
    } catch (err) {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  }

  if (message.kind === 'collect-archive') {
    // Only the top-level document is archived; a page's iframes are
    // dropped during sanitization, so their content scripts have
    // nothing to contribute and would race to answer the same message.
    if (window.top !== window) return false;

    try {
      sendResponse({ ok: true, payload: captureArchive() });
    } catch (err) {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  }

  return false;
});
