/**
 * Pure text helpers for the NIP-84 `context` tag.
 *
 * Kept out of `src/extension/content.ts` so they can be unit-tested
 * without a DOM — the traversal that picks *which* element to read
 * stays in the content script.
 */

/** Cap the context tag at a sensible size so we don't ship a whole page. */
export const MAX_CONTEXT_LENGTH = 2000;

/** Marks a side of the context that was clipped by the length cap. */
export const ELLIPSIS = '\u2026';

/**
 * Sentence-ending punctuation, allowing for a trailing quote or
 * bracket (`he said "stop."` / `(see below.)`).
 */
const SENTENCE_END = '[.!?]["\'\\)\\]\u201d\u2019]*';

/**
 * Collapse all runs of whitespace (including newlines and tabs) into
 * a single space and trim. NIP-84's `context.includes(content)`
 * invariant is checked on the *normalized* form so an excerpt that
 * spans inline tags (e.g. `<em>foo</em> bar`) still matches the
 * block's combined text.
 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Move `from` forward to the nearest sentence start — else word
 * boundary — so a clipped context doesn't open mid-word. Never passes
 * `limit`, which would eat into the excerpt itself.
 */
function snapStart(text: string, from: number, limit: number): number {
  if (from <= 0) return from;
  const head = text.slice(from, limit);
  const sentence = new RegExp(`${SENTENCE_END}\\s+`).exec(head);
  if (sentence) return from + sentence.index + sentence[0].length;
  const space = head.indexOf(' ');
  if (space >= 0) return from + space + 1;
  return from;
}

/**
 * Move `to` backward to the nearest sentence end — else word boundary.
 * Never passes `limit` (the end of the excerpt).
 */
function snapEnd(text: string, to: number, limit: number): number {
  if (to >= text.length) return to;
  const tail = text.slice(limit, to);
  let last = -1;
  for (const match of tail.matchAll(new RegExp(`${SENTENCE_END}(?=\\s|$)`, 'g'))) {
    last = (match.index ?? 0) + match[0].length;
  }
  if (last >= 0) return limit + last;
  const space = tail.lastIndexOf(' ');
  if (space >= 0) return limit + space;
  return to;
}

/**
 * Clip an oversized block down to `MAX_CONTEXT_LENGTH`, centred on the
 * excerpt.
 *
 * Bailing out entirely (the original behaviour) meant app-rendered
 * pages that dump a whole essay into one `<div>` — no `<p>` tags, so
 * the nearest block that adds surrounding prose *is* the essay — never
 * got a `context` tag at all, however short the selection was. A window
 * keeps NIP-84's `context.includes(content)` invariant intact while
 * still bounding what we publish.
 *
 * Returns `null` when no window can satisfy the invariant while also
 * adding surrounding prose.
 */
export function clipContext(text: string, selection: string): string | null {
  if (!selection) return null;
  if (text.length <= MAX_CONTEXT_LENGTH) {
    return text.length > selection.length && text.includes(selection) ? text : null;
  }

  const idx = text.indexOf(selection);
  if (idx < 0) return null;
  const selEnd = idx + selection.length;

  // Hold back room for the ellipsis on each clipped side.
  const budget = MAX_CONTEXT_LENGTH - selection.length - 2 * ELLIPSIS.length;
  if (budget <= 0) return null;

  // Split the budget evenly, then let each side spend whatever the
  // other can't use — an excerpt near either edge of the block has
  // little or no prose on that side.
  const roomBefore = idx;
  const roomAfter = text.length - selEnd;
  let takeBefore = Math.min(roomBefore, Math.ceil(budget / 2));
  const takeAfter = Math.min(roomAfter, budget - takeBefore);
  takeBefore = Math.min(roomBefore, budget - takeAfter);

  const start = snapStart(text, idx - takeBefore, idx);
  const end = snapEnd(text, selEnd + takeAfter, selEnd);

  // Snapping can consume every surrounding character (the excerpt butts
  // up against a sentence break on both sides), leaving context that
  // adds nothing. Downstream drops that anyway, so drop it here.
  if (end - start <= selection.length) return null;

  return (
    (start > 0 ? ELLIPSIS : '') +
    text.slice(start, end) +
    (end < text.length ? ELLIPSIS : '')
  );
}
