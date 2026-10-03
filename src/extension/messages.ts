/**
 * Shared types for messages exchanged between the inpage provider
 * (window.nostr), the content script bridge, and the background service
 * worker.
 *
 * Flow: inpage -> content (window.postMessage) -> background (chrome.runtime)
 * and back. Each leg preserves the original `id` so responses can be
 * matched to their requests.
 */

/** Scope tag used to disambiguate extension postMessages on the page. */
export const MESSAGE_SCOPE = 'sbc-signer-extension' as const;

/** NIP-07 methods the inpage provider exposes to pages. */
export type NostrRpcMethod =
  | 'getPublicKey'
  | 'getRelays'
  | 'signEvent'
  | 'nip04.encrypt'
  | 'nip04.decrypt'
  | 'nip44.encrypt'
  | 'nip44.decrypt'
  /**
   * Bitcoin Taproot PSBT signing. See `BITCOIN-SIGNING.md` in the
   * Ditto project. The user's Nostr key is also their Taproot internal
   * key, so signing a PSBT with `tapInternalKey == ourPubkey` produces
   * a valid key-path Schnorr signature.
   *
   * Accepts both PSBTv0 and PSBTv2. If the payload is a BIP-375
   * (`Sending Silent Payments with PSBTs`) PSBTv2 carrying
   * `PSBT_OUT_SP_V0_INFO` outputs, the signer also computes the global
   * ECDH share + BIP-374 DLEQ proof per recipient scan key, derives the
   * per-output `PSBT_OUT_SCRIPT`s, then signs the Taproot inputs.
   *
   * SECURITY NOTE: signPsbt is intentionally NEVER persistable
   * (`allow-always` is not offered for this method). Each PSBT can
   * move different funds to different recipients, so granting a
   * standing rule would be a footgun. The prompt UI surfaces this
   * with allow-once / deny only. The prompt also displays
   * silent-payment `sp1…` recipients explicitly so users can verify
   * the intent before the on-chain P2TR address is derived.
   */
  | 'signPsbt';

/** Metadata about the page the request came from. */
export interface OriginInfo {
  /** Page URL origin, e.g. "https://example.com". */
  origin: string;
  /** Hostname, e.g. "example.com". */
  host: string;
  /** Page title, if available. */
  title?: string;
  /** Favicon URL, if available. */
  icon?: string;
}

/** Request sent from the page to the background script. */
export interface NostrRpcRequest {
  scope: typeof MESSAGE_SCOPE;
  id: string;
  kind: 'request';
  method: NostrRpcMethod;
  params: unknown;
  origin: OriginInfo;
  /**
   * `navigator.userActivation.isActive` captured at the start of
   * the call — the Web Platform's transient activation, true for
   * ~5 seconds after any trusted user gesture, even across `await`
   * boundaries.
   *
   * Used by the background for two gates:
   *  - The first connect prompt for an origin: a page that has
   *    never been connected must reach the signer as a result of
   *    user interaction so it can't pop a prompt unprompted.
   *  - Re-opening a prompt the user has already dismissed for this
   *    tab: without recent user activation, the dismissed prompt
   *    stays dismissed until the page reloads.
   *
   * Captured in the inpage script before any `postMessage` hop
   * because activation state cannot be reconstructed across the
   * messaging boundary.
   */
  userActivated: boolean;
}

/** Response sent back to the page. */
export interface NostrRpcResponse {
  scope: typeof MESSAGE_SCOPE;
  id: string;
  kind: 'response';
  result?: unknown;
  error?: string;
}

/** Events pushed from the extension to the page (no response expected). */
export interface NostrEventPush {
  scope: typeof MESSAGE_SCOPE;
  kind: 'event';
  event: 'accountChanged';
}

export type PageMessage = NostrRpcRequest | NostrRpcResponse | NostrEventPush;

