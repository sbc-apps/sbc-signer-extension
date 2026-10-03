/**
 * Inpage script — injects `window.nostr` into every page.
 *
 * This file runs in the page's main world (via the content script). It
 * can't talk to the background service worker directly, so it uses
 * `window.postMessage` to relay requests through the content script,
 * which then calls `chrome.runtime.sendMessage`.
 */
import type {
  NostrRpcMethod,
  NostrRpcRequest,
  PageMessage,
} from './messages';

const MESSAGE_SCOPE = 'sbc-signer-extension' as const;

// Small NIP-07 event shape (mirrors what @nostrify/react expects). We
// purposely don't import from '@nostrify/nostrify' here to keep the
// inpage bundle tiny.
interface UnsignedEvent {
  kind: number;
  content: string;
  tags: string[][];
  created_at?: number;
}
interface SignedEvent extends Required<UnsignedEvent> {
  id: string;
  pubkey: string;
  sig: string;
}

type PendingResolver = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

const pending = new Map<string, PendingResolver>();

function genId(): string {
  // Good enough for request correlation; never leaves this page.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isPageMessage(data: unknown): data is PageMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { scope?: unknown }).scope === MESSAGE_SCOPE
  );
}

function originInfo() {
  const icon =
    (document.querySelector('link[rel~="icon"]') as HTMLLinkElement | null)?.href || undefined;
  return {
    origin: window.location.origin,
    host: window.location.host,
    title: document.title || undefined,
    icon,
  };
}

/**
 * User-activation signal sent with each call.
 *
 * The Web Platform's transient activation
 * (`navigator.userActivation.isActive`) stays true for ~5 seconds
 * after any trusted user gesture. That's far too lax for our use
 * case: a page that calls window.nostr.* on a timer or in an
 * observer can piggy-back on any incidental click during that 5s
 * window and re-pop a prompt the user just dismissed.
 *
 * Instead we keep our own short-lived gesture timestamp and treat
 * the call as "user-activated" only if a trusted gesture happened
 * within the last `USER_ACTIVATION_WINDOW_MS`. The window is much
 * shorter than the browser's so a page can't lazily piggy-back on
 * old clicks, but still long enough to cover the awaits that real
 * apps do between a click handler and the signer call (e.g.
 * clicking "Post" → library validation/upload → signEvent).
 *
 * Captured synchronously at the call site because the timestamp
 * cannot be reconstructed across the postMessage boundary, and the
 * 500ms budget can drain while the message is in flight.
 *
 * This is a UX/anti-annoyance check, not a security boundary —
 * pages can monkey-patch anything in their main world. Real
 * authorization is still enforced by the prompt UI inside the
 * extension.
 */
const USER_ACTIVATION_WINDOW_MS = 500;
const GESTURE_EVENTS = ['click', 'keydown', 'pointerdown', 'touchstart', 'submit'] as const;
let lastGestureAt = 0;
for (const type of GESTURE_EVENTS) {
  window.addEventListener(
    type,
    (event: Event) => {
      // Synthetic events dispatched by page scripts (e.g.
      // `button.dispatchEvent(new MouseEvent('click'))`) have
      // `isTrusted === false` — only count real user input.
      if (!event.isTrusted) return;
      lastGestureAt = Date.now();
    },
    { capture: true, passive: true },
  );
}

function isUserActivated(): boolean {
  return Date.now() - lastGestureAt < USER_ACTIVATION_WINDOW_MS;
}

function call<T>(method: NostrRpcMethod, params: unknown = null): Promise<T> {
  // Capture activation SYNCHRONOUSLY before any awaits or postMessage
  // hops — `userActivation.isActive` is reset by some APIs and the
  // value never survives the messaging boundary regardless.
  const userActivated = isUserActivated();

  return new Promise<T>((resolve, reject) => {
    const id = genId();
    pending.set(id, {
      resolve: (v) => resolve(v as T),
      reject,
    });

    const request: NostrRpcRequest = {
      scope: MESSAGE_SCOPE,
      kind: 'request',
      id,
      method,
      params,
      origin: originInfo(),
      userActivated,
    };

    window.postMessage(request, window.location.origin);
  });
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!isPageMessage(event.data)) return;
  const msg = event.data;

  if (msg.kind === 'response') {
    const resolver = pending.get(msg.id);
    if (!resolver) return;
    pending.delete(msg.id);
    if (msg.error) {
      resolver.reject(new Error(msg.error));
    } else {
      resolver.resolve(msg.result);
    }
    return;
  }

  if (msg.kind === 'event' && msg.event === 'accountChanged') {
    // NIP-07 doesn't specify an eventing model, but pages commonly
    // listen for this signal; dispatch a CustomEvent so apps can
    // react to the account switch.
    window.dispatchEvent(new CustomEvent('nlAuth', { detail: { type: 'accountChanged' } }));
  }
});

const nip04 = {
  encrypt: (pubkey: string, plaintext: string) =>
    call<string>('nip04.encrypt', { pubkey, plaintext }),
  decrypt: (pubkey: string, ciphertext: string) =>
    call<string>('nip04.decrypt', { pubkey, ciphertext }),
};

const nip44 = {
  encrypt: (pubkey: string, plaintext: string) =>
    call<string>('nip44.encrypt', { pubkey, plaintext }),
  decrypt: (pubkey: string, ciphertext: string) =>
    call<string>('nip44.decrypt', { pubkey, ciphertext }),
};

const nostr = {
  async getPublicKey(): Promise<string> {
    return call<string>('getPublicKey');
  },
  async getRelays(): Promise<Record<string, { read: boolean; write: boolean }>> {
    return call<Record<string, { read: boolean; write: boolean }>>('getRelays');
  },
  async signEvent(event: UnsignedEvent): Promise<SignedEvent> {
    return call<SignedEvent>('signEvent', { event });
  },
  /**
   * Sign a hex-encoded PSBT (BIP-174). The signer adds Taproot key-path
   * signatures (`tapKeySig`) to every input whose `tapInternalKey` matches
   * the user's Nostr pubkey, leaves other inputs untouched, and returns
   * the (still-unfinalized) PSBT hex. See `BITCOIN-SIGNING.md`.
   */
  async signPsbt(psbtHex: string): Promise<string> {
    return call<string>('signPsbt', { psbtHex });
  },
  nip04,
  nip44,
};

// Only install if nothing else has already claimed `window.nostr` (e.g.
// another signer extension). Let the first one win to avoid stomping
// the user's existing setup.
if (!('nostr' in window)) {
  Object.defineProperty(window, 'nostr', {
    value: nostr,
    configurable: false,
    writable: false,
  });
}
