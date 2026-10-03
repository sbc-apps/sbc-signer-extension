/**
 * Background service worker — the extension's central router.
 *
 * Responsibilities:
 *  - Receive `signer-rpc` messages from content scripts.
 *  - Consult the permissions store. On a missing decision, open a prompt
 *    window and wait for the user's response.
 *  - When allowed, invoke the active signer (nsec or bunker) and return
 *    the result.
 *
 * Batching:
 *  - At most ONE prompt window exists per browser tab at a time.
 *  - If a prompt is already open for a tab, subsequent calls from that
 *    tab that need approval are appended to the same batch. The prompt
 *    window is notified and re-renders with the new items.
 *  - Items within a batch are grouped by method so the user can approve
 *    or reject a whole group ("signEvent × 3") in one click.
 *
 * Permission UX (per group):
 *  - "Allow once" → resolve every item in the group; no persistence.
 *  - "Allow always" → persist `{origin, method} -> 'allow'` and resolve.
 *  - "Deny" → reject every item in the group; no persistence (so the user
 *    sees the prompt again next visit). Persistent denial lives in the
 *    popup as "block this site".
 */

// Must be first: installs globalThis.Buffer, which `bitcoinjs-lib` (used
// transitively by `signer.ts` -> `signPsbtForActiveLogin` -> `signPsbtLocal`)
// requires at module-evaluation time. Without this, signPsbt fails with
// "Buffer is not defined" inside the service worker.
import '@/lib/polyfills';

import { nip19 } from 'nostr-tools';

import type {
  ArchiveCollection,
  HighlightCollection,
  OriginInfo,
  InternalMessage,
  ItemAction,
  PendingPromptItem,
  PromptAction,
  PromptBatch,
  PromptBatchUpdate,
  NostrRpcMethod,
  ConnectAction,
} from './messages';
import { MESSAGE_SCOPE } from './messages';
import {
  getPermission,
  isOriginConnected,
  setPermission,
  setSiteBlocked,
  touchOrigin,
} from './permissions';
import { getActivePubkey, getActiveSigner, signPsbtForActiveLogin } from './signer';
import {
  installBadgeHandlers,
  invalidateCommentCount,
  refreshActiveTabBadge,
} from './commentBadge';
import { canonicalizePageUrl } from '@/lib/canonicalUrl';
import { createDraft, discardDraft, getDraft } from './highlightDraft';
import {
  createArchiveDraft,
  discardArchiveDraft,
  getArchiveDraft,
} from './archiveDraft';

const PROMPT_WINDOW_WIDTH = 400;
const PROMPT_WINDOW_HEIGHT = 600;

/** Sentinel tab id used for RPCs that have no associated tab (shouldn't normally happen). */
const NO_TAB = -1;

interface PendingItem {
  id: string;
  method: NostrRpcMethod;
  params: unknown;
  origin: OriginInfo;
  createdAt: number;
  resolve: (action: PromptAction) => void;
  reject: (err: Error) => void;
}

interface BatchState {
  batchId: string;
  /**
   * `'connect'` for the first-time prompt for a site (Connect / Block Site).
   * `'approve'` for the standard per-method approval prompt. A connect
   * batch can morph into an approve batch in place once the user clicks
   * Connect and there are still items pending other than the implicitly
   * granted `getPublicKey` / `getRelays` reads.
   */
  kind: 'connect' | 'approve';
  tabId: number;
  origin: OriginInfo;
  /**
   * The pubkey of the account that was active when the batch was
   * created. Permission writes scoped to this pubkey are correct even
   * if the user switches accounts mid-prompt — the rule the prompt is
   * resolving belongs to the account that was logged in when the page
   * called `window.nostr.*`.
   */
  pubkey: string;
  items: PendingItem[];
  /** Resolved once the prompt window is actually open. */
  windowReady: Promise<number>;
  windowId?: number;
}

/** One batch per tabId. At most one prompt window per tab. */
const batchesByTab = new Map<number, BatchState>();
/** Reverse lookup for window close events. */
const batchesByWindow = new Map<number, BatchState>();
/** Direct lookup for the prompt window to fetch its batch. */
const batchesById = new Map<string, BatchState>();

/**
 * Tabs whose user dismissed or rejected a prompt (connect or approve)
 * without leaving a persistent decision. Every subsequent signer RPC
 * from that tab rejects immediately — no new prompt window opens — UNTIL
 * one of:
 *   - the tab navigates (reload or URL change);
 *   - the tab closes;
 *   - a fresh signer call arrives with transient user activation
 *     (i.e. originating from a click/keydown handler), which clears the
 *     suppression in `handleSignerRpc` and lets the prompt re-open.
 *
 * This applies uniformly to connect prompts and approve prompts: a
 * dismissed prompt cannot pop itself again on a timer or background
 * task; only a real user gesture (or a navigation) can re-trigger it.
 *
 * Lives in service-worker memory only — if Chrome evicts the worker the
 * suppression resets, but at that point any in-flight calls have already
 * rejected so the user-visible behavior is unchanged.
 *
 * Keyed by tab id; the value is the origin that was suppressed. We only
 * suppress for the *same* origin, so navigating to a different site
 * within the same tab still gets a fresh prompt opportunity.
 */
const suppressedTabs = new Map<number, string>();

function isTabSuppressed(tabId: number, origin: string): boolean {
  return suppressedTabs.get(tabId) === origin;
}

function suppressTab(tabId: number, origin: string): void {
  if (tabId === NO_TAB) return;
  suppressedTabs.set(tabId, origin);
}

function clearTabSuppression(tabId: number): void {
  suppressedTabs.delete(tabId);
}

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Pull `event.kind` out of a signEvent params blob; returns undefined when absent or invalid. */
function extractEventKind(params: unknown): number | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const event = (params as { event?: unknown }).event;
  if (!event || typeof event !== 'object') return undefined;
  const kind = (event as { kind?: unknown }).kind;
  return typeof kind === 'number' && Number.isFinite(kind) ? kind : undefined;
}

