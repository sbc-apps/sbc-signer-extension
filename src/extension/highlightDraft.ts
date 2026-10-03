/**
 * In-memory store for pending highlight drafts.
 *
 * Flow:
 *  1. User right-clicks a selection and picks "Highlight on Nostr".
 *  2. Background asks the content script to scrape the selection +
 *     enclosing paragraph + `<link rel="me" nostr:...>` tags.
 *  3. The validated payload is stored here under a fresh `draftId`.
 *  4. Background opens `src/highlight.html?id=<draftId>` in a popup
 *     window. The composer fetches its draft via runtime message.
 *  5. After submit (or on window close), the draft is discarded.
 *
 * Drafts live only in service-worker memory. If Chrome evicts the SW
 * before the composer can fetch the draft, the composer will see
 * `null` and gracefully render an error state. We don't persist to
 * `chrome.storage` because the selection can contain sensitive page
 * content the user hasn't yet decided to publish.
 *
 * A simple TTL sweep prevents stranded drafts from accumulating if a
 * composer window is left open forever — the entry is dropped 5
 * minutes after creation regardless.
 */
import type { HighlightDraft } from './messages';

const DRAFT_TTL_MS = 5 * 60 * 1000;

const drafts = new Map<string, HighlightDraft>();

function genDraftId(): string {
  return `hl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sweep(): void {
  const cutoff = Date.now() - DRAFT_TTL_MS;
  for (const [id, draft] of drafts) {
    if (draft.createdAt < cutoff) drafts.delete(id);
  }
}

export function createDraft(draft: Omit<HighlightDraft, 'createdAt'>): string {
  sweep();
  const id = genDraftId();
  drafts.set(id, { ...draft, createdAt: Date.now() });
  return id;
}

export function getDraft(id: string): HighlightDraft | null {
  sweep();
  return drafts.get(id) ?? null;
}

export function discardDraft(id: string): void {
  drafts.delete(id);
}
