/**
 * Prompt window — opened by the background service worker when a page
 * asks for a signer operation that isn't already allowed.
 *
 * The window is scoped to a single browser tab. While it is open, every
 * pending RPC call from that tab is batched into this same window,
 * grouped by method. Groups are presented to the user one at a time:
 * the prompt always shows the first remaining group, and resolving it
 * (allow / reject) advances to the next. There is no bulk
 * approve-everything affordance — the user must walk through each
 * group in turn.
 *
 * URL carries the batch id as `?id=...`. On mount, we fetch the
 * associated `PromptBatch` from the background script, then listen for
 * `prompt-batch-updated` pushes so the UI reflects new items arriving
 * from the page in real time.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, Loader2, ShieldAlert, ShieldX } from 'lucide-react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { EmbeddedPost, type UnsignedEventLike } from '@/components/EmbeddedPost';
import { Logo } from '@/components/Logo';
import { SiteHeader } from '@/components/SiteHeader';
import type {
  ConnectAction,
  ItemAction,
  NostrRpcMethod,
  PendingPromptGroup,
  PendingPromptItem,
  PromptAction,
  PromptBatch,
} from '@/extension/messages';
import { useAuthor } from '@/hooks/useAuthor';
import { useLoggedInAccounts } from '@/hooks/useLoggedInAccounts';
import { genUserName } from '@/lib/genUserName';
import { kindLabel } from '@/lib/eventKinds';
import { cn } from '@/lib/utils';
import { formatBTC, summarizePsbt, type PsbtSummary } from '@/lib/bitcoin';

/**
 * Wrapper around `summarizePsbt` that swallows decode errors and
 * returns `null` instead. Used by the prompt UI so a malformed PSBT
 * just renders the "couldn't decode" state instead of throwing.
 */
function summarizePsbtSafe(psbtHex: string, pubkey: string): PsbtSummary | null {
  try {
    return summarizePsbt(psbtHex, pubkey);
  } catch {
    return null;
  }
}

const METHOD_COPY: Record<NostrRpcMethod, { title: string; lede: string }> = {
  getPublicKey: {
    title: 'Read your public key',
    lede: 'wants to know which Nostr account you are using.',
  },
  getRelays: {
    title: 'Read your relay list',
    lede: 'wants to know which relays you connect to.',
  },
  signEvent: {
    title: 'Sign a Nostr event',
    lede: 'wants to publish an event on your behalf.',
  },
  'nip04.encrypt': {
    title: 'Encrypt a message (NIP-04)',
    lede: 'wants to encrypt a direct message from you.',
  },
  'nip04.decrypt': {
    title: 'Decrypt a message (NIP-04)',
    lede: 'wants to decrypt a message sent to you.',
  },
  'nip44.encrypt': {
    title: 'Encrypt a message (NIP-44)',
    lede: 'wants to encrypt data from you.',
  },
  'nip44.decrypt': {
    title: 'Decrypt a message (NIP-44)',
    lede: 'wants to decrypt data sent to you.',
  },
  signPsbt: {
    title: 'Sign a Bitcoin transaction',
    lede: 'wants to sign a Bitcoin transaction with your key.',
  },
};

