/**
 * Highlight composer — opened by the background as a popup window when
 * the user right-clicks a selection and picks "Highlight on Nostr".
 *
 * URL: `src/highlight.html?id=<draftId>`. The draft is fetched from
 * the background's in-memory store on mount. The user sees a preview
 * of their selection (with surrounding paragraph context highlighted
 * the same way Ditto renders kind 9802), an optional comment field,
 * and a submit button. Submitting publishes a single kind 9802
 * highlight to the user's relay pool — the optional comment travels
 * as a `comment` tag on that same event (NIP-84 "Quote Highlights"),
 * not as a separate kind 1 / kind 1111 reply.
 *
 * Visual identity mirrors Ditto's `HighlightContent` blockquote
 * (`rounded-r-xl border-l-4 border-primary/70 bg-primary/5`, serif
 * body, `<mark>` for the matched excerpt inside context).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Quote, X } from 'lucide-react';

import { Logo } from '@/components/Logo';
import { SiteHeader } from '@/components/SiteHeader';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { usePostHighlight } from '@/hooks/usePostHighlight';
import type { HighlightDraft } from '@/extension/messages';
import { cn } from '@/lib/utils';

const MAX_COMMENT_HEIGHT = 180;

export function HighlightComposer() {
  const draftId = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('id') ?? '';
  }, []);

  const hasChromeRuntime =
    typeof chrome !== 'undefined' && !!chrome.runtime?.sendMessage;

  const { user } = useCurrentUser();
  // `undefined` = still loading from background; `null` = no draft
  // (missing id, no chrome.runtime, or background returned null).
  const [draft, setDraft] = useState<HighlightDraft | null | undefined>(() =>
    draftId && hasChromeRuntime ? undefined : null,
  );
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { mutateAsync: postHighlight, isPending } = usePostHighlight();

  // Load the draft from the background on mount. Skips entirely when
  // there's nothing to load — the initial state is already `null` in
  // that case, so we don't need to call setDraft from the effect body.
  useEffect(() => {
    if (!draftId || !hasChromeRuntime) return;
    let cancelled = false;
    chrome.runtime
      .sendMessage({ kind: 'get-highlight-draft', draftId })
      .then((response: unknown) => {
        if (cancelled) return;
        const next =
          response && typeof response === 'object' && 'draft' in response
            ? ((response as { draft?: HighlightDraft | null }).draft ?? null)
            : null;
        setDraft(next);
      })
      .catch(() => {
        if (!cancelled) setDraft(null);
      });
    return () => {
      cancelled = true;
    };
  }, [draftId, hasChromeRuntime]);

  // Auto-grow the comment box (same pattern as `CommentForm`).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMMENT_HEIGHT)}px`;
  }, [comment]);

  const handleClose = useCallback(() => {
    if (draftId && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime
        .sendMessage({ kind: 'discard-highlight-draft', draftId })
        .catch(() => {});
    }
    window.close();
  }, [draftId]);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!draft || !user || isPending) return;
      setError(null);
      try {
        await postHighlight({
          selectionText: draft.selectionText,
          contextText: draft.contextText,
          pageUrl: draft.pageUrl,
          pAuthors: draft.pAuthors,
          comment: comment.trim() ? comment.trim() : undefined,
        });
        if (draftId && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime
            .sendMessage({ kind: 'discard-highlight-draft', draftId })
            .catch(() => {});
        }
        window.close();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [comment, draft, draftId, isPending, postHighlight, user],
  );

  return (
    <div className="flex flex-col min-h-screen w-full bg-background text-foreground">
      <header className="flex items-center justify-between gap-2 px-4 h-14 border-b shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Logo className="size-7 shrink-0" alt="SBC Signer" />
          <span className="font-semibold text-sm truncate">Highlight on Nostr</span>
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={handleClose}
          aria-label="Close"
          className="size-8 rounded-full"
        >
          <X className="size-4" />
        </Button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {draft === undefined ? (
          <LoadingState />
        ) : draft === null ? (
          <EmptyState onClose={handleClose} />
        ) : !user ? (
          <NotLoggedInState onClose={handleClose} />
        ) : (
          <ComposerBody
            draft={draft}
            comment={comment}
            onCommentChange={setComment}
            onSubmit={handleSubmit}
            textareaRef={textareaRef}
            error={error}
            isPending={isPending}
            onCancel={handleClose}
          />
        )}
      </div>
    </div>
  );
}

interface ComposerBodyProps {
  draft: HighlightDraft;
  comment: string;
  onCommentChange: (value: string) => void;
  onSubmit: (e?: React.FormEvent) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  error: string | null;
  isPending: boolean;
  onCancel: () => void;
}

function ComposerBody({
  draft,
  comment,
  onCommentChange,
  onSubmit,
  textareaRef,
  error,
  isPending,
  onCancel,
}: ComposerBodyProps) {
  const hostname = useMemo(() => {
    try {
      return new URL(draft.pageUrl).host;
    } catch {
      return draft.pageUrl;
    }
  }, [draft.pageUrl]);

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4 px-4 py-4">
      <SiteHeader
        origin={draft.pageUrl}
        icon={draft.pageIcon}
        title={draft.pageTitle}
      />

      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <Quote className="size-3" />
          Highlight preview
        </div>
        <HighlightPreview
          selectionText={draft.selectionText}
          contextText={draft.contextText}
        />
        <p className="text-[11px] text-muted-foreground">
          Highlighted from <span className="font-mono">{hostname}</span>
          {draft.pAuthors.length > 0 ? (
            <>
              {' · '}attributing {draft.pAuthors.length} author
              {draft.pAuthors.length === 1 ? '' : 's'}
            </>
          ) : null}
        </p>
      </div>

      <div className="space-y-1.5">
        <label
          htmlFor="highlight-comment"
          className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          Comment (optional)
        </label>
        <div className="rounded-lg border bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-0">
          <textarea
            id="highlight-comment"
            ref={textareaRef}
            value={comment}
            onChange={(e) => onCommentChange(e.target.value)}
            placeholder="Add a comment to share with this highlight…"
            disabled={isPending}
            rows={2}
            dir="auto"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                onSubmit();
              }
            }}
            className={cn(
              'w-full bg-transparent outline-none resize-none px-3 py-2',
              'text-foreground placeholder:text-muted-foreground',
              'text-sm break-words overflow-hidden min-h-[60px]',
            )}
          />
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={isPending}
          className="rounded-full px-4"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={isPending}
          className="rounded-full px-5 font-semibold"
        >
          {isPending ? (
            <>
              <Loader2 className="size-3.5 animate-spin mr-1.5" />
              Posting…
            </>
          ) : (
            'Post highlight'
          )}
        </Button>
      </div>
    </form>
  );
}

/**
 * Pull-quote preview. Mirrors Ditto's `HighlightContent` blockquote
 * (rounded right, primary-tinted left border, serif body). When a
 * valid `contextText` is supplied, the surrounding paragraph is
 * rendered in muted text with the excerpt wrapped in a `<mark>` — the
 * same pattern Ditto's `ContextualHighlight` uses.
 */
