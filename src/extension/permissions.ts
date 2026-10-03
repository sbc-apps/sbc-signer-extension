/**
 * Per-account, per-origin permissions for NIP-07 methods.
 *
 * Permissions are scoped first by `pubkey` (the logged-in account that
 * approved the rule) and then by `origin` + `method`. Different
 * accounts have independent connected-site lists: granting `nostrudel`
 * permission to sign while logged into Account A does NOT grant it to
 * Account B; the user must approve the connection again the first time
 * they use that account on that site.
 *
 * Storage shape (single key, `STORAGE_KEYS.permissions`):
 *
 *   ```
 *   Record<pubkey, PermissionsMap>
 *   //         where PermissionsMap = Record<origin, OriginPermissions>
 *   ```
 *
 * When a page calls a method, the background script:
 *  1. Looks up the active pubkey via {@link signer.getActivePubkey}.
 *  2. Loads the bucket for that pubkey, then checks `origin` + `method`:
 *     - If `allow`, the call proceeds without a prompt.
 *     - If `deny` (set via explicit "deny and remember" in popup), the
 *       call rejects immediately.
 *     - Otherwise, a prompt window opens and the user's decision either
 *       allows the call this once, or persists as `allow`/`deny`.
 *
 * Implicit permissions for connected origins:
 *  `getPublicKey` and `getRelays` are NOT stored as granular rules.
 *  Every Nostr app reads them on load as a sanity check, and forcing
 *  the user to manage them per-site adds noise without giving them a
 *  meaningful choice. Instead, an origin is "connected" when an entry
 *  exists for it (within the active account's bucket) and the
 *  site-wide `'*'` deny is not set; connected origins implicitly allow
 *  both reads. This is enforced inside {@link getPermission}, and the
 *  `loadAll` step strips any legacy `methods.getPublicKey` /
 *  `methods.getRelays` entries that older builds may have written so
 *  they don't surface as user-visible badges.
 *
 * `signEvent` has an additional dimension: event kind. Allowing a site
 * to sign kind 1 notes does NOT grant it permission to sign kind 5
 * deletions or kind 3 follow-list rewrites. Per-kind rules live on
 * {@link OriginPermissions.signEvent.kinds}; the catch-all "allow any
 * kind" decision lives on {@link OriginPermissions.signEvent.default}.
 * The lookup precedence in {@link getPermission} is:
 *   1. per-kind rule  → `signEvent.kinds[kind]`
 *   2. signEvent default → `signEvent.default`
 *   3. site-wide  → `methods['*']`
 *
 * Other methods (`nip04.*`, `nip44.*`) continue to use the simpler
 * `methods[method]` map.
 *
 * Migration: builds prior to per-account scoping wrote a flat
 * `Record<origin, OriginPermissions>` at the same key. We deliberately
 * discard that legacy data on first read — every origin has to
 * re-approve under the active account, which is the safer default
 * because we can't know which account the legacy rules were granted
 * under. See {@link loadStore}.
 */
import type { NostrRpcMethod } from './messages';
import { extStorage, STORAGE_KEYS } from './storage';

export type PermissionLevel = 'allow' | 'deny';

/**
 * Methods every connected origin gets implicitly. They are never
 * written to `OriginPermissions.methods` and are never surfaced as
 * removable badges; the user manages them via the connect/disconnect
 * lifecycle of the whole origin.
 */
const IMPLICIT_METHODS: ReadonlySet<NostrRpcMethod> = new Set<NostrRpcMethod>([
  'getPublicKey',
  'getRelays',
]);

/**
 * Per-kind `signEvent` policy. Either field may be omitted, in which
 * case the corresponding lookup level falls through to the next.
 */
export interface SignEventPolicy {
  /**
   * Catch-all level applied when no per-kind rule matches. `'allow'`
   * means "allow signEvent for any kind" — the legacy behavior. Most
   * sites won't have this set; per-kind rules are the default UX.
   */
  default?: PermissionLevel;
  /** Per-kind allow/deny rules. Wins over `default`. */
  kinds?: Record<number, PermissionLevel>;
}