/**
 * Internal messages (prompt window <-> background).
 *
 *  - `allow-once`: resolve the matched item(s) for this call only; no
 *    persistence.
 *  - `allow-always`: resolve and persist `'allow'`. For `signEvent`
 *    items the persisted scope depends on whether the prompt also
 *    supplied a `kind` — see the `kind` field on `resolve-prompt-group`.
 *  - `allow-always-any`: `signEvent`-only. Resolve and persist
 *    `'allow'` against `signEvent.default`, granting every kind. Use
 *    sparingly — this is the legacy "trust everything" behavior. Not
 *    surfaced in the current prompt UI but kept for protocol
 *    compatibility with older flows and for the popup's manual
 *    grant path.
 *  - `deny`: reject the matched item(s); no persistence.
 *  - `deny-always`: reject and persist `'deny'`. Mirrors
 *    `allow-always` — for `signEvent` the rule is scoped to the
 *    prompted kind when one was supplied, otherwise to
 *    `signEvent.default`; for every other method the rule is written
 *    to `methods[method]`.
 */
export type PromptAction =
  | 'allow-once'
  | 'allow-always'
  | 'allow-always-any'
  | 'deny'
  | 'deny-always';

/**
 * Per-item action — narrower than {@link PromptAction} because deciding
 * about a single pending call from a multi-item batch can't sensibly
 * write a persistent rule. The user is choosing "this specific event /
 * this specific decryption yes/no", not "every event of this kind" or
 * "every decryption from this site" — for the lasting-rule decisions
 * they use the group-level controls.
 */
export type ItemAction = 'allow-once' | 'deny';

/**
 * Action taken on a connect-style prompt — the very first time a site
 * asks for any signer method.
 *
 *  - `connect` grants `getPublicKey` and `getRelays` forever (the two
 *    low-risk reads every Nostr app makes on load) and lets any other
 *    queued items proceed through the normal approval flow.
 *  - `block` records a site-wide deny and immediately rejects every queued
 *    item; subsequent calls reject without ever showing a prompt.
 *  - `cancel` rejects every queued item once and suppresses further prompts
 *    for the originating tab until it navigates or closes.
 */
export type ConnectAction = 'connect' | 'block' | 'cancel';

/** A single pending RPC call awaiting user approval. */
export interface PendingPromptItem {
  /** Stable id for this individual pending call. */
  id: string;
  /** Method being requested. */
  method: NostrRpcMethod;
  /** Already-JSON-serialized preview of the params, for display. */
  params: unknown;
  /** When the request was received (ms epoch). */
  createdAt: number;
}

/**
 * A group of pending items sharing the same (origin, method[, kind]).
 *
 * For `signEvent`, items are sub-grouped by `event.kind` so the prompt
 * can show one card per kind with its own approval buttons — allowing
 * "Always allow kind 1" without granting kind 5 at the same time. For
 * every other method, `kind` is undefined and there is exactly one
 * group per method.
 */
export interface PendingPromptGroup {
  /** Origin info (same for every item in this batch — the window is per-tab). */
  origin: OriginInfo;
  /** Method all items in this group share. */
  method: NostrRpcMethod;
  /**
   * Event kind shared by every item in this group, when `method` is
   * `signEvent`. `undefined` for other methods, and for `signEvent`
   * items whose params don't carry a numeric `event.kind` (those are
   * collapsed into a single fallback group).
   */
  kind?: number;
  /** The individual pending calls. */
  items: PendingPromptItem[];
}

/**
 * The full payload the prompt window renders.
 *
 * There are two kinds of prompts:
 *  - `'connect'` — the very first signer interaction with a site. The UI
 *    only offers two choices: Connect (allow getPublicKey + getRelays
 *    forever and proceed) or Block Site (persist a site-wide deny).
 *    Pending queued items are not shown; if the user connects, they fall
 *    through to the normal approval flow in a subsequent prompt window.
 *  - `'approve'` — the standard per-method approval prompt for a site
 *    that has already been connected.
 */
export interface PromptBatch {
  /** Stable id for the batch (one per tab/prompt window). */
  batchId: string;
  /** Discriminates between the connect prompt and the approval prompt. */
  kind: 'connect' | 'approve';
  /** Origin the batch belongs to (all items share one origin). */
  origin: OriginInfo;
  /** Pubkey currently logged in; helps preview signed events. */
  pubkey?: string;
  /**
   * Groups of pending items, keyed by method. Always populated for
   * `kind === 'approve'`. For `kind === 'connect'` this is the queue of
   * pending items the page has issued in the background — the connect UI
   * does not render them but they exist so they can be processed once
   * the user connects.
   */
  groups: PendingPromptGroup[];
}

/** Push from background -> prompt window when the batch changes. */
export interface PromptBatchUpdate {
  kind: 'prompt-batch-updated';
  batchId: string;
  batch: PromptBatch | null;
}

