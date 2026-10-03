/**
 * In-memory store for pending page archives.
 *
 * Flow:
 *  1. User clicks "Save as nsite" (popup button or context menu).
 *  2. Background asks the content script to serialize the live DOM.
 *  3. The payload is stored here under a fresh `draftId`.
 *  4. Background opens `src/archive.html?id=<draftId>`, which fetches
 *     the draft over a runtime message and runs the archive pipeline.
 *  5. After publishing (or on window close) the draft is discarded.
 *
 * Same reasoning as `highlightDraft.ts`, with more force: a captured
 * page is the user's *rendered* view, so on a logged-in site it can
 * contain private content they haven't agreed to publish yet. It never
 * touches `chrome.storage`, and it's dropped as soon as the archive
 * window is done with it.
 *
 * Drafts are also much larger than highlights, so the TTL sweep is
 * about reclaiming memory as well as limiting exposure.
 */
import type { ArchiveDraft } from './messages';

const DRAFT_TTL_MS = 10 * 60 * 1000;

const drafts = new Map<string, ArchiveDraft>();

function genDraftId(): string {
  return `ar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sweep(): void {
  const cutoff = Date.now() - DRAFT_TTL_MS;
  for (const [id, draft] of drafts) {
    if (draft.createdAt < cutoff) drafts.delete(id);
  }
}

export function createArchiveDraft(draft: Omit<ArchiveDraft, 'createdAt'>): string {
  sweep();
  const id = genDraftId();
  drafts.set(id, { ...draft, createdAt: Date.now() });
  return id;
}

export function getArchiveDraft(id: string): ArchiveDraft | null {
  sweep();
  return drafts.get(id) ?? null;
}

export function discardArchiveDraft(id: string): void {
  drafts.delete(id);
}