/** Build the payload the prompt window renders. */
function serializeBatch(batch: BatchState): PromptBatch {
  /**
   * For `signEvent`, sub-group by event kind so the user can approve
   * each kind independently (e.g. allow kind 1 notes always, but
   * always re-prompt for kind 5 deletions). Items whose params don't
   * carry a numeric kind fall into a single "no-kind" group keyed by
   * undefined; this avoids losing them while still letting the rest
   * of the UI work.
   *
   * For every other method we keep the legacy single-group-per-method
   * behavior.
   */
  type GroupKey = string;
  const keyFor = (item: PendingItem): GroupKey => {
    if (item.method !== 'signEvent') return item.method;
    const kind = extractEventKind(item.params);
    return kind === undefined ? `${item.method}:nokind` : `${item.method}:${kind}`;
  };

  const groups = new Map<
    GroupKey,
    { method: NostrRpcMethod; kind: number | undefined; items: PendingPromptItem[] }
  >();
  for (const item of batch.items) {
    const key = keyFor(item);
    let group = groups.get(key);
    if (!group) {
      group = {
        method: item.method,
        kind: item.method === 'signEvent' ? extractEventKind(item.params) : undefined,
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push({
      id: item.id,
      method: item.method,
      params: item.params,
      createdAt: item.createdAt,
    });
  }
  return {
    batchId: batch.batchId,
    kind: batch.kind,
    origin: batch.origin,
    pubkey: batch.pubkey,
    groups: [...groups.values()].map((g) => ({
      origin: batch.origin,
      method: g.method,
      kind: g.kind,
      items: g.items,
    })),
  };
}

/**
 * Center the prompt on the same monitor as the user's currently focused
 * browser window. Falls back to (0, 0) if the window bounds are unknown.
 */
async function getCenteredPromptPosition(): Promise<{ left: number; top: number }> {
  try {
    const current = await chrome.windows.getCurrent();
    const winLeft = current.left ?? 0;
    const winTop = current.top ?? 0;
    const winWidth = current.width ?? 0;
    const winHeight = current.height ?? 0;
    const left = Math.round(winLeft + (winWidth - PROMPT_WINDOW_WIDTH) / 2);
    const top = Math.round(winTop + (winHeight - PROMPT_WINDOW_HEIGHT) / 2);
    return { left: Math.max(left, 0), top: Math.max(top, 0) };
  } catch {
    return { left: 0, top: 0 };
  }
}

function openPromptWindow(batchId: string): Promise<number> {
  const url = chrome.runtime.getURL(`src/prompt.html?id=${encodeURIComponent(batchId)}`);
  return new Promise((resolve, reject) => {
    getCenteredPromptPosition().then(({ left, top }) => {
      chrome.windows.create(
        {
          url,
          type: 'popup',
          width: PROMPT_WINDOW_WIDTH,
          height: PROMPT_WINDOW_HEIGHT,
          left,
          top,
          focused: true,
        },
        (win) => {
          if (chrome.runtime.lastError || !win?.id) {
            reject(new Error(chrome.runtime.lastError?.message ?? 'Failed to open prompt window'));
            return;
          }
          resolve(win.id);
        },
      );
    });
  });
}

/** Best-effort push to the prompt window so it refreshes. */
async function notifyBatchUpdated(batch: BatchState): Promise<void> {
  const payload: PromptBatchUpdate = {
    kind: 'prompt-batch-updated',
    batchId: batch.batchId,
    batch: batch.items.length > 0 ? serializeBatch(batch) : null,
  };
  try {
    await chrome.runtime.sendMessage(payload);
  } catch {
    // Prompt window may not be open yet or may have closed — ignore.
  }
}

/**
 * Queue a call that needs user approval. If there's already an open
 * batch for the sender's tab, piggy-back on it; otherwise start a new
 * batch and open a prompt window.
 *
 * `kind` only takes effect when a *new* batch is created. When piggy-
 * backing on an existing batch, the existing batch's kind is preserved
 * (a connect batch stays a connect batch even when more items arrive
 * while the user is deciding whether to connect).
 */
function enqueuePrompt(
  tabId: number,
  method: NostrRpcMethod,
  origin: OriginInfo,
  params: unknown,
  pubkey: string,
  kind: 'connect' | 'approve',
): Promise<PromptAction> {
  return new Promise<PromptAction>((resolve, reject) => {
    const item: PendingItem = {
      id: genId(),
      method,
      params,
      origin,
      createdAt: Date.now(),
      resolve,
      reject,
    };

    const existing = batchesByTab.get(tabId);
    // Reuse an open batch only if it's for the same origin. If the tab
    // navigated to a different origin, close the old batch first so we
    // don't mix requests from unrelated sites in one prompt.
    if (existing && existing.origin.origin === origin.origin) {
      existing.items.push(item);
      // For a connect batch we don't surface new items in the UI, but
      // we still notify so the (currently silent) view can re-render
      // counts if it ever needs to.
      notifyBatchUpdated(existing);
      return;
    }

    if (existing) {
      // Stale batch from a different origin — deny everything pending and
      // tear it down before starting fresh.
      rejectBatch(existing, 'Navigation cancelled the pending request.');
    }

    const batchId = genId();
    const batch: BatchState = {
      batchId,
      kind,
      tabId,
      origin,
      pubkey,
      items: [item],
      // Populated below after the window opens.
      windowReady: Promise.resolve(NO_TAB),
    };
    batchesByTab.set(tabId, batch);
    batchesById.set(batchId, batch);

    const ready = openPromptWindow(batchId)
      .then((windowId) => {
        batch.windowId = windowId;
        batchesByWindow.set(windowId, batch);
        return windowId;
      })
      .catch((err: Error) => {
        // Couldn't open the window — fail every item in the batch.
        teardownBatch(batch);
        for (const it of batch.items) it.reject(err);
        throw err;
      });
    batch.windowReady = ready;
  });
}

/** Remove batch from all indexes (does not resolve items). */
function teardownBatch(batch: BatchState): void {
  batchesById.delete(batch.batchId);
  if (batchesByTab.get(batch.tabId) === batch) {
    batchesByTab.delete(batch.tabId);
  }
  if (batch.windowId !== undefined && batchesByWindow.get(batch.windowId) === batch) {
    batchesByWindow.delete(batch.windowId);
  }
}

function rejectBatch(batch: BatchState, reason: string): void {
  const items = batch.items;
  batch.items = [];
  teardownBatch(batch);
  // Close the now-stale prompt window if one was opened.
  if (batch.windowId !== undefined) {
    chrome.windows.remove(batch.windowId).catch(() => {});
  }
  for (const it of items) it.reject(new Error(reason));
}

/**
 * Close the prompt window for a batch if it has no remaining items.
 * Returns true if the window was closed.
 */
async function closeIfEmpty(batch: BatchState): Promise<boolean> {
  if (batch.items.length > 0) return false;
  teardownBatch(batch);
  if (batch.windowId !== undefined) {
    try {
      await chrome.windows.remove(batch.windowId);
    } catch {
      // Window may already be gone.
    }
  }
  return true;
}

// If the user closes the prompt window without choosing:
//   - For an "approve" batch, treat every still-pending item as a
//     one-off denial AND suppress further prompts for the tab+origin
//     until the page navigates or a fresh user gesture re-triggers a
//     signer call.
//   - For a "connect" batch, do the same (the suppression behavior is
//     identical; only the prompt UI differs).
chrome.windows?.onRemoved.addListener((windowId) => {
  const batch = batchesByWindow.get(windowId);
  if (!batch) return;
  const items = batch.items;
  batch.items = [];
  teardownBatch(batch);
  // Closing the prompt without choosing is treated as a global "reject
  // all" — suppress further prompts for this tab+origin so the page
  // can't immediately re-pop a window. The page may re-trigger by
  // calling a signer method directly from a user gesture, which clears
  // the suppression in `handleSignerRpc`.
  suppressTab(batch.tabId, batch.origin.origin);
  for (const it of items) it.resolve('deny');
});

async function handleSignerRpc(
  method: NostrRpcMethod,
  params: unknown,
  origin: OriginInfo,
  tabId: number,
  userActivated: boolean,
): Promise<unknown> {
  // Make sure we have a logged-in signer before prompting — a prompt is
  // meaningless if there's nothing to sign with.
  let signer;
  try {
    signer = await getActiveSigner();
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }

  // The active account's pubkey scopes every permission read and write
  // for the rest of this call. Read it from storage (cheap, no network)
  // — `getActiveSigner` already succeeded, so a login exists. If for
  // some reason it doesn't (race with logout), fail loudly.
  const pubkey = await getActivePubkey();
  if (!pubkey) {
    throw new Error('Not logged in. Open the SBC Signer Extension to log in.');
  }

  // The user dismissed or rejected a prompt for this (tab, origin)
  // without leaving a persistent decision. Reject silently until the
  // tab navigates, closes, OR a call arrives with transient user
  // activation — i.e. the page reached `window.nostr.*` within ~5s
  // of a trusted user gesture.
  //
  // We use the loose `userActivated` flag (the Web Platform's
  // `navigator.userActivation.isActive`) because real apps route
  // signer calls through libraries that do `await`s before reaching
  // the signer (e.g. clicking "Post" → library validation → signEvent),
  // and any stricter "must be on the synchronous gesture stack" rule
  // rejects those legitimate flows. The trade-off is that pages
  // chattering via setInterval / observers can piggy-back on an
  // unrelated user click; we accept that — real authorization is
  // still enforced by the prompt UI.
  if (isTabSuppressed(tabId, origin.origin)) {
    if (userActivated) {
      clearTabSuppression(tabId);
    } else {
      throw new Error('Permission prompt was dismissed. Refresh the page or try again from a user gesture.');
    }
  }

  // For `signEvent`, the permission is scoped to the event's kind.
  // Pull `event.kind` out of params before checking; if it's missing
  // or not a number we proceed without a kind hint, which means the
  // legacy/site-wide rules still apply but no per-kind rule will match.
  const eventKind = method === 'signEvent' ? extractEventKind(params) : undefined;

  // signPsbt is intentionally NEVER cached. Each PSBT can move
  // different funds to different recipients, and granting a standing
  // allow rule would be a footgun. Skip the persistent-rule lookup
  // entirely — a fresh prompt is required for every call.
  const skipPersistentLookup = method === 'signPsbt';

  const existing = skipPersistentLookup
    ? null
    : await getPermission(pubkey, origin.origin, method, eventKind);
  if (existing === 'deny') {
    throw new Error('Permission denied for this site.');
  }
  if (existing !== 'allow') {
    // First-time interaction with this origin under this account (no
    // `allow` ever recorded for any method, no site-wide block) → open
    // the dedicated Connect prompt instead of the per-method approval
    // prompt. Connection state is per-account, so the same site that's
    // connected under one identity may still need a fresh connect
    // prompt the first time it's used under a different identity.
    const connected = await isOriginConnected(pubkey, origin.origin);
    const kind: 'connect' | 'approve' = connected ? 'approve' : 'connect';

    // User-activation gate for the very first connect: a site that
    // has never been connected must reach the signer as a result of
    // some user interaction. Same loose `userActivated` semantics as
    // the suppression check above, for the same reason — library
    // flows like `onClick = async () => { await login.extension(); }`
    // would otherwise be rejected.
    //
    // Once the site is connected, approval prompts for additional
    // methods don't require a fresh gesture: the user already chose
    // to trust the site, and forcing a gesture would break legitimate
    // post-load workflows like background sync.
    if (kind === 'connect' && !userActivated) {
      throw new Error(
        'User activation required: call window.nostr.* directly from a user gesture (e.g. inside a click handler) the first time a site connects.',
      );
    }

    const decision = await enqueuePrompt(tabId, method, origin, params, pubkey, kind);
    if (decision === 'deny-always') {
      // signPsbt is intentionally non-persistable: never write a rule
      // even if the prompt UI somehow surfaces this branch. Treat as a
      // one-shot deny.
      if (method === 'signPsbt') {
        throw new Error('User rejected the request.');
      }
      // Persist the deny rule before rejecting so the next call from
      // this site short-circuits in `getPermission` without ever
      // showing the prompt again. Scoping mirrors `allow-always`:
      // per-kind for signEvent (when a kind is known), method-wide
      // for everything else.
      await setPermission(pubkey, origin.origin, method, 'deny', {
        title: origin.title,
        icon: origin.icon,
        kind: method === 'signEvent' ? eventKind : undefined,
      });
      throw new Error('User rejected the request.');
    }
    if (decision === 'deny') {
      throw new Error('User rejected the request.');
    }
    if (decision === 'allow-always') {
      // signPsbt is intentionally non-persistable. If the prompt UI
      // somehow returns `allow-always` for it, treat as a one-shot
      // allow and do not write a rule.
      if (method === 'signPsbt') {
        await touchOrigin(pubkey, origin.origin, { title: origin.title, icon: origin.icon });
      } else {
        // For signEvent, scope the persisted rule to this event's kind
        // (when known). For every other method, kind is ignored and the
        // method-wide rule is written.
        await setPermission(pubkey, origin.origin, method, 'allow', {
          title: origin.title,
          icon: origin.icon,
          kind: method === 'signEvent' ? eventKind : undefined,
        });
      }
    } else if (decision === 'allow-always-any') {
      // signEvent escape hatch: persist the catch-all "any kind" rule.
      // For non-signEvent methods this collapses to the same as
      // `allow-always` since they have no kind dimension. signPsbt
      // remains non-persistable.
      if (method === 'signPsbt') {
        await touchOrigin(pubkey, origin.origin, { title: origin.title, icon: origin.icon });
      } else {
        await setPermission(pubkey, origin.origin, method, 'allow', {
          title: origin.title,
          icon: origin.icon,
        });
      }
    } else {
      await touchOrigin(pubkey, origin.origin, { title: origin.title, icon: origin.icon });
    }
  } else {
    await touchOrigin(pubkey, origin.origin, { title: origin.title, icon: origin.icon });
  }

  // Execute the method.
  switch (method) {
    case 'getPublicKey':
      return signer.getPublicKey();
    case 'getRelays':
      // Minimal implementation: return an empty relay map. Real relay
      // routing is the page's job; we expose this for NIP-07 compliance.
      return signer.getRelays ? signer.getRelays() : {};
    case 'signEvent': {
      const { event } = (params ?? {}) as { event?: Parameters<typeof signer.signEvent>[0] };
      if (!event) throw new Error('signEvent requires an event param.');
      return signer.signEvent(event);
    }
    case 'nip04.encrypt': {
      const { pubkey, plaintext } = (params ?? {}) as { pubkey?: string; plaintext?: string };
      if (!pubkey || typeof plaintext !== 'string') throw new Error('nip04.encrypt requires pubkey and plaintext.');
      if (!signer.nip04) throw new Error('Signer does not support NIP-04.');
      return signer.nip04.encrypt(pubkey, plaintext);
    }
    case 'nip04.decrypt': {
      const { pubkey, ciphertext } = (params ?? {}) as { pubkey?: string; ciphertext?: string };
      if (!pubkey || typeof ciphertext !== 'string') throw new Error('nip04.decrypt requires pubkey and ciphertext.');
      if (!signer.nip04) throw new Error('Signer does not support NIP-04.');
      return signer.nip04.decrypt(pubkey, ciphertext);
    }
    case 'nip44.encrypt': {
      const { pubkey, plaintext } = (params ?? {}) as { pubkey?: string; plaintext?: string };
      if (!pubkey || typeof plaintext !== 'string') throw new Error('nip44.encrypt requires pubkey and plaintext.');
      if (!signer.nip44) throw new Error('Signer does not support NIP-44.');
      return signer.nip44.encrypt(pubkey, plaintext);
    }
    case 'nip44.decrypt': {
      const { pubkey, ciphertext } = (params ?? {}) as { pubkey?: string; ciphertext?: string };
      if (!pubkey || typeof ciphertext !== 'string') throw new Error('nip44.decrypt requires pubkey and ciphertext.');
      if (!signer.nip44) throw new Error('Signer does not support NIP-44.');
      return signer.nip44.decrypt(pubkey, ciphertext);
    }
    case 'signPsbt': {
      const { psbtHex } = (params ?? {}) as { psbtHex?: string };
      if (typeof psbtHex !== 'string' || psbtHex.length === 0) {
        throw new Error('signPsbt requires a hex-encoded PSBT.');
      }
      return signPsbtForActiveLogin(psbtHex);
    }
    default: {
      const _exhaustive: never = method;
      throw new Error(`Unknown method: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Resolve every pending item matching `predicate` with `action`, then
 * close the prompt window if no items remain. Also updates the prompt
 * window if there are still items left.
 */
async function resolveMatching(
  batch: BatchState,
  predicate: (item: PendingItem) => boolean,
  action: PromptAction,
): Promise<void> {
  const toResolve: PendingItem[] = [];
  const remaining: PendingItem[] = [];
  for (const item of batch.items) {
    if (predicate(item)) toResolve.push(item);
    else remaining.push(item);
  }
  batch.items = remaining;

  for (const item of toResolve) item.resolve(action);

  const closed = await closeIfEmpty(batch);
  if (!closed) {
    await notifyBatchUpdated(batch);
  }
}

/**
 * Resolve a single pending item by id. Used for per-item Allow / Deny
 * controls in both `signEvent` cards and decrypt-preview cards.
 *
 * Per-item decisions are intentionally one-shot (no `allow-always`
 * variant): granting a single in-memory ciphertext or event template
 * can't be meaningfully persisted, since the next call from the page
 * will have a different payload and any "remember this decision" rule
 * would either match too much or nothing at all. The user gets the
 * same lasting-rule controls via the group-level `Always allow …`
 * buttons.
 */
async function resolveItem(
  batch: BatchState,
  itemId: string,
  action: ItemAction,
): Promise<void> {
  const idx = batch.items.findIndex((it) => it.id === itemId);
  if (idx === -1) return; // already resolved or never existed
  const [item] = batch.items.splice(idx, 1);
  item.resolve(action);

  const closed = await closeIfEmpty(batch);
  if (!closed) {
    await notifyBatchUpdated(batch);
  }
}

/**
 * Handle the user's choice on a Connect-style prompt.
 *
 *  - `'connect'` persists `getPublicKey -> 'allow'` and
 *    `getRelays -> 'allow'`, resolves every queued `getPublicKey` /
 *    `getRelays` request, and morphs the batch into an approval prompt
 *    for any remaining items so the user can decide on those next. If
 *    nothing remains, the window closes.
 *  - `'block'` persists a site-wide deny and rejects every queued item.
 *  - `'cancel'` rejects every queued item once and suppresses further
 *    prompts for this tab + origin until the tab navigates or closes.
 */
async function handleConnectDecision(
  batch: BatchState,
  action: ConnectAction,
): Promise<void> {
  if (batch.kind !== 'connect') {
    throw new Error('Batch is not a connect prompt.');
  }

  const meta = { title: batch.origin.title, icon: batch.origin.icon };
  const pubkey = batch.pubkey;

  if (action === 'connect') {
    // Mark the origin as connected by ensuring an entry exists with
    // up-to-date metadata, scoped to the account that was active when
    // the prompt was created. `getPublicKey` and `getRelays` are NOT
    // persisted as granular rules — every connected origin implicitly
    // allows both (see `isOriginConnected` / `getPermission`), so a
    // bare `touchOrigin` is enough to grant them forever.
    await touchOrigin(pubkey, batch.origin.origin, meta);
    // Auto-approve every queued getPublicKey/getRelays so the page sees
    // the data it asked for. Other methods stay queued; we'll re-render
    // the window as a regular approval prompt for them.
    const remaining: PendingItem[] = [];
    const toResolve: PendingItem[] = [];
    for (const item of batch.items) {
      if (item.method === 'getPublicKey' || item.method === 'getRelays') {
        toResolve.push(item);
      } else {
        remaining.push(item);
      }
    }
    batch.items = remaining;
    for (const item of toResolve) item.resolve('allow-once');

    if (remaining.length === 0) {
      await closeIfEmpty(batch);
      return;
    }
    // Morph the batch into a normal approval prompt and let the prompt
    // window re-render with the per-method controls.
    batch.kind = 'approve';
    await notifyBatchUpdated(batch);
    return;
  }

  if (action === 'block') {
    await setSiteBlocked(pubkey, batch.origin.origin, meta);
    rejectBatch(batch, 'Site is blocked.');
    return;
  }

  // 'cancel' — equivalent to closing the window without choosing.
  suppressTab(batch.tabId, batch.origin.origin);
  const items = batch.items;
  batch.items = [];
  teardownBatch(batch);
  if (batch.windowId !== undefined) {
    chrome.windows.remove(batch.windowId).catch(() => {});
  }
  for (const it of items) it.resolve('deny');
}

/**
 * Find an existing extension tab on `src/options.html` (any hash) and
 * focus it, navigating to the requested HashRouter route. If no such
 * tab exists, opens a new one. Runs in the background so popup
 * teardown can't abort the chain mid-flight (which is what happened
 * when the cog/balance pill ran this logic in the popup itself).
 */
const OPTIONS_PATH = 'src/options.html';

async function focusOrOpenOptionsTab(route: '/' | '/wallet'): Promise<void> {
  const targetHash = route === '/' ? '' : `#${route}`;
  const targetUrl = chrome.runtime.getURL(`${OPTIONS_PATH}${targetHash}`);
  const optionsPrefix = chrome.runtime.getURL(OPTIONS_PATH);

  // Query *all* tabs and filter by URL prefix in JS. Match patterns
  // can't express "ignore the fragment" cleanly, and a malformed
  // pattern like `${prefix}*` throws synchronously.
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    // ignore — fall through to creating a new tab
  }

  const existing = tabs.find((tab) => {
    const url = tab.url ?? tab.pendingUrl;
    return typeof url === 'string' && url.startsWith(optionsPrefix);
  });

  if (existing?.id !== undefined) {
    if (existing.windowId !== undefined && chrome.windows?.update) {
      try {
        await chrome.windows.update(existing.windowId, { focused: true });
      } catch {
        // window may have been closed between query and update
      }
    }
    const updateProps: chrome.tabs.UpdateProperties = { active: true };
    if (existing.url !== targetUrl) {
      updateProps.url = targetUrl;
    }
    await chrome.tabs.update(existing.id, updateProps);
    return;
  }

  await chrome.tabs.create({ url: targetUrl });
}

chrome.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
  const message = rawMessage as InternalMessage;
  if (!message || typeof message !== 'object' || !('kind' in message)) {
    return false;
  }

  if (message.kind === 'signer-rpc') {
    const tabId = sender.tab?.id ?? NO_TAB;
    handleSignerRpc(message.method, message.params, message.origin, tabId, message.userActivated)
      .then((result) => sendResponse({ result }))
      .catch((err: Error) => sendResponse({ error: err?.message ?? String(err) }));
    return true; // keep sendResponse alive for async reply
  }

  if (message.kind === 'internal-sign-psbt') {
    // Direct path from the extension's own UI. We intentionally trust
    // the caller here because Chrome only delivers `chrome.runtime`
    // messages from extension-owned pages and content scripts that we
    // ship; an arbitrary website cannot reach this branch.
    signPsbtForActiveLogin(message.psbtHex)
      .then((result) => sendResponse({ result }))
      .catch((err: Error) => sendResponse({ error: err?.message ?? String(err) }));
    return true;
  }

  if (message.kind === 'get-pending-batch') {
    const batch = batchesById.get(message.batchId);
    sendResponse(batch ? { batch: serializeBatch(batch) } : { batch: null });
    return false;
  }

  if (message.kind === 'resolve-prompt-group') {
    const batch = batchesById.get(message.batchId);
    if (!batch) {
      sendResponse({ ok: false, error: 'Batch not found.' });
      return false;
    }
    // A `deny` / `deny-always` from the prompt UI is a user-driven
    // rejection: suppress further prompts for this tab+origin until
    // the page navigates or a fresh user gesture re-triggers a call.
    // (`deny-always` additionally persists the rule — handled in the
    // resolver downstream — but the suppression is the same.)
    if (message.action === 'deny' || message.action === 'deny-always') {
      suppressTab(batch.tabId, batch.origin.origin);
    }
    const targetMethod = message.method;
    const targetKind = message.eventKind;
    const predicate =
      targetMethod === 'signEvent' && targetKind !== undefined
        ? (it: PendingItem) =>
            it.method === 'signEvent' && extractEventKind(it.params) === targetKind
        : (it: PendingItem) => it.method === targetMethod;
    resolveMatching(batch, predicate, message.action)
      .then(() => sendResponse({ ok: true }))
      .catch((err: Error) => sendResponse({ ok: false, error: err?.message ?? String(err) }));
    return true;
  }

  if (message.kind === 'resolve-prompt-all') {
    const batch = batchesById.get(message.batchId);
    if (!batch) {
      sendResponse({ ok: false, error: 'Batch not found.' });
      return false;
    }
    if (message.action === 'deny' || message.action === 'deny-always') {
      suppressTab(batch.tabId, batch.origin.origin);
    }
    resolveMatching(batch, () => true, message.action)
      .then(() => sendResponse({ ok: true }))
      .catch((err: Error) => sendResponse({ ok: false, error: err?.message ?? String(err) }));
    return true;
  }

  if (message.kind === 'resolve-prompt-item') {
    const batch = batchesById.get(message.batchId);
    if (!batch) {
      sendResponse({ ok: false, error: 'Batch not found.' });
      return false;
    }
    // Per-item denials don't trigger tab suppression — the user is
    // making a per-event decision, not signaling "stop bothering me
    // about this site". Group/all-level denials still suppress.
    resolveItem(batch, message.itemId, message.action)
      .then(() => sendResponse({ ok: true }))
      .catch((err: Error) => sendResponse({ ok: false, error: err?.message ?? String(err) }));
    return true;
  }

  if (message.kind === 'resolve-connect') {
    const batch = batchesById.get(message.batchId);
    if (!batch) {
      sendResponse({ ok: false, error: 'Batch not found.' });
      return false;
    }
    handleConnectDecision(batch, message.action)
      .then(() => sendResponse({ ok: true }))
      .catch((err: Error) => sendResponse({ ok: false, error: err?.message ?? String(err) }));
    return true;
  }

  if (message.kind === 'decrypt-preview') {
    const batch = batchesById.get(message.batchId);
    if (!batch) {
      sendResponse({ ok: false, error: 'Batch not found.' });
      return false;
    }
    const item = batch.items.find((it) => it.id === message.itemId);
    if (!item) {
      sendResponse({ ok: false, error: 'Item not found.' });
      return false;
    }
    if (item.method !== 'nip04.decrypt' && item.method !== 'nip44.decrypt') {
      sendResponse({ ok: false, error: 'Item is not a decrypt request.' });
      return false;
    }
    const params = (item.params ?? {}) as { pubkey?: unknown; ciphertext?: unknown };
    const pubkey = typeof params.pubkey === 'string' ? params.pubkey : '';
    const ciphertext = typeof params.ciphertext === 'string' ? params.ciphertext : '';
    if (!pubkey || !ciphertext) {
      sendResponse({ ok: false, error: 'Missing pubkey or ciphertext.' });
      return false;
    }
    (async () => {
      try {
        const signer = await getActiveSigner();
        const nip = item.method === 'nip04.decrypt' ? signer.nip04 : signer.nip44;
        if (!nip) {
          throw new Error(
            `Signer does not support ${item.method === 'nip04.decrypt' ? 'NIP-04' : 'NIP-44'}.`,
          );
        }
        const plaintext = await nip.decrypt(pubkey, ciphertext);
        sendResponse({ ok: true, plaintext });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (message.kind === 'comment-posted') {
    // The user just published a NIP-22 comment from the popup; drop our
    // cached count for that page and re-query so the badge reflects it.
    invalidateCommentCount(message.canonicalUrl);
    refreshActiveTabBadge().catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (message.kind === 'open-options-tab') {
    // Done in the background (rather than in the popup itself) because
    // the popup loses focus and tears down the moment we activate
    // another tab — which can abort an in-flight tabs.query/update
    // chain. The service worker has stable lifetime for the duration
    // of this call.
    focusOrOpenOptionsTab(message.route)
      .then(() => sendResponse({ ok: true }))
      .catch((err: Error) => sendResponse({ ok: false, error: err?.message ?? String(err) }));
    return true;
  }

  if (message.kind === 'get-highlight-draft') {
    const draft = getDraft(message.draftId);
    sendResponse({ draft });
    return false;
  }

  if (message.kind === 'discard-highlight-draft') {
    discardDraft(message.draftId);
    sendResponse({ ok: true });
    return false;
  }

  if (message.kind === 'open-archive') {
    // Same rationale as `open-options-tab`: the popup is torn down as
    // soon as it loses focus, and capturing a page then opening a
    // window is a multi-step async chain that must not be interrupted.
    startArchive(message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err: Error) => sendResponse({ ok: false, error: err?.message ?? String(err) }));
    return true;
  }

  if (message.kind === 'get-archive-draft') {
    const draft = getArchiveDraft(message.draftId);
    sendResponse({ draft });
    return false;
  }

  if (message.kind === 'discard-archive-draft') {
    discardArchiveDraft(message.draftId);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// Broadcast account changes to all tabs so in-page sessions can react.
// (Triggered when the popup switches accounts or logs out.)
async function broadcastAccountChanged() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) => {
        if (!tab.id) return Promise.resolve();
        return chrome.tabs
          .sendMessage(tab.id, {
            scope: MESSAGE_SCOPE,
            kind: 'event',
            event: 'accountChanged',
          })
          .catch(() => {}); // tabs without our content script reject; ignore
      }),
    );
  } catch {
    // ignore
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if ('ditto-extension:login' in changes) {
    broadcastAccountChanged();
  }
});

// Clear the per-tab "connect prompt was dismissed" suppression as soon
// as the page navigates (refresh counts as a navigation that fires
// `loading`) so a reload re-enables prompts. Closing the tab also
// clears the entry so a future tab with the same id starts fresh.
chrome.tabs?.onUpdated.addListener((tabId, changeInfo) => {
  // `status === 'loading'` fires for every navigation including reload;
  // a top-frame URL change (`changeInfo.url`) covers SPA pushState that
  // never reaches `loading`.
  if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') {
    clearTabSuppression(tabId);
  }
});

chrome.tabs?.onRemoved.addListener((tabId) => {
  clearTabSuppression(tabId);
});

// Wire up the per-tab comment-count badge. Listens for tab navigation
// + activation and updates the toolbar icon's badge text.
installBadgeHandlers();

// ---------------------------------------------------------------------------
// "Highlight on Nostr" context menu
// ---------------------------------------------------------------------------

const HIGHLIGHT_MENU_ID = 'sbc-highlight-on-nostr';
const HIGHLIGHT_WINDOW_WIDTH = 480;
const HIGHLIGHT_WINDOW_HEIGHT = 600;

/**
 * Map of composer-window id → draft id. Lets us drop the draft from
 * the in-memory store when the user closes the window without
 * submitting, so a fresh right-click doesn't see a stranded entry.
 */
const highlightWindows = new Map<number, string>();

/**
 * Decode every `nostr:` URI found in `<link rel~="me">` tags into a
 * 64-char hex pubkey. Accepts `npub` and `nprofile`; silently drops
 * malformed entries and anything else (`note`, `nevent`, `naddr`,
 * non-Nostr schemes that slipped through).
 *
 * Per the user's brief, the role marker on the `<link>` is ignored —
 * any `rel="me"` `nostr:` href is treated as an attribution.
 */
function decodeMeHrefs(hrefs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const href of hrefs) {
    // Strip the `nostr:` prefix; accept both lowercase and uppercase.
    const body = href.replace(/^nostr:/i, '').trim();
    if (!body) continue;
    let hex: string | null = null;
    try {
      const decoded = nip19.decode(body);
      if (decoded.type === 'npub') {
        hex = decoded.data;
      } else if (decoded.type === 'nprofile') {
        hex = decoded.data.pubkey;
      }
    } catch {
      // Malformed bech32 — drop silently.
    }
    if (!hex) continue;
    if (!/^[0-9a-f]{64}$/i.test(hex)) continue;
    const lower = hex.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

/**
 * Ask the focused frame to scrape the current selection and return a
 * `HighlightCollection`. Times out after 1.5s so a broken page can't
 * stall the context-menu flow.
 */
function requestHighlightCollection(
  tabId: number,
  frameId: number | undefined,
  fallbackSelection: string,
): Promise<HighlightCollection | null> {
  return new Promise((resolve) => {
    const message: InternalMessage = {
      kind: 'collect-highlight',
      fallbackSelection,
    };
    const options = typeof frameId === 'number' ? { frameId } : undefined;
    const timer = setTimeout(() => resolve(null), 1500);

    const cb = (response: unknown) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      if (
        !response ||
        typeof response !== 'object' ||
        !('ok' in response) ||
        (response as { ok?: unknown }).ok !== true
      ) {
        resolve(null);
        return;
      }
      const payload = (response as { payload?: unknown }).payload;
      if (!payload || typeof payload !== 'object') {
        resolve(null);
        return;
      }
      resolve(payload as HighlightCollection);
    };

    try {
      if (options) {
        chrome.tabs.sendMessage(tabId, message, options, cb);
      } else {
        chrome.tabs.sendMessage(tabId, message, cb);
      }
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

async function openHighlightComposer(draftId: string): Promise<void> {
  const url = chrome.runtime.getURL(
    `src/highlight.html?id=${encodeURIComponent(draftId)}`,
  );
  const { left, top } = await getCenteredPromptPosition();
  // Re-center because the highlight window is wider than the prompt;
  // `getCenteredPromptPosition` centers using the prompt's width.
  const current = await chrome.windows.getCurrent().catch(() => null);
  const winLeft = current?.left ?? 0;
  const winTop = current?.top ?? 0;
  const winW = current?.width ?? 0;
  const winH = current?.height ?? 0;
  const cLeft =
    winW > 0 ? Math.max(0, Math.round(winLeft + (winW - HIGHLIGHT_WINDOW_WIDTH) / 2)) : left;
  const cTop =
    winH > 0 ? Math.max(0, Math.round(winTop + (winH - HIGHLIGHT_WINDOW_HEIGHT) / 2)) : top;

  await new Promise<void>((resolve) => {
    chrome.windows.create(
      {
        url,
        type: 'popup',
        width: HIGHLIGHT_WINDOW_WIDTH,
        height: HIGHLIGHT_WINDOW_HEIGHT,
        left: cLeft,
        top: cTop,
        focused: true,
      },
      (win) => {
        if (win?.id) highlightWindows.set(win.id, draftId);
        resolve();
      },
    );
  });
}

async function handleHighlightContextClick(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): Promise<void> {
  if (info.menuItemId !== HIGHLIGHT_MENU_ID) return;
  if (!tab?.id) return;

  // Require an active login; we can't sign without one. The user
  // discovers this by clicking the toolbar icon — opening the popup
  // from here would be ideal but `chrome.action.openPopup()` is only
  // available from a user-gesture in MV3 and the context-menu click
  // qualifies in Chrome but not consistently across builds, so we
  // just fail gracefully if logged out.
  const pubkey = await getActivePubkey().catch(() => null);
  if (!pubkey) {
    // Best-effort: try to open the popup. Swallow failures.
    try {
      await chrome.action.openPopup?.();
    } catch {
      /* ignore */
    }
    return;
  }

  const fallback = info.selectionText ?? '';
  const collection = await requestHighlightCollection(tab.id, info.frameId, fallback);
  if (!collection || !collection.selectionText) return;

  // Canonicalize the source URL (strip tracking params). Fall back to
  // the raw URL string if canonicalization rejects it (non-http(s),
  // chrome-extension://, etc.) — those won't normally have a context
  // menu entry, but be defensive.
  const canonical = canonicalizePageUrl(collection.pageUrl);
  const pageUrl = canonical?.toString() ?? collection.pageUrl;

  const pAuthors = decodeMeHrefs(collection.meNostrHrefs);

  // Pull a per-tab favicon if the content script couldn't find one
  // (e.g. some SPAs only set it via React after mount).
  const pageIcon = collection.pageIcon ?? tab.favIconUrl ?? undefined;
  const pageTitle = collection.pageTitle ?? tab.title ?? undefined;

  const draftId = createDraft({
    selectionText: collection.selectionText,
    contextText: collection.contextText,
    pageUrl,
    pageTitle,
    pageIcon,
    pAuthors,
  });

  await openHighlightComposer(draftId);
}

// ---------------------------------------------------------------------------
// "Save as nsite" — page archiver
// ---------------------------------------------------------------------------

const ARCHIVE_MENU_ID = 'sbc-save-as-nsite';
const ARCHIVE_WINDOW_WIDTH = 520;
const ARCHIVE_WINDOW_HEIGHT = 640;

/**
 * Serializing a large DOM is much slower than reading a selection, so
 * this is generous compared to the highlight collector's 1.5s.
 */
const ARCHIVE_CAPTURE_TIMEOUT_MS = 15_000;

/** Map of archive-window id → draft id, for cleanup on close. */
const archiveWindows = new Map<number, string>();

/**
 * Ask the top-level frame to serialize itself. Resolves `null` on any
 * failure — a page with no content script (the Chrome Web Store, a
 * PDF viewer) simply can't be archived.
 */
function requestArchiveCollection(tabId: number): Promise<ArchiveCollection | null> {
  return new Promise((resolve) => {
    const message: InternalMessage = { kind: 'collect-archive' };
    const timer = setTimeout(() => resolve(null), ARCHIVE_CAPTURE_TIMEOUT_MS);

    const cb = (response: unknown) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      if (
        !response ||
        typeof response !== 'object' ||
        (response as { ok?: unknown }).ok !== true
      ) {
        resolve(null);
        return;
      }
      const payload = (response as { payload?: unknown }).payload;
      if (!payload || typeof payload !== 'object') {
        resolve(null);
        return;
      }
      resolve(payload as ArchiveCollection);
    };

    try {
      // `frameId: 0` — only the top document. Subframes are stripped
      // during sanitization anyway, and without this every frame's
      // content script races to answer.
      chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, cb);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

async function openArchiveWindow(draftId: string): Promise<void> {
  const url = chrome.runtime.getURL(`src/archive.html?id=${encodeURIComponent(draftId)}`);
  const { left, top } = await getCenteredPromptPosition();

  // Re-center: `getCenteredPromptPosition` measures against the prompt
  // window's width, and this one is wider.
  const current = await chrome.windows.getCurrent().catch(() => null);
  const winW = current?.width ?? 0;
  const winH = current?.height ?? 0;
  const cLeft =
    winW > 0
      ? Math.max(0, Math.round((current?.left ?? 0) + (winW - ARCHIVE_WINDOW_WIDTH) / 2))
      : left;
  const cTop =
    winH > 0
      ? Math.max(0, Math.round((current?.top ?? 0) + (winH - ARCHIVE_WINDOW_HEIGHT) / 2))
      : top;

  await new Promise<void>((resolve) => {
    chrome.windows.create(
      {
        url,
        type: 'popup',
        width: ARCHIVE_WINDOW_WIDTH,
        height: ARCHIVE_WINDOW_HEIGHT,
        left: cLeft,
        top: cTop,
        focused: true,
      },
      (win) => {
        if (win?.id) archiveWindows.set(win.id, draftId);
        resolve();
      },
    );
  });
}

/**
 * Capture a tab and open the archive window on it.
 *
 * The capture happens here, at click time, rather than in the archive
 * window: it guarantees the snapshot is the page the user was actually
 * looking at, even if they navigate away while the window opens.
 */
async function startArchive(explicitTabId?: number): Promise<void> {
  let tabId = explicitTabId;
  let tab: chrome.tabs.Tab | undefined;

  if (typeof tabId === 'number') {
    tab = await chrome.tabs.get(tabId).catch(() => undefined);
  } else {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  }

  if (typeof tabId !== 'number' || !tab) throw new Error('No page to archive.');
  if (!/^https?:/i.test(tab.url ?? '')) throw new Error('This page cannot be archived.');

  const pubkey = await getActivePubkey().catch(() => null);
  if (!pubkey) {
    try {
      await chrome.action.openPopup?.();
    } catch {
      /* ignore — the user can open the popup themselves */
    }
    throw new Error('Log in to save an archive.');
  }

  const collection = await requestArchiveCollection(tabId);
  if (!collection) throw new Error('Could not read this page.');

  const draftId = createArchiveDraft({
    ...collection,
    pageTitle: collection.pageTitle ?? tab.title ?? undefined,
    pageIcon: collection.pageIcon ?? tab.favIconUrl ?? undefined,
  });

  await openArchiveWindow(draftId);
}

// ---------------------------------------------------------------------------
// Context menu registration
// ---------------------------------------------------------------------------

function installContextMenus(): void {
  if (!chrome.contextMenus) return;
  // Recreate on every SW boot — `chrome.contextMenus.create` throws
  // if the id already exists, so remove first.
  chrome.contextMenus.removeAll(() => {
    const swallow = () => {
      // Swallow any lastError (e.g. duplicate id race) — the menu
      // is best-effort cosmetic and the next SW boot will retry.
      void chrome.runtime.lastError;
    };

    chrome.contextMenus.create(
      {
        id: HIGHLIGHT_MENU_ID,
        title: 'Highlight on Nostr',
        contexts: ['selection'],
        documentUrlPatterns: ['http://*/*', 'https://*/*'],
      },
      swallow,
    );

    chrome.contextMenus.create(
      {
        id: ARCHIVE_MENU_ID,
        title: 'Save page as nsite',
        contexts: ['page'],
        documentUrlPatterns: ['http://*/*', 'https://*/*'],
      },
      swallow,
    );
  });
}

// Install once on SW startup (covers fresh installs and worker wakes).
installContextMenus();
chrome.runtime.onInstalled?.addListener(() => installContextMenus());

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId === HIGHLIGHT_MENU_ID) {
    handleHighlightContextClick(info, tab).catch(() => {
      /* swallow — user can retry from the menu */
    });
    return;
  }

  if (info.menuItemId === ARCHIVE_MENU_ID) {
    startArchive(tab?.id).catch(() => {
      /* swallow — user can retry from the menu */
    });
  }
});

// If the user closes a composer or archive window without submitting,
// drop the draft rather than leaving it for the TTL sweep. Archive
// drafts in particular hold a whole rendered page, which on a
// logged-in site is content the user never agreed to publish.
chrome.windows?.onRemoved.addListener((windowId) => {
  const draftId = highlightWindows.get(windowId);
  if (draftId) {
    highlightWindows.delete(windowId);
    discardDraft(draftId);
  }

  const archiveDraftId = archiveWindows.get(windowId);
  if (archiveDraftId) {
    archiveWindows.delete(windowId);
    discardArchiveDraft(archiveDraftId);
  }
});