export function Prompt() {
  const batchId = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('id') ?? '';
  }, []);

  const [batch, setBatch] = useState<PromptBatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(() => {
    // The batch id comes from the URL; if missing we can surface the
    // error immediately without a re-render cycle.
    const params = new URLSearchParams(window.location.search);
    return params.get('id') ? null : 'Missing prompt id.';
  });
  /** Methods currently being resolved — disables their buttons. */
  const [submitting, setSubmitting] = useState<Set<string>>(new Set());
  /**
   * Ordered log of every step the user has been walked through, in
   * the order they first saw it. See {@link StepRecord} and
   * {@link reconcileSteps} for the identification scheme; in short,
   * a step is identified by the item IDs that originally constituted
   * its group, so a fresh request reusing the same (method, kind) as
   * a previously-resolved step is correctly recognized as a new
   * step appended to the end rather than the original step looping
   * back.
   */
  const [steps, setSteps] = useState<StepRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!batchId) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setLoading(false);
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }
    (async () => {
      try {
        const response = (await chrome.runtime.sendMessage({
          kind: 'get-pending-batch',
          batchId,
        })) as { batch: PromptBatch | null };
        if (cancelled) return;
        if (!response?.batch) {
          setError('This request is no longer pending.');
        } else {
          setBatch(response.batch);
          setSteps((prev) => reconcileSteps(prev, response.batch!.groups));
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [batchId]);

  // Live updates: while the window is open, the page may issue more
  // RPC calls. The background pushes `prompt-batch-updated` so we can
  // re-render with the fresh group list.
  useEffect(() => {
    if (!batchId) return;
    const listener = (message: unknown) => {
      if (
        !message ||
        typeof message !== 'object' ||
        (message as { kind?: unknown }).kind !== 'prompt-batch-updated'
      ) {
        return;
      }
      const update = message as { batchId: string; batch: PromptBatch | null };
      if (update.batchId !== batchId) return;
      if (!update.batch) {
        // Nothing left — the background will close this window shortly,
        // but close ourselves too just in case.
        window.close();
        return;
      }
      const next = update.batch;
      // Extend the step log monotonically. Each live group either
      // matches an existing step (one of its current item IDs is in
      // that step's recorded set) or starts a new one appended to the
      // end. Resolved steps remain in the list so the total step
      // count never shrinks.
      setSteps((prev) => reconcileSteps(prev, next.groups));
      // Reconcile the in-flight set so the new UI's buttons aren't
      // stuck in their "submitting" state. Done before `setBatch` so
      // the next render sees a consistent pair of values.
      setSubmitting((current) => {
        // Always drop the `__all__` sentinel: it was set by a Connect
        // click that has now landed — whatever follows is a new screen
        // the user can interact with. Also drop any per-group entries
        // whose group is no longer visible, and any per-item
        // (`item:<id>`) entries whose item has already been resolved
        // (it disappears from the new batch). Together this resets the
        // disabled state across the Connect → Approve transition that
        // morphs the same window, and across per-event approvals as
        // items drain.
        if (current.size === 0) return current;
        const visibleGroupKeys = new Set(next.groups.map((g) => groupKey(g.method, g.kind)));
        const visibleItemIds = new Set<string>();
        for (const g of next.groups) {
          for (const it of g.items) visibleItemIds.add(it.id);
        }
        const filtered = new Set<string>();
        for (const key of current) {
          if (key === '__all__') continue;
          if (key.startsWith('item:')) {
            if (visibleItemIds.has(key.slice('item:'.length))) filtered.add(key);
            continue;
          }
          if (visibleGroupKeys.has(key)) filtered.add(key);
        }
        return filtered.size === current.size ? current : filtered;
      });
      setBatch(next);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [batchId]);

  const resolveGroup = useCallback(
    async (method: NostrRpcMethod, eventKind: number | undefined, action: PromptAction) => {
      const key = groupKey(method, eventKind);
      setSubmitting((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      try {
        await chrome.runtime.sendMessage({
          kind: 'resolve-prompt-group',
          batchId,
          method,
          eventKind,
          action,
        });
        // Background will push a batch update or close the window.
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setSubmitting((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [batchId],
  );

  const resolveConnect = useCallback(
    async (action: ConnectAction) => {
      setSubmitting(new Set(['__all__']));
      try {
        await chrome.runtime.sendMessage({
          kind: 'resolve-connect',
          batchId,
          action,
        });
        // Background closes the window on `block`/`cancel`, and either
        // closes or pushes a batch update on `connect`. Either way we
        // don't need to do anything else here.
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setSubmitting(new Set());
      }
    },
    [batchId],
  );

  /**
   * Resolve a single pending item by id (per-event approve/deny inside
   * a multi-item `signEvent` group). Per-item decisions don't persist
   * — the user gets `allow-once` / `deny`, and that's it. To grant a
   * lasting rule for the whole kind they use the group-level "Always
   * allow <kind>" button instead.
   *
   * The `submitting` set is keyed on the item id with a `item:` prefix
   * so per-event buttons disable independently of the per-group ones.
   */
  const resolveItem = useCallback(
    async (itemId: string, action: ItemAction) => {
      const key = `item:${itemId}`;
      setSubmitting((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      try {
        await chrome.runtime.sendMessage({
          kind: 'resolve-prompt-item',
          batchId,
          itemId,
          action,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setSubmitting((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [batchId],
  );

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !batch) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 gap-4 text-center">
        <ShieldX className="size-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground max-w-xs">
          {error ?? 'This request is no longer pending.'}
        </p>
        <Button variant="outline" onClick={() => window.close()}>
          Close
        </Button>
      </div>
    );
  }

  const host = safeHost(batch.origin.origin);
  const anySubmitting = submitting.size > 0;  if (batch.kind === 'connect') {
    return (
      <ConnectView
        batch={batch}
        host={host}
        anySubmitting={anySubmitting}
        onResolve={resolveConnect}
      />
    );
  }

  // Always step through groups one at a time. The user resolves the
  // first remaining group, the background drops it from the batch and
  // pushes an update, and the next group becomes the new "first
  // remaining" — repeating until the batch is empty and the window
  // closes itself. New requests arriving from the page mid-flow are
  // simply appended; they don't interrupt the current step.
  const pendingGroups = batch.groups.length;
  if (pendingGroups === 0) {
    // Defensive: an empty `approve` batch shouldn't reach the UI (the
    // background closes the window when its queue drains), but if it
    // does we render the same empty state as a stale batch instead of
    // an undefined-laden card.
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 gap-4 text-center">
        <ShieldX className="size-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground max-w-xs">
          This request is no longer pending.
        </p>
        <Button variant="outline" onClick={() => window.close()}>
          Close
        </Button>
      </div>
    );
  }
  const activeGroup = batch.groups[0];
  // Step indicator: derive from the running step log plus the current
  // pending count. `steps` is append-only and identifies steps by
  // their original item IDs, so:
  //   - resolving items inside the active group leaves its step in
  //     place (the indicator doesn't jump),
  //   - a fresh request reusing the same (method, kind) as a finished
  //     step gets its own appended step (the indicator advances), and
  //   - the denominator never decreases.
  //
  // The active step is the first step whose recorded items intersect
  // the active group. `steps` may briefly trail the live batch when
  // the very first batch update lands before the reconciler has run;
  // fall back to step 1 in that case so we never display "Step 0".
  const activeStepIndex = findStepForGroup(steps, activeGroup);
  const totalSteps = Math.max(steps.length, pendingGroups);
  const currentStep = activeStepIndex >= 0 ? activeStepIndex + 1 : 1;
  // signEvent groups render the active account inside each EmbeddedPost
  // card (avatar + display name), so adding a separate account header
  // above would be redundant. For non-signEvent groups (encrypt /
  // decrypt / getRelays) the account card is the only indicator of
  // which key is acting — keep it then.
  const showAccountCard = activeGroup.method !== 'signEvent';

  return (
    <div className="min-h-screen flex flex-col bg-background/85 backdrop-blur text-foreground">
      <header className="flex items-center gap-2 px-5 h-12 border-b">
        <Logo className="size-6" alt="SBC Signer" />
        <span className="font-semibold text-sm">SBC Signer Extension</span>
      </header>

      <main className="flex-1 flex flex-col gap-4 px-5 py-5 overflow-y-auto">
        <SiteHeader
          origin={batch.origin.origin}
          icon={batch.origin.icon}
          title={batch.origin.title}
        />

        <div className="space-y-1">
          {totalSteps > 1 && (
            <p className="text-xs font-medium text-muted-foreground">
              Step {currentStep} of {totalSteps}
            </p>
          )}
          <h1 className="text-lg font-semibold">{groupHeading(activeGroup)}</h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{host}</span>{' '}
            {METHOD_COPY[activeGroup.method]?.lede ??
              'wants to use your Nostr account.'}
          </p>
        </div>

        {showAccountCard && <CurrentAccountCard pubkey={batch.pubkey} />}

        <GroupCard
          batchId={batch.batchId}
          group={activeGroup}
          anySubmitting={anySubmitting}
          isItemSubmitting={(itemId) => submitting.has(`item:${itemId}`)}
          onResolveItem={resolveItem}
          pubkey={batch.pubkey}
        />
      </main>

      <footer className="border-t p-4 space-y-2 bg-background">
        <SingleGroupFooter
          group={activeGroup}
          anySubmitting={anySubmitting}
          onResolve={(action) =>
            resolveGroup(activeGroup.method, activeGroup.kind, action)
          }
        />
      </footer>
    </div>
  );
}

function ConnectView({
  batch,
  host,
  anySubmitting,
  onResolve,
}: {
  batch: PromptBatch;
  host: string;
  anySubmitting: boolean;
  onResolve: (action: ConnectAction) => void;
}) {
  return (
    <div className="min-h-screen flex flex-col bg-background/85 backdrop-blur text-foreground">
      <header className="flex items-center gap-2 px-5 h-12 border-b">
        <Logo className="size-6" alt="SBC Signer" />
        <span className="font-semibold text-sm">SBC Signer Extension</span>
      </header>

      <main className="flex-1 flex flex-col gap-5 px-5 py-6 overflow-y-auto">
        <SiteHeader
          origin={batch.origin.origin}
          icon={batch.origin.icon}
          title={batch.origin.title}
        />

        <div className="space-y-1">
          <h1 className="text-lg font-semibold">Connect to this site?</h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{host}</span> wants to use
            your Nostr account. Connecting shares your public key with this site.
            You'll still be asked before signing events or decrypting messages.
          </p>
        </div>

        <CurrentAccountCard pubkey={batch.pubkey} />
      </main>

      <footer className="border-t p-4 space-y-2 bg-background">
        <Button
          className="w-full h-11"
          onClick={() => onResolve('connect')}
          disabled={anySubmitting}
        >
          {anySubmitting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            'Connect'
          )}
        </Button>
        <Button
          className="w-full h-9 text-xs text-muted-foreground hover:text-destructive"
          variant="ghost"
          size="sm"
          onClick={() => onResolve('block')}
          disabled={anySubmitting}
        >
          Block this site
        </Button>
      </footer>
    </div>
  );
}

/**
 * Maximum number of pending items to render inside a single group
 * before the user has to opt in via a "Show more" button. Long bursts
 * of `signEvent` / decrypt requests would otherwise turn the prompt
 * window into an unbounded scroll, burying the footer's bulk-approve
 * buttons. Three rows is enough to make the per-item structure
 * obvious (this is a list, not a single payload) while keeping the
 * window short enough that the footer stays visible without
 * scrolling.
 */
const ITEMS_COLLAPSED_LIMIT = 3;

function GroupCard({
  batchId,
  group,
  anySubmitting,
  isItemSubmitting,
  onResolveItem,
  pubkey,
}: {
  batchId: string;
  group: PendingPromptGroup;
  anySubmitting: boolean;
  /** Whether a specific pending item is currently being resolved. */
  isItemSubmitting: (itemId: string) => boolean;
  /** Resolve a single event in this group (signEvent groups only). */
  onResolveItem: (itemId: string, action: ItemAction) => void;
  /** The active signer's pubkey, used to flag "ours" inputs/outputs in PSBT previews. */
  pubkey?: string;
}) {
  const count = group.items.length;
  const isSignEvent = group.method === 'signEvent';
  const isDecrypt =
    group.method === 'nip04.decrypt' || group.method === 'nip44.decrypt';
  // Collapse long item lists by default. Only relevant for the two
  // per-item-rendered methods (signEvent, decrypt); other methods
  // either render at most one parameter blob or surface only the
  // group-level controls. The user can flip back to a collapsed view
  // via the same button — it doubles as "Show less" once expanded.
  const [expanded, setExpanded] = useState(false);
  const supportsCollapse = isSignEvent || isDecrypt;
  const overflowing = supportsCollapse && count > ITEMS_COLLAPSED_LIMIT;
  const isCollapsed = overflowing && !expanded;
  const visibleItems = isCollapsed
    ? group.items.slice(0, ITEMS_COLLAPSED_LIMIT)
    : group.items;
  const hiddenCount = isCollapsed ? count - visibleItems.length : 0;

  return (
    // No card chrome around the group: now that only one group is ever
    // visible, there's nothing to delimit it from. The parent layout
    // already provides surrounding spacing via `gap-4`. The page H1
    // above carries the kind label and the per-item cards inside this
    // container make the multiplicity self-evident, so the group itself
    // renders flush — no header row, no count badge, no border.
    <div className="space-y-2">
      {isSignEvent && (
        <div className="space-y-2">
          {visibleItems.map((item) => (
            <SignEventItem
              key={item.id}
              item={item}
              submitting={isItemSubmitting(item.id)}
              anySubmitting={anySubmitting}
              onResolve={(action) => onResolveItem(item.id, action)}
            />
          ))}
          {overflowing && (
            <ShowMoreButton
              expanded={expanded}
              hiddenCount={hiddenCount}
              onToggle={() => setExpanded((v) => !v)}
            />
          )}
        </div>
      )}

      {isDecrypt && (
        <>
          <p className="text-xs text-muted-foreground">
            The site is asking to read the message{count > 1 ? 's' : ''} below.
            Allowing this prompt sends the decrypted text to the page.
          </p>
          <div className="space-y-2">
            {visibleItems.map((item) => (
              <DecryptItem
                key={item.id}
                batchId={batchId}
                item={item}
                submitting={isItemSubmitting(item.id)}
                anySubmitting={anySubmitting}
                onResolve={(action) => onResolveItem(item.id, action)}
              />
            ))}
            {overflowing && (
              <ShowMoreButton
                expanded={expanded}
                hiddenCount={hiddenCount}
                onToggle={() => setExpanded((v) => !v)}
              />
            )}
          </div>
        </>
      )}

      {!isSignEvent && !isDecrypt && group.method !== 'signPsbt' && count === 1 && group.items[0].params != null && (
        <details className="text-xs">
          <summary className="text-muted-foreground cursor-pointer select-none">
            Show parameters
          </summary>
          <pre className="mt-2 font-mono text-[11px] whitespace-pre-wrap break-all bg-muted/50 rounded-md p-2 max-h-32 overflow-y-auto">
            {safeJson(group.items[0].params)}
          </pre>
        </details>
      )}

      {group.method === 'signPsbt' && (
        <div className="space-y-2">
          {group.items.map((item) => (
            <PsbtPreviewCard
              key={item.id}
              item={item}
              pubkey={pubkey}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Collapse/expand affordance shown at the bottom of a group when more
 * than {@link ITEMS_COLLAPSED_LIMIT} items are pending.
 *
 * The same control toggles in both directions — "Show N more" when
 * collapsed, "Show less" when expanded — so the user can scan the
 * tail of a long batch and then fold it back to keep the footer's
 * bulk-approve buttons in view. If the batch later shrinks below the
 * threshold (because items get resolved), the parent simply stops
 * rendering this button.
 */
function ShowMoreButton({
  expanded,
  hiddenCount,
  onToggle,
}: {
  expanded: boolean;
  /** Number of items currently hidden (only meaningful when collapsed). */
  hiddenCount: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full text-xs text-muted-foreground hover:text-foreground py-2 rounded-md border border-dashed border-border hover:bg-muted/40 transition-colors"
    >
      {expanded ? 'Show less' : `Show ${hiddenCount} more`}
    </button>
  );
}

/**
 * One row inside a `signEvent` group — a self-contained card that lets
 * the user act on a single pending event:
 *
 *   - The {@link EmbeddedPost} preview is the collapsible's trigger.
 *     Clicking it expands the card to reveal the unsigned event's full
 *     JSON and the per-item Allow / Deny controls underneath.
 *   - The Allow / Deny buttons live *inside* the expanded panel.
 *     Tucking them behind the disclosure keeps the collapsed list
 *     scannable (each pending event is one preview line) while making
 *     the act of approving an event force the user past the JSON
 *     audit view first. For batch action across many events the user
 *     still has the group-level "Allow all once" / "Reject all"
 *     buttons in the footer.
 *
 * Per-item decisions are intentionally one-shot: the user is choosing
 * "this specific event yes/no", not "this kind yes/no". To grant a
 * lasting rule for the whole kind they use the group's "Always allow"
 * button.
 */
function SignEventItem({
  item,
  submitting,
  anySubmitting,
  onResolve,
}: {
  item: PendingPromptItem;
  submitting: boolean;
  anySubmitting: boolean;
  onResolve: (action: ItemAction) => void;
}) {
  const event = extractUnsignedEvent(item.params);
  const rawEvent = extractRawEvent(item.params);
  const [open, setOpen] = useState(false);

  // Without a usable event preview there's nothing to expand into and
  // no signal for the user to base a decision on; render a flat
  // placeholder card with the per-item controls inline. Same Allow /
  // Deny semantics, just no accordion to hide them behind.
  if (!event) {
    return (
      <div className="rounded-2xl border border-border border-dashed bg-muted/40 overflow-hidden">
        <div className="px-3 py-2 text-xs text-muted-foreground">
          Event payload missing or malformed.
        </div>
        <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-border border-dashed bg-background">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onResolve('deny')}
            disabled={anySubmitting}
          >
            Deny
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onResolve('allow-once')}
            disabled={anySubmitting}
          >
            {submitting ? <Loader2 className="size-3 animate-spin" /> : 'Allow'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-background overflow-hidden">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className="w-full text-left group/trigger relative"
          aria-label={open ? 'Collapse event details' : 'Expand event details'}
        >
          <EmbeddedPost
            event={event}
            className="rounded-none border-0 group-hover/trigger:bg-muted/30 transition-colors pr-8"
          />
          <ChevronDown
            className={cn(
              'absolute top-3 right-3 size-4 text-muted-foreground transition-transform duration-200',
              open && 'rotate-180',
            )}
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-3 pb-3 border-t border-border bg-muted/20 space-y-2">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground mt-2 mb-1">
                Unsigned event
              </p>
              <pre className="font-mono text-[11px] whitespace-pre-wrap break-all bg-background border border-border rounded-md p-2 max-h-48 overflow-y-auto">
                {safeJson(rawEvent ?? item.params)}
              </pre>
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onResolve('deny')}
                disabled={anySubmitting}
              >
                Deny
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onResolve('allow-once')}
                disabled={anySubmitting}
              >
                {submitting ? <Loader2 className="size-3 animate-spin" /> : 'Allow'}
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/**
 * One row inside an `nip04.decrypt` / `nip44.decrypt` group — a
 * self-contained accordion card mirroring {@link SignEventItem}:
 *
 *   - The trigger row shows the conversation peer (avatar, display
 *     name, npub) and a short excerpt of the decrypted plaintext, so
 *     the user can scan a list of pending decrypts without expanding
 *     each one. The decryption is performed inside the extension's
 *     background by the active signer purely for display purposes —
 *     the page does not receive the plaintext unless the user later
 *     approves the underlying RPC.
 *   - Expanding the card reveals the full plaintext (no clamp) and
 *     the per-item Allow / Deny controls. Tucking the buttons behind
 *     the disclosure matches the signEvent flow: any per-item
 *     approval gesture happens on the same surface as the message
 *     audit view.
 *
 * About the "author" framing: the `pubkey` argument to NIP-04 / NIP-44
 * decrypt is just the conversation peer (the other half of the X25519
 * shared secret). It didn't sign the ciphertext, and the ciphertext
 * isn't always a DM — NIP-44 also wraps gift wraps, NIP-46 traffic,
 * and app-private blobs. We still surface the peer's profile because
 * along with the originating site it is *the* identifying context the
 * user has when deciding whether the page should see the plaintext;
 * we just label it as the conversation peer rather than implying a
 * cryptographic claim of authorship.
 *
 * Per-item decisions are intentionally one-shot (allow-once / deny);
 * persistent rules ("Always allow decrypt") still live at the group
 * level.
 */
function DecryptItem({
  batchId,
  item,
  submitting,
  anySubmitting,
  onResolve,
}: {
  batchId: string;
  item: PendingPromptItem;
  submitting: boolean;
  anySubmitting: boolean;
  onResolve: (action: ItemAction) => void;
}) {
  const params = (item.params ?? {}) as { pubkey?: unknown; ciphertext?: unknown };
  const counterparty = typeof params.pubkey === 'string' ? params.pubkey : '';
  const ciphertext = typeof params.ciphertext === 'string' ? params.ciphertext : '';

  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ok'; plaintext: string }
    | { status: 'error'; message: string }
  >(() =>
    !counterparty || !ciphertext
      ? { status: 'error', message: 'Malformed request: missing pubkey or ciphertext.' }
      : { status: 'loading' },
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!counterparty || !ciphertext) return;
    (async () => {
      try {
        const response = (await chrome.runtime.sendMessage({
          kind: 'decrypt-preview',
          batchId,
          itemId: item.id,
        })) as
          | { ok: true; plaintext: string }
          | { ok: false; error?: string }
          | undefined;
        if (cancelled) return;
        if (!response) {
          setState({ status: 'error', message: 'No response from background.' });
          return;
        }
        if (response.ok) {
          setState({ status: 'ok', plaintext: response.plaintext });
        } else {
          setState({
            status: 'error',
            message: response.error ?? 'Decryption failed.',
          });
        }
      } catch (err) {
        if (cancelled) return;
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [batchId, item.id, counterparty, ciphertext]);

  return (
    <div className="rounded-2xl border border-border bg-background overflow-hidden">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className="w-full text-left group/trigger relative"
          aria-label={open ? 'Collapse message details' : 'Expand message details'}
        >
          <div className="px-3 py-2 space-y-1.5 group-hover/trigger:bg-muted/30 transition-colors pr-8">
            <PeerHeader pubkey={counterparty} />
            {state.status === 'loading' && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Decrypting…
              </div>
            )}
            {state.status === 'ok' && (
              // Single-line preview: collapse all whitespace
              // (including embedded newlines) so a multi-paragraph
              // message renders as one visual line, with the trailing
              // ellipsis indicating there's more content. The full
              // plaintext is preserved verbatim in the expanded view
              // below.
              <p className="text-xs truncate text-foreground">
                {state.plaintext.replace(/\s+/g, ' ').trim()}
              </p>
            )}
            {state.status === 'error' && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground">
                <ShieldAlert className="size-3.5 shrink-0 mt-0.5" />
                <span className="break-words">
                  Couldn't decrypt this message: {state.message}
                </span>
              </div>
            )}
          </div>
          <ChevronDown
            className={cn(
              'absolute top-3 right-3 size-4 text-muted-foreground transition-transform duration-200',
              open && 'rotate-180',
            )}
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-3 pb-3 border-t border-border bg-muted/20 space-y-2">
            {state.status === 'ok' && (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground mt-2 mb-1">
                  Decrypted message
                </p>
                <p className="text-xs whitespace-pre-wrap break-words bg-background border border-border rounded-md p-2 max-h-64 overflow-y-auto text-foreground">
                  {state.plaintext}
                </p>
              </div>
            )}
            {state.status === 'error' && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground pt-2">
                <ShieldAlert className="size-3.5 shrink-0 mt-0.5" />
                <span className="break-words">
                  Couldn't decrypt this message: {state.message}
                </span>
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onResolve('deny')}
                disabled={anySubmitting}
              >
                Deny
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onResolve('allow-once')}
                disabled={anySubmitting}
              >
                {submitting ? <Loader2 className="size-3 animate-spin" /> : 'Allow'}
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/**
 * Preview card for a `signPsbt` request. Decodes the PSBT locally (no
 * network, no signing) and renders the inputs/outputs/fee so the user
 * can audit what they're approving before clicking Allow.
 *
 * Inputs and outputs that match the active signer's own Taproot address
 * are flagged ("yours") so the user can tell at a glance which side of
 * the transaction they are.
 */
function PsbtPreviewCard({
  item,
  pubkey,
}: {
  item: PendingPromptItem;
  pubkey?: string;
}) {
  const params = (item.params ?? {}) as { psbtHex?: unknown };
  const psbtHex = typeof params.psbtHex === 'string' ? params.psbtHex : '';

  const summary = useMemo(() => {
    if (!psbtHex || !pubkey) return null;
    return summarizePsbtSafe(psbtHex, pubkey);
  }, [psbtHex, pubkey]);

  const [showRaw, setShowRaw] = useState(false);

  if (!psbtHex) {
    return (
      <div className="rounded-2xl border border-border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        Missing PSBT payload.
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="rounded-2xl border border-border border-dashed bg-muted/40 px-3 py-3 space-y-2">
        <p className="text-xs text-muted-foreground">
          Couldn't decode this PSBT. The site may be sending a malformed payload.
        </p>
        <details className="text-xs">
          <summary className="text-muted-foreground cursor-pointer select-none">
            Show raw hex
          </summary>
          <pre className="mt-2 font-mono text-[10px] whitespace-pre-wrap break-all bg-background border border-border rounded-md p-2 max-h-32 overflow-y-auto">
            {psbtHex}
          </pre>
        </details>
      </div>
    );
  }

  const ourOutgoing = summary.netDebit ?? null;

  return (
    <div className="rounded-2xl border border-border bg-background overflow-hidden">
      <div className="px-3 py-3 space-y-3">
        {/* Headline: "you are sending X to recipient" */}
        {ourOutgoing !== null && ourOutgoing > 0 && (
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              You are sending
            </p>
            <p className="text-lg font-semibold tabular-nums">
              {formatBTC(ourOutgoing)} BTC
            </p>
          </div>
        )}

        {/* Outputs */}
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Outputs
          </p>
          {summary.outputs.map((out, i) => (
            <div
              key={i}
              className="flex items-start justify-between gap-2 rounded-md bg-muted/40 px-2 py-1.5"
            >
              <div className="min-w-0 flex-1">
                {out.silentPaymentAddress ? (
                  <>
                    <p className="text-[11px] font-mono break-all text-foreground">
                      {truncateMid(out.silentPaymentAddress, 20)}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      silent payment recipient
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-[11px] font-mono break-all text-foreground">
                      {truncateMid(out.address ?? '(unknown)', 20)}
                    </p>
                    {out.isChange && (
                      <p className="text-[10px] text-muted-foreground">change (your address)</p>
                    )}
                  </>
                )}
              </div>
              <p className="text-xs font-medium tabular-nums shrink-0">
                {formatBTC(out.value)} BTC
              </p>
            </div>
          ))}
        </div>

        {/* Inputs */}
        <details className="space-y-1.5">
          <summary className="text-[10px] uppercase tracking-wide text-muted-foreground cursor-pointer select-none">
            Inputs ({summary.inputs.length})
          </summary>
          <div className="mt-2 space-y-1.5">
            {summary.inputs.map((inp, i) => (
              <div
                key={i}
                className="flex items-start justify-between gap-2 rounded-md bg-muted/40 px-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-mono break-all text-foreground">
                    {inp.address ? truncateMid(inp.address, 20) : '(unknown)'}
                  </p>
                  {inp.isOurs && (
                    <p className="text-[10px] text-muted-foreground">yours</p>
                  )}
                </div>
                <p className="text-xs font-medium tabular-nums shrink-0">
                  {inp.value !== undefined ? `${formatBTC(inp.value)} BTC` : '?'}
                </p>
              </div>
            ))}
          </div>
        </details>

        {/* Fee */}
        {summary.fee !== undefined && (
          <div className="flex items-center justify-between border-t border-border pt-2 text-xs">
            <span className="text-muted-foreground">Network fee</span>
            <span className="font-medium tabular-nums">
              {formatBTC(summary.fee)} BTC ({summary.fee.toLocaleString()} sats)
            </span>
          </div>
        )}

        {/* Raw hex toggle */}
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {showRaw ? 'Hide' : 'Show'} raw PSBT
        </button>
        {showRaw && (
          <pre className="font-mono text-[10px] whitespace-pre-wrap break-all bg-muted/40 border border-border rounded-md p-2 max-h-32 overflow-y-auto">
            {psbtHex}
          </pre>
        )}
      </div>
    </div>
  );
}

function truncateMid(s: string, head: number): string {
  if (s.length <= head + 8) return s;
  return `${s.slice(0, head)}…${s.slice(-6)}`;
}

/**
 * Author-row header for a {@link DecryptItem}: avatar + display name
 * for the conversation peer. Resolves kind-0 metadata via
 * {@link useAuthor} and falls back to a {@link genUserName} animal
 * name when no profile is available, matching the pattern used by
 * {@link EmbeddedPost} for sign-event previews.
 *
 * The peer's pubkey is intentionally NOT shown on the trigger row.
 * It crowds the line, doesn't fit alongside a long display name in
 * the 400px-wide popup, and adds noise that's rarely useful at a
 * glance — anyone who needs the raw key can copy it from the
 * Decrypted message panel or look up the displayed profile name.
 */
function PeerHeader({ pubkey }: { pubkey: string }) {
  const { data, isLoading } = useAuthor(pubkey || undefined);
  const metadata = data?.metadata;
  const displayName =
    metadata?.name ??
    metadata?.display_name ??
    (pubkey ? genUserName(pubkey) : 'Unknown');
  const isPending = isLoading && !metadata?.name && !metadata?.display_name;

  return (
    <div className="flex items-center gap-2 min-w-0">
      {isPending ? (
        <>
          <Skeleton className="size-5 rounded-full shrink-0" />
          <Skeleton className="h-3.5 w-24" />
        </>
      ) : (
        <>
          <Avatar className="size-5 shrink-0">
            <AvatarImage src={metadata?.picture} alt={displayName} />
            <AvatarFallback className="bg-primary/20 text-primary text-[10px]">
              {displayName.charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="text-sm font-semibold truncate">{displayName}</span>
        </>
      )}
    </div>
  );
}

/**
 * Footer for the active step. Surfaces exactly two persistent
 * decisions:
 *
 *   - **Always allow** — record `'allow'` for this site, scoped to the
 *     active method (and to the active event kind for `signEvent`),
 *     then resolve every pending item in the group.
 *   - **Always reject** — record `'deny'` at the same scope, then
 *     reject every pending item in the group. Equivalent to
 *     `'block this method for this site'`.
 *
 * One-shot variants (`'Allow once'`, `'Reject'` without persistence)
 * and the legacy "trust everything" escape hatch
 * (`'allow-always-any'`) used to live here too. Both have moved out
 * of the footer:
 *
 *   - Per-event one-shot Allow / Deny lives inside each event /
 *     decrypt accordion card. Anyone who wants to handle "this
 *     specific event yes/no" without writing a lasting rule does it
 *     there, in front of the JSON / plaintext audit view.
 *   - The all-kinds escape hatch is no longer surfaced — the active
 *     kind label on "Always allow" is the user-facing scope, and
 *     anyone who really wants method-wide trust can grant it
 *     piecewise as each kind is prompted.
 *
 * The two buttons are consistent across every method (signEvent,
 * encrypt/decrypt, getPublicKey, getRelays). For methods without a
 * kind dimension the labels are method-wide; for `signEvent` they
 * carry the event-kind label so the user sees what scope they're
 * granting or blocking.
 */
function SingleGroupFooter({
  group,
  anySubmitting,
  onResolve,
}: {
  group: PendingPromptGroup;
  anySubmitting: boolean;
  onResolve: (action: PromptAction) => void;
}) {
  const isSignEvent = group.method === 'signEvent';
  // signPsbt deliberately does not surface "Always allow" / "Always
  // reject" — every PSBT moves potentially different funds, so granting
  // a standing rule would be a footgun. Only one-shot decisions are
  // allowed; the corresponding background guard refuses to persist a
  // signPsbt rule even if these actions were somehow dispatched.
  const isSignPsbt = group.method === 'signPsbt';
  const kindName =
    isSignEvent && typeof group.kind === 'number' ? kindLabel(group.kind) : null;
  const allowLabel = kindName ? `Always allow ${kindName.toLowerCase()}` : 'Always allow';
  const rejectLabel = kindName ? `Always reject ${kindName.toLowerCase()}` : 'Always reject';

  if (isSignPsbt) {
    return (
      <>
        <Button
          className="w-full h-11"
          onClick={() => onResolve('allow-once')}
          disabled={anySubmitting}
        >
          Allow once
        </Button>
        <Button
          className="w-full h-11"
          variant="ghost"
          onClick={() => onResolve('deny')}
          disabled={anySubmitting}
        >
          Reject
        </Button>
      </>
    );
  }

  return (
    <>
      <Button
        className="w-full h-11"
        onClick={() => onResolve('allow-always')}
        disabled={anySubmitting}
      >
        {allowLabel}
      </Button>
      <Button
        className="w-full h-11"
        variant="ghost"
        onClick={() => onResolve('deny-always')}
        disabled={anySubmitting}
      >
        {rejectLabel}
      </Button>
    </>
  );
}

function CurrentAccountCard({ pubkey }: { pubkey?: string }) {
  const { currentUser, isLoading } = useLoggedInAccounts();
  const effectivePubkey = pubkey ?? currentUser?.pubkey;
  if (!effectivePubkey) return null;
  // While the metadata query is still in-flight, we don't yet know whether
  // this account has a real display name. Render skeletons rather than
  // flashing a generated animal name + its first letter.
  const isPending = isLoading && !currentUser?.metadata.name;
  const displayName = currentUser?.metadata.name ?? genUserName(effectivePubkey);
  return (
    <Card className="bg-muted/40 border-0">
      <CardContent className="p-3 flex items-center gap-3">
        <Avatar className="size-9">
          <AvatarImage
            src={currentUser?.metadata.picture}
            alt={isPending ? '' : displayName}
          />
          <AvatarFallback>
            {isPending ? (
              <Skeleton className="size-full rounded-full" />
            ) : (
              displayName.charAt(0)
            )}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          {isPending ? (
            <Skeleton className="h-4 w-32" />
          ) : (
            <p className="text-sm font-medium truncate">{displayName}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function safeHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Stable key for a (method, kind) pair. Used both for React list keys
 * and for the `submitting` set so per-kind buttons don't disable each
 * other (e.g. clicking "Always allow kind 1" shouldn't grey out the
 * kind-5 group's buttons).
 */
function groupKey(method: NostrRpcMethod, kind: number | undefined): string {
  return kind === undefined ? method : `${method}:${kind}`;
}

/**
 * One entry in the step log. See the `steps` state in {@link Prompt}
 * for the rationale; in short, identifying a step by item IDs (rather
 * than by `(method, kind)` group key) is what lets us tell a fresh
 * batch of HTTP-auth requests apart from a previously-resolved
 * HTTP-auth step that the background has merged into the same group.
 */
interface StepRecord {
  /** Stable id — the first item id observed when the step was created. */
  id: string;
  /**
   * Every pending item id this step has ever owned. Item IDs are
   * removed from the live batch as they're resolved, but they stay
   * in this set so we can still match a partially-drained group
   * back to the step that started it.
   */
  itemIds: Set<string>;
}

/**
 * Walk every group in the latest batch update and either match it to
 * an existing step or append it as a new one. Returns the same array
 * reference when nothing changed so React can skip the render.
 *
 * A group matches an existing step if any of the group's current
 * item IDs is in the step's recorded set. Once matched, the step
 * absorbs any new item IDs the group has gained (the background may
 * append items to an existing group as fresh requests arrive while
 * its earlier items are still pending).
 *
 * Greedy first-match is fine because group keys can't collide within
 * a single batch — the background already de-duplicates by `(method,
 * kind)` — so two distinct steps will never claim the same group.
 */
function reconcileSteps(
  prev: StepRecord[],
  groups: PendingPromptGroup[],
): StepRecord[] {
  let next: StepRecord[] | null = null;
  const claimed = new Set<number>();
  for (const group of groups) {
    if (group.items.length === 0) continue;
    let matched = -1;
    for (let i = 0; i < (next ?? prev).length; i++) {
      if (claimed.has(i)) continue;
      const step = (next ?? prev)[i];
      const intersects = group.items.some((it) => step.itemIds.has(it.id));
      if (intersects) {
        matched = i;
        break;
      }
    }
    if (matched >= 0) {
      // Step exists; absorb any newly-arrived item IDs.
      const target = (next ?? prev)[matched];
      let grew: Set<string> | null = null;
      for (const it of group.items) {
        if (target.itemIds.has(it.id)) continue;
        (grew ??= new Set(target.itemIds)).add(it.id);
      }
      if (grew) {
        next ??= [...prev];
        next[matched] = { id: target.id, itemIds: grew };
      }
      claimed.add(matched);
    } else {
      // Brand-new step — append to the end.
      next ??= [...prev];
      const itemIds = new Set<string>();
      for (const it of group.items) itemIds.add(it.id);
      next.push({ id: group.items[0].id, itemIds });
      claimed.add(next.length - 1);
    }
  }
  return next ?? prev;
}

/**
 * Find which step the live "active" group corresponds to. Returns
 * the step's index in the log, or `-1` if no step has yet been
 * recorded that owns any of the group's pending item IDs (the
 * reconciler hasn't run yet — the caller falls back to step 1 in
 * that brief window).
 */
function findStepForGroup(steps: StepRecord[], group: PendingPromptGroup): number {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (group.items.some((it) => step.itemIds.has(it.id))) return i;
  }
  return -1;
}

/**
 * Heading copy for a single-group prompt — uses the friendly per-method
 * title from `METHOD_COPY`, with a generic English fallback so we never
 * surface a raw RPC method name (`signEvent`, `getPublicKey`, …) in
 * the UI even if the table somehow misses an entry.
 */
function groupHeading(group: PendingPromptGroup): string {
  if (group.method === 'signEvent' && typeof group.kind === 'number') {
    return `Sign ${kindLabel(group.kind)}`;
  }
  return METHOD_COPY[group.method]?.title ?? 'Authorize this request';
}

/**
 * Pull the unsigned event template out of a `signEvent` params blob.
 * Returns `null` when the params don't contain a recognizable event,
 * so the caller can render a placeholder rather than a broken card.
 *
 * We deliberately don't validate the shape strictly — pages send
 * unsigned templates with optional fields, and the prompt should still
 * show whatever's there (even a bare `{kind: 1}`) so the user has
 * something to base a decision on.
 */
function extractUnsignedEvent(params: unknown): UnsignedEventLike | null {
  if (!params || typeof params !== 'object') return null;
  const event = (params as { event?: unknown }).event;
  if (!event || typeof event !== 'object') return null;
  const e = event as { kind?: unknown; content?: unknown; tags?: unknown; created_at?: unknown };
  const out: UnsignedEventLike = {};
  if (typeof e.kind === 'number') out.kind = e.kind;
  if (typeof e.content === 'string') out.content = e.content;
  if (typeof e.created_at === 'number') out.created_at = e.created_at;
  if (Array.isArray(e.tags)) {
    const tags: string[][] = [];
    for (const t of e.tags) {
      if (Array.isArray(t) && t.every((v) => typeof v === 'string')) {
        tags.push(t as string[]);
      }
    }
    out.tags = tags;
  }
  return out;
}

/**
 * Pull the raw `event` payload out of a `signEvent` params blob,
 * unmodified, for the JSON inspector under each event card. Unlike
 * {@link extractUnsignedEvent} this does not coerce or filter fields
 * — the user gets exactly what the page sent, including any extra
 * keys, so they can audit it before approving the signature. Returns
 * `null` when the params don't carry a usable `event` object; the
 * caller falls back to dumping `params` itself in that case.
 */
function extractRawEvent(params: unknown): unknown {
  if (!params || typeof params !== 'object') return null;
  const event = (params as { event?: unknown }).event;
  if (!event || typeof event !== 'object') return null;
  return event;
}

export default Prompt;