/** Messages exchanged internally via chrome.runtime. */
export type InternalMessage =
  | { kind: 'get-pending-batch'; batchId: string }
  | {
      kind: 'resolve-prompt-group';
      batchId: string;
      /** The method whose group is being resolved. */
      method: NostrRpcMethod;
      /**
       * For `signEvent`, scope the resolution to a single kind sub-
       * group. `undefined` matches every item in the method (used when
       * the user clicks the all-kinds escape hatch). Ignored for other
       * methods.
       */
      eventKind?: number;
      action: PromptAction;
    }
  | {
      /**
       * Resolve a single pending item by its id. Used by the
       * per-item Allow / Deny controls inside event preview cards
       * (`signEvent`) and decryption preview cards (`nip04.decrypt` /
       * `nip44.decrypt`) — lets the user pick "yes to this specific
       * call, no to that one" without persisting a rule.
       *
       * Persistent decisions (allow-always for a kind etc.) still go
       * through `resolve-prompt-group`; per-item resolutions are
       * intentionally one-shot only.
       */
      kind: 'resolve-prompt-item';
      batchId: string;
      itemId: string;
      action: ItemAction;
    }
  | { kind: 'resolve-prompt-all'; batchId: string; action: PromptAction }
  | { kind: 'resolve-connect'; batchId: string; action: ConnectAction }
  | {
      /**
       * Sent from the prompt window so the user can see what a page is
       * asking to read before deciding whether to allow it. The
       * background performs the decryption with the active signer and
       * returns the plaintext to the prompt UI only — the page does not
       * receive the plaintext unless the user subsequently approves the
       * pending RPC.
       *
       * Restricted to the two decrypt methods; any other method is
       * rejected. Scoped to a pending item id so the background can
       * verify the prompt is asking about a real queued call (and not,
       * say, an arbitrary ciphertext supplied out of band).
       */
      kind: 'decrypt-preview';
      batchId: string;
      itemId: string;
    }
  | { kind: 'signer-rpc'; method: NostrRpcMethod; params: unknown; origin: OriginInfo; userActivated: boolean }
  | {
      /**
       * Direct PSBT signing path used by the extension's own UI
       * (popup / wallet page) for `bunker` logins. The background
       * already holds the NIP-46 relay connection, so the popup
       * forwards the PSBT here instead of opening its own. This path
       * intentionally skips the prompt + permission flow: the user is
       * already inside the extension UI, having explicitly clicked
       * Send. External pages must still go through `signer-rpc`.
       */
      kind: 'internal-sign-psbt';
      psbtHex: string;
    }
  | {
      /**
       * Sent by the popup after the user posts a NIP-22 comment so the
       * background drops its cached count and re-queries on the next
       * badge refresh. Payload is the canonical URL string the comment
       * targets.
       */
      kind: 'comment-posted';
      canonicalUrl: string;
    }
  | {
      /**
       * Sent from the popup when the user clicks the cog or the
       * balance pill. The background does the tabs.query / windows.update
       * / tabs.update dance because the popup tears down as soon as it
       * loses focus, which can abort the async chain mid-flight. The
       * service worker has stable lifetime for the duration of the
       * call.
       *
       * `route` is the HashRouter path inside `src/options.html`
       * ('/' for the settings view, '/wallet' for the wallet view).
       */
      kind: 'open-options-tab';
      route: '/' | '/wallet';
    }
  | {
      /**
       * Sent from the background to the content script (via
       * `chrome.tabs.sendMessage`) when the user clicks the
       * "Highlight on Nostr" context menu entry. The content script
       * reads the live `window.getSelection()`, walks up to the
       * enclosing paragraph-ish block for the `context` field, scrapes
       * `<link rel~="me" href="nostr:…">` tags for `p` attributions,
       * and sends the payload back as the sendResponse value.
       *
       * `fallbackSelection` is `info.selectionText` from
       * `contextMenus.onClicked` — used when the live selection has
       * been cleared by a page handler between the right-click and
       * our message arriving.
       */
      kind: 'collect-highlight';
      fallbackSelection: string;
    }
  | {
      /**
       * Composer window asks for its draft on mount.
       */
      kind: 'get-highlight-draft';
      draftId: string;
    }
  | {
      /**
       * Composer window tells the background it is done with the
       * draft (after submit or on cancel). The background removes the
       * entry from its in-memory map.
       */
      kind: 'discard-highlight-draft';
      draftId: string;
    }
  | {
      /**
       * Sent from the background to the content script when the user
       * picks "Save as nsite". The content script serializes the live
       * post-JavaScript DOM (see `archiveCapture.ts`) and returns it as
       * the sendResponse value. Subresources are deliberately not
       * fetched here — see `pipeline.ts`.
       */
      kind: 'collect-archive';
    }
  | {
      /**
       * Sent from the popup when the user clicks "Save as nsite". The
       * background owns the capture-then-open-window sequence for the
       * same reason it owns `open-options-tab`: the popup is torn down
       * the moment it loses focus, which would abort the chain.
       */
      kind: 'open-archive';
      tabId?: number;
    }
  | {
      /** Archive window asks for its captured page on mount. */
      kind: 'get-archive-draft';
      draftId: string;
    }
  | {
      /**
       * Archive window is done with the draft (published or cancelled).
       * Captured HTML can be large and can contain logged-in content,
       * so it's dropped as soon as it isn't needed.
       */
      kind: 'discard-archive-draft';
      draftId: string;
    }
  | PromptBatchUpdate;

