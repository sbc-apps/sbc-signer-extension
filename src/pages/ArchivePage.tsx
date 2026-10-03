/**
 * Archive window — opened by the background when the user picks
 * "Save as nsite" from the popup or the page context menu.
 *
 * URL: `src/archive.html?id=<draftId>`. The captured page is fetched
 * from the background's in-memory store on mount, then:
 *
 *   analyze → review → upload → publish → verify → result
 *
 * The review step is a hard stop. Publishing uploads the user's
 * rendered view of the page to public Blossom servers under their own
 * key, which on a logged-in site can mean private content, and blobs
 * can't be meaningfully unpublished. So the user sees the size, the
 * file count and an explicit warning before anything is sent.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  X,
} from 'lucide-react';

import { Logo } from '@/components/Logo';
import { SiteHeader } from '@/components/SiteHeader';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useArchivePublisher, type ArchiveResult } from '@/hooks/useArchivePublisher';
import { formatBytes, type BuiltArchive } from '@/lib/archive/pipeline';
import type { ArchiveDraft } from '@/extension/messages';

export function ArchivePage() {
  const draftId = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('id') ?? '';
  }, []);

  const hasChromeRuntime = typeof chrome !== 'undefined' && !!chrome.runtime?.sendMessage;

  const { user } = useCurrentUser();
  // `undefined` = still loading from background; `null` = unavailable.
  const [draft, setDraft] = useState<ArchiveDraft | null | undefined>(() =>
    draftId && hasChromeRuntime ? undefined : null,
  );

  const { status, analyze, publish, cancel } = useArchivePublisher(draft);

  useEffect(() => {
    if (!draftId || !hasChromeRuntime) return;
    let cancelled = false;

    chrome.runtime
      .sendMessage({ kind: 'get-archive-draft', draftId })
      .then((response: unknown) => {
        if (cancelled) return;
        const next =
          response && typeof response === 'object' && 'draft' in response
            ? ((response as { draft?: ArchiveDraft | null }).draft ?? null)
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

  // Start fetching subresources as soon as there's something to work
  // on. Nothing is uploaded until the user confirms at the review step.
  useEffect(() => {
    if (draft && user) void analyze();
  }, [analyze, draft, user]);

  const discardDraft = useCallback(() => {
    if (draftId && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ kind: 'discard-archive-draft', draftId }).catch(() => {});
    }
  }, [draftId]);

  const handleClose = useCallback(() => {
    cancel();
    discardDraft();
    window.close();
  }, [cancel, discardDraft]);

  // The captured page is large and can hold logged-in content, so drop
  // it from the background as soon as it's no longer needed.
  useEffect(() => {
    if (status.phase === 'done') discardDraft();
  }, [discardDraft, status.phase]);

  return (
    <div className="flex flex-col min-h-screen w-full bg-background text-foreground">
      <header className="flex items-center justify-between gap-2 px-4 h-14 border-b shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Logo className="size-7 shrink-0" alt="SBC Signer" />
          <span className="font-semibold text-sm truncate">Save as nsite</span>
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
          <CenteredState icon={<Loader2 className="size-5 animate-spin" />} label="Loading page…" />
        ) : draft === null ? (
          <MessageState
            title="Nothing to archive"
            body="This capture expired or was already published. Try saving the page again."
            onClose={handleClose}
          />
        ) : !user ? (
          <MessageState
            title="Sign in to save an archive"
            body="Open the SBC Signer Extension toolbar to log in, then try again."
            onClose={handleClose}
          />
        ) : (
          <ArchiveBody
            draft={draft}
            status={status}
            onPublish={publish}
            onClose={handleClose}
            onRetry={analyze}
          />
        )}
      </div>
    </div>
  );
}

interface ArchiveBodyProps {
  draft: ArchiveDraft;
  status: ReturnType<typeof useArchivePublisher>['status'];
  onPublish: (archive: BuiltArchive) => void;
  onClose: () => void;
  onRetry: () => void;
}

function ArchiveBody({ draft, status, onPublish, onClose, onRetry }: ArchiveBodyProps) {
  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <SiteHeader origin={draft.pageUrl} icon={draft.pageIcon} title={draft.pageTitle} />

      {status.phase === 'analyzing' && (
        <ProgressCard
          label={
            status.progress?.phase === 'building'
              ? 'Preparing files…'
              : 'Collecting page assets…'
          }
          completed={status.progress?.completed ?? 0}
          total={status.progress?.total ?? 0}
        />
      )}

      {status.phase === 'review' && (
        <ReviewCard archive={status.archive} onPublish={() => onPublish(status.archive)} onCancel={onClose} />
      )}

      {status.phase === 'uploading' && (
        <ProgressCard label="Uploading to Blossom…" completed={status.completed} total={status.total} />
      )}

      {status.phase === 'publishing' && <ProgressCard label="Publishing manifest…" completed={0} total={0} />}
      {status.phase === 'verifying' && <ProgressCard label="Verifying…" completed={0} total={0} />}

      {status.phase === 'done' && <ResultCard result={status.result} onClose={onClose} />}

      {status.phase === 'error' && (
        <div className="space-y-3">
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {status.message}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} className="rounded-full px-4">
              Close
            </Button>
            <Button size="sm" onClick={onRetry} className="rounded-full px-5 font-semibold">
              Try again
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProgressCard({
  label,
  completed,
  total,
}: {
  label: string;
  completed: number;
  total: number;
}) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : null;

  return (
    <div className="rounded-xl border bg-card px-4 py-5 space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <span>{label}</span>
      </div>
      {pct !== null && (
        <>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-[11px] text-muted-foreground">
            {completed} of {total} files
          </p>
        </>
      )}
    </div>
  );
}

function ReviewCard({
  archive,
  onPublish,
  onCancel,
}: {
  archive: BuiltArchive;
  onPublish: () => void;
  onCancel: () => void;
}) {
  const [showSkipped, setShowSkipped] = useState(false);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card px-4 py-4 space-y-3">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <Archive className="size-3" />
          Ready to publish
        </div>
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Files</dt>
          <dd className="text-right font-medium">{archive.blobs.length}</dd>
          <dt className="text-muted-foreground">Total size</dt>
          <dd className="text-right font-medium">{formatBytes(archive.totalBytes)}</dd>
        </dl>

        {archive.skipped.length > 0 && (
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setShowSkipped((prev) => !prev)}
              className="text-[11px] text-muted-foreground underline underline-offset-2"
            >
              {archive.skipped.length} asset{archive.skipped.length === 1 ? '' : 's'} skipped
            </button>
            {showSkipped && (
              <ul className="mt-2 space-y-1 max-h-32 overflow-y-auto">
                {archive.skipped.map((item) => (
                  <li key={`${item.url}-${item.reason}`} className="text-[11px] text-muted-foreground">
                    <span className="font-mono break-all">{shorten(item.url)}</span> — {item.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
        <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-500" />
        <p className="text-xs text-amber-900 dark:text-amber-200">
          This publishes the page <strong>as you see it</strong> to public Blossom servers under
          your Nostr key. If you're logged in to this site, private content will be included and
          cannot be reliably deleted afterwards.
        </p>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} className="rounded-full px-4">
          Cancel
        </Button>
        <Button size="sm" onClick={onPublish} className="rounded-full px-5 font-semibold">
          Publish archive
        </Button>
      </div>
    </div>
  );
}

function ResultCard({ result, onClose }: { result: ArchiveResult; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    navigator.clipboard
      .writeText(result.url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, [result.url]);

  const reachedRelays = result.relays.filter((relay) => relay.ok);
  const missedRelays = result.relays.filter((relay) => !relay.ok);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card px-4 py-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Check className="size-4 text-emerald-600 dark:text-emerald-500" />
          Archive published
        </div>

        <div className="flex items-center gap-1.5">
          <a
            href={result.url}
            target="_blank"
            rel="noreferrer noopener"
            className="flex-1 min-w-0 truncate rounded-lg border bg-muted/50 px-2.5 py-1.5 font-mono text-[11px] hover:bg-muted"
          >
            {result.url}
          </a>
          <Button
            size="icon"
            variant="ghost"
            onClick={copy}
            aria-label="Copy archive URL"
            className="size-8 shrink-0 rounded-full"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
          <Button size="icon" variant="ghost" asChild className="size-8 shrink-0 rounded-full">
            <a href={result.url} target="_blank" rel="noreferrer noopener" aria-label="Open archive">
              <ExternalLink className="size-3.5" />
            </a>
          </Button>
        </div>

        <dl className="grid grid-cols-2 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">Blossom servers</dt>
          <dd className="text-right">{result.servers.length}</dd>
          <dt className="text-muted-foreground">Relays</dt>
          <dd className="text-right">
            {reachedRelays.length} of {result.relays.length}
          </dd>
        </dl>
      </div>

      {(missedRelays.length > 0 || result.droppedServers.length > 0) && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-amber-900 dark:text-amber-200">
            <AlertTriangle className="size-3.5" />
            Partially published
          </div>
          <ul className="space-y-0.5 text-[11px] text-amber-900/90 dark:text-amber-200/90">
            {missedRelays.map((relay) => (
              <li key={relay.relay} className="break-all">
                {relay.relay} — manifest not readable back
              </li>
            ))}
            {result.droppedServers.map(({ server, error }) => (
              <li key={server} className="break-all">
                {server} — {error}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-end">
        <Button size="sm" onClick={onClose} className="rounded-full px-5 font-semibold">
          Done
        </Button>
      </div>
    </div>
  );
}

function CenteredState({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
      {icon}
      <p className="text-xs">{label}</p>
    </div>
  );
}

function MessageState({
  title,
  body,
  onClose,
}: {
  title: string;
  body: string;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center gap-4">
      <Logo className="size-12" alt="SBC Signer" />
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground max-w-[280px]">{body}</p>
      </div>
      <Button size="sm" variant="outline" onClick={onClose} className="rounded-full px-5">
        Close
      </Button>
    </div>
  );
}

function shorten(url: string): string {
  return url.length > 64 ? `${url.slice(0, 61)}…` : url;
}

export default ArchivePage;