function HighlightPreview({
  selectionText,
  contextText,
}: {
  selectionText: string;
  contextText: string | null;
}) {
  // Only render context when the invariant Ditto enforces also holds
  // here — otherwise the preview would lie about what gets published.
  const valid =
    typeof contextText === 'string' &&
    contextText.length > selectionText.length &&
    contextText.includes(selectionText);

  if (!valid) {
    return (
      <blockquote className="rounded-r-xl border-l-4 border-primary/70 bg-primary/5 px-4 py-3">
        <p className="whitespace-pre-wrap break-words font-serif text-[15px] leading-relaxed text-foreground">
          {selectionText}
        </p>
      </blockquote>
    );
  }

  // Safe because we just checked .includes() above.
  const idx = contextText.indexOf(selectionText);
  const before = contextText.slice(0, idx);
  const after = contextText.slice(idx + selectionText.length);

  return (
    <blockquote className="rounded-r-xl border-l-4 border-primary/70 bg-primary/5 px-4 py-3">
      <p className="whitespace-pre-wrap break-words font-serif text-[15px] leading-relaxed">
        <span className="text-muted-foreground">{before}</span>
        <mark className="rounded bg-primary/25 px-0.5 text-foreground">
          {selectionText}
        </mark>
        <span className="text-muted-foreground">{after}</span>
      </p>
    </blockquote>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
      <p className="text-xs">Loading highlight…</p>
    </div>
  );
}

function EmptyState({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center gap-4">
      <Logo className="size-12" alt="SBC Signer" />
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Highlight unavailable</h2>
        <p className="text-xs text-muted-foreground max-w-[260px]">
          This highlight draft expired or was already submitted. Right-click your selection
          again to start over.
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={onClose} className="rounded-full px-5">
        Close
      </Button>
    </div>
  );
}

function NotLoggedInState({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center gap-4">
      <Logo className="size-12" alt="SBC Signer" />
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Sign in to highlight</h2>
        <p className="text-xs text-muted-foreground max-w-[260px]">
          Open the SBC Signer Extension toolbar to log in, then try the right-click menu again.
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={onClose} className="rounded-full px-5">
        Close
      </Button>
    </div>
  );
}

export default HighlightComposer;