export interface OriginPermissions {
  /**
   * Per-method permission for everything other than `signEvent`. The
   * special method key `'*'` applies to any method not explicitly set
   * (currently only used for the site-wide block from the connect
   * prompt; see {@link setSiteBlocked}).
   *
   * `getPublicKey` and `getRelays` are NEVER persisted here. They are
   * implicit for every connected origin (see the file header). Any
   * legacy entry written by an older build is stripped on read by
   * `loadAll`.
   *
   * `signEvent` may also appear here for backwards-compatibility with
   * permissions written by older extension builds — when present, it
   * is treated as `signEvent.default` during lookup. New writes route
   * through {@link signEvent} and never touch `methods.signEvent`.
   */
  methods: Partial<Record<NostrRpcMethod | '*', PermissionLevel>>;
  /** Per-kind `signEvent` policy. */
  signEvent?: SignEventPolicy;
  /** Last time this origin interacted with the extension (ms epoch). */
  lastSeen: number;
  /** Display title for the origin, captured from the tab. */
  title?: string;
  /** Favicon URL from the tab. */
  icon?: string;
}

/** Origin → policy. Always scoped to a single account. */
export type PermissionsMap = Record<string, OriginPermissions>;

/** Pubkey → that account's connected-sites map. */
type PermissionsStore = Record<string, PermissionsMap>;

/**
 * Detect the legacy non-account-scoped shape. Pre-migration, the
 * top-level keys were origins (URLs starting with `http`); post-
 * migration, the top-level keys are 64-character hex pubkeys whose
 * values are nested `PermissionsMap`s. We check the first entry: if
 * its value looks like an `OriginPermissions` (has `methods`/`lastSeen`
 * directly), we're looking at the old shape.
 */
function isLegacyFlatShape(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return false;
  const [, firstValue] = entries[0];
  if (!firstValue || typeof firstValue !== 'object') return false;
  // Old shape: value has `methods` and/or `lastSeen` at the top level.
  // New shape: value is itself a map of origin → OriginPermissions, so
  // its values (one level deeper) have `methods`/`lastSeen`, but the
  // value itself does not.
  return 'methods' in firstValue || 'lastSeen' in firstValue;
}

async function loadStore(): Promise<PermissionsStore> {
  const raw = await extStorage.get<unknown>(STORAGE_KEYS.permissions, {});

  // First-run migration: the legacy build stored a flat origin map at
  // this key with no account scoping. We can't reattribute those rules
  // to a specific account safely (they may have been granted while the
  // user was logged into a different identity), so we drop them and
  // start fresh under the per-account schema. Persisted immediately so
  // every subsequent read sees the new shape.
  if (isLegacyFlatShape(raw)) {
    const empty: PermissionsStore = {};
    await extStorage.set(STORAGE_KEYS.permissions, empty);
    return empty;
  }

  return (raw && typeof raw === 'object' ? (raw as PermissionsStore) : {}) as PermissionsStore;
}

/**
 * Load the connected-sites map for a single account, with implicit-
 * method legacy entries stripped (see file header).
 */
async function loadForPubkey(pubkey: string): Promise<PermissionsMap> {
  const store = await loadStore();
  const map = store[pubkey] ?? {};
  // Strip legacy `getPublicKey` / `getRelays` rules written by older
  // builds. They are no longer granular permissions: every connected
  // origin gets them implicitly, and surfacing stale entries as badges
  // would confuse the user. We don't write the cleaned map back here —
  // the next `setPermission` / `revokePermission` / `touchOrigin` call
  // will persist a clean copy. Reading is the hot path, writing is not.
  const cleaned: PermissionsMap = {};
  for (const [origin, entry] of Object.entries(map)) {
    let methods = entry.methods;
    for (const method of IMPLICIT_METHODS) {
      if (method in methods) {
        // Lazy-clone per origin so we don't mutate the storage object
        // returned by `extStorage.get`.
        if (methods === entry.methods) methods = { ...methods };
        delete methods[method];
      }
    }
    cleaned[origin] = methods === entry.methods ? entry : { ...entry, methods };
  }
  return cleaned;
}

async function saveForPubkey(pubkey: string, map: PermissionsMap): Promise<void> {
  const store = await loadStore();
  if (Object.keys(map).length === 0) {
    delete store[pubkey];
  } else {
    store[pubkey] = map;
  }
  await extStorage.set(STORAGE_KEYS.permissions, store);
}