/**
 * Payload returned by the content script in response to
 * `collect-archive`.
 */
export interface ArchiveCollection {
  /** Serialized, script-free DOM. Becomes `/index.html`. */
  html: string;
  /** The URL actually being viewed — the base for relative references. */
  pageUrl: string;
  /** `<link rel="canonical">` if the page declares one, else `pageUrl`. */
  canonicalUrl: string;
  /** Document title, used for the manifest's `title` tag. */
  pageTitle?: string;
  /** Favicon URL, for UI display only. */
  pageIcon?: string;
  /** Capture time in seconds since epoch. */
  capturedAt: number;
  /** What sanitization removed, surfaced in the review step. */
  stats: {
    scripts: number;
    frames: number;
    handlers: number;
    canvases: number;
  };
}

/**
 * Background-side archive draft. Held in service-worker memory only —
 * see `archiveDraft.ts` for why it isn't persisted.
 */
export interface ArchiveDraft extends ArchiveCollection {
  /** ms epoch — used to garbage-collect stale drafts. */
  createdAt: number;
}

/**
 * Payload returned by the content script in response to a
 * `collect-highlight` message. Lives in `messages.ts` so the background
 * and the composer share the same type.
 */
export interface HighlightCollection {
  /** Whitespace-normalized selection text (the future `event.content`). */
  selectionText: string;
  /**
   * Whitespace-normalized text of the enclosing paragraph-ish block,
   * iff it strictly contains `selectionText` and is meaningfully
   * longer. `null` when no usable context could be derived.
   */
  contextText: string | null;
  /**
   * Source URL. Read from `<link rel="canonical">` when present,
   * otherwise `location.href`. The background re-canonicalizes this
   * via `canonicalizePageUrl` to strip tracking params.
   */
  pageUrl: string;
  /** Document title for UI display only. */
  pageTitle?: string;
  /** Favicon URL for UI display only. */
  pageIcon?: string;
  /**
   * Raw `href` values of every `<link rel~="me" href="nostr:…">` tag
   * found in the document head. Decoding (npub/nprofile → hex pubkey)
   * is performed in the background to keep the content bundle small.
   */
  meNostrHrefs: string[];
}

/**
 * Background-side draft record. Created by the context-menu handler
 * after the content script's payload has been validated, the page URL
 * has been canonicalized, and the raw `nostr:…` hrefs have been
 * decoded into hex pubkeys. Looked up by `draftId` from the composer.
 */
export interface HighlightDraft {
  /** Whitespace-normalized selection text. */
  selectionText: string;
  /** Surrounding paragraph (validated to contain `selectionText`) or null. */
  contextText: string | null;
  /** Canonicalized source URL (tracking params stripped). */
  pageUrl: string;
  /** Document title for UI display only. */
  pageTitle?: string;
  /** Favicon URL for UI display only. */
  pageIcon?: string;
  /**
   * Decoded hex pubkeys ready for `p` tags. Deduplicated. Invalid /
   * non-npub-or-nprofile `nostr:` URIs are dropped during decoding.
   */
  pAuthors: string[];
  /** ms epoch — used to garbage-collect stale drafts. */
  createdAt: number;
}