/**
 * Look up the stored permission level for a specific (pubkey, origin,
 * method[, kind]) tuple. Returns `null` when no decision has been
 * recorded.
 *
 * Implicit reads (`getPublicKey`, `getRelays`):
 *  - If the origin is blocked site-wide (`'*' === 'deny'`), returns
 *    `'deny'` so the call rejects without a prompt.
 *  - If an entry exists for the origin (which only happens after the
 *    user has been through the connect prompt — `touchOrigin` is never
 *    called on a stranger), returns `'allow'`.
 *  - Otherwise returns `null` so the caller routes to the connect
 *    prompt. Listed methods that aren't connected fall through to the
 *    same connect flow as any other first-time method.
 *
 * `kind` is only consulted for `method === 'signEvent'`. When omitted
 * (or for any other method), the lookup falls back to the legacy
 * single-axis rule. The site-wide `'*'` deny is honored last for every
 * method, including `signEvent`.
 */
export async function getPermission(
  pubkey: string,
  origin: string,
  method: NostrRpcMethod,
  kind?: number,
): Promise<PermissionLevel | null> {
  const map = await loadForPubkey(pubkey);
  const entry = map[origin];
  if (!entry) return null;

  // Site-wide block always wins, regardless of method.
  if (entry.methods['*'] === 'deny') return 'deny';

  if (IMPLICIT_METHODS.has(method)) {
    // Entry exists and not blocked → connected → implicit allow.
    return 'allow';
  }

  if (method === 'signEvent') {
    const policy = entry.signEvent;
    if (typeof kind === 'number' && policy?.kinds) {
      const perKind = policy.kinds[kind];
      if (perKind) return perKind;
    }
    if (policy?.default) return policy.default;
    // Legacy rule written by older builds — treated as "any kind".
    const legacy = entry.methods.signEvent;
    if (legacy) return legacy;
    return null;
  }

  return entry.methods[method] ?? null;
}

/**
 * Record a permission decision for a (pubkey, origin, method[, kind])
 * tuple.
 *
 * For `getPublicKey` / `getRelays`:
 *  - These are no longer granular permissions. The function silently
 *    becomes a {@link touchOrigin}: it ensures the origin entry exists
 *    (so the implicit "connected → allow" rule kicks in) and updates
 *    the metadata, but writes no `methods` entry. Callers that used to
 *    pass `'allow'` for these methods now do nothing extra; callers
 *    that pass `'deny'` for them are no-ops too — to deny these reads
 *    you must site-block the origin.
 *
 * For `signEvent`:
 *  - When `kind` is provided, the rule is written to
 *    `signEvent.kinds[kind]` — ONLY that kind is affected.
 *  - When `kind` is omitted, the rule is written to `signEvent.default`
 *    — every kind without its own per-kind override is affected.
 *
 * For every other method, `kind` is ignored and the rule is written to
 * `methods[method]` as before.
 */
export async function setPermission(
  pubkey: string,
  origin: string,
  method: NostrRpcMethod | '*',
  level: PermissionLevel,
  meta?: { title?: string; icon?: string; kind?: number },
): Promise<void> {
  const map = await loadForPubkey(pubkey);
  const entry: OriginPermissions = map[origin] ?? { methods: {}, lastSeen: Date.now() };

  if (method !== '*' && IMPLICIT_METHODS.has(method)) {
    // Bare touch: make sure the origin entry exists with fresh metadata.
    // No `methods` write — these methods are implicitly granted to every
    // connected origin.
    entry.lastSeen = Date.now();
    if (meta?.title) entry.title = meta.title;
    if (meta?.icon) entry.icon = meta.icon;
    map[origin] = entry;
    await saveForPubkey(pubkey, map);
    return;
  }

  if (method === 'signEvent') {
    const policy: SignEventPolicy = { ...(entry.signEvent ?? {}) };
    if (typeof meta?.kind === 'number') {
      const kinds = { ...(policy.kinds ?? {}) };
      kinds[meta.kind] = level;
      policy.kinds = kinds;
    } else {
      policy.default = level;
    }
    entry.signEvent = policy;
    // Drop any legacy `methods.signEvent` so it doesn't shadow the new
    // policy on a future read.
    if ('signEvent' in entry.methods) {
      delete entry.methods.signEvent;
    }
  } else {
    entry.methods[method] = level;
  }

  entry.lastSeen = Date.now();
  if (meta?.title) entry.title = meta.title;
  if (meta?.icon) entry.icon = meta.icon;
  map[origin] = entry;
  await saveForPubkey(pubkey, map);
}

/** Update the `lastSeen`/metadata for an origin without changing policy. */
export async function touchOrigin(
  pubkey: string,
  origin: string,
  meta?: { title?: string; icon?: string },
): Promise<void> {
  const map = await loadForPubkey(pubkey);
  const entry: OriginPermissions = map[origin] ?? { methods: {}, lastSeen: Date.now() };
  entry.lastSeen = Date.now();
  if (meta?.title) entry.title = meta.title;
  if (meta?.icon) entry.icon = meta.icon;
  map[origin] = entry;
  await saveForPubkey(pubkey, map);
}

/** Remove all stored permissions for an origin under a single account. */
export async function revokeOrigin(pubkey: string, origin: string): Promise<void> {
  const map = await loadForPubkey(pubkey);
  delete map[origin];
  await saveForPubkey(pubkey, map);
}

/**
 * Remove one (origin, method[, kind]) decision under a single account.
 * The origin entry itself is preserved (with `lastSeen` and any cached
 * title/icon) so it remains listed in the popup/options view; the user
 * has still interacted with the site, just without any active rule. To
 * remove the origin entirely, call {@link revokeOrigin}.
 *
 * For `signEvent`:
 *  - When `kind` is provided, only the per-kind rule for that kind is
 *    removed; `signEvent.default` is left in place.
 *  - When `kind` is omitted, the entire `signEvent` policy is cleared
 *    (default + every per-kind rule). Use {@link revokeSignEventKind}
 *    for a single kind without writing it out at every call site.
 */
export async function revokePermission(
  pubkey: string,
  origin: string,
  method: NostrRpcMethod,
  kind?: number,
): Promise<void> {
  const map = await loadForPubkey(pubkey);
  const entry = map[origin];
  if (!entry) return;
  if (method === 'signEvent') {
    if (typeof kind === 'number') {
      if (entry.signEvent?.kinds) {
        const kinds = { ...entry.signEvent.kinds };
        delete kinds[kind];
        entry.signEvent = { ...entry.signEvent, kinds };
      }
    } else {
      delete entry.signEvent;
      // Also clear the legacy single-axis rule if any older build wrote one.
      delete entry.methods.signEvent;
    }
  } else {
    delete entry.methods[method];
  }
  await saveForPubkey(pubkey, map);
}

/** Get the full permissions map for a single account (for the popup UI). */
export async function getAllPermissions(pubkey: string): Promise<PermissionsMap> {
  return loadForPubkey(pubkey);
}

/**
 * Whether the user has explicitly "connected" the origin under this
 * account. A connected origin is any origin with a saved entry whose
 * site-wide `'*'` rule is not `deny`. The connect prompt creates the
 * entry, the popup's "Remove" button deletes it, and the site-block
 * control sets `'*'` to `deny` — so this predicate captures the "user
 * has trusted this site under this account and hasn't revoked it"
 * state directly.
 *
 * Connected origins implicitly grant `getPublicKey` and `getRelays`;
 * see {@link getPermission}.
 */
export async function isOriginConnected(pubkey: string, origin: string): Promise<boolean> {
  const map = await loadForPubkey(pubkey);
  const entry = map[origin];
  if (!entry) return false;
  return entry.methods['*'] !== 'deny';
}

/**
 * Whether the origin is blocked site-wide for this account. Equivalent
 * to checking the wildcard `'*'` method for `deny`. Independent from
 * per-method denies, which only block one specific RPC method.
 */
export async function isSiteBlocked(pubkey: string, origin: string): Promise<boolean> {
  const map = await loadForPubkey(pubkey);
  return map[origin]?.methods['*'] === 'deny';
}

/**
 * Persist a site-wide deny via the `'*'` wildcard method. Once set, every
 * NIP-07 method rejects immediately without showing a prompt (see
 * `getPermission` and the `'*'` fallback).
 */
export async function setSiteBlocked(
  pubkey: string,
  origin: string,
  meta?: { title?: string; icon?: string },
): Promise<void> {
  await setPermission(pubkey, origin, '*', 'deny', meta);
}
