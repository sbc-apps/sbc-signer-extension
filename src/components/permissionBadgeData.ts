/**
 * Data helpers for {@link PermissionBadges}, extracted into their own
 * file so the component module can stay component-only (required by the
 * `react-refresh/only-export-components` lint rule).
 *
 * Two consumers:
 *  - `PermissionBadges` itself, which calls `collectBadges` to render
 *    one badge per saved rule.
 *  - `SitePermissionsList`, which calls `hasPermissionBadges` to decide
 *    whether to render the badge row at all.
 */
import { kindLabel } from '@/lib/eventKinds';
import type { NostrRpcMethod } from '@/extension/messages';
import type { OriginPermissions, PermissionLevel } from '@/extension/permissions';

/**
 * Short labels used in the badges. Kept distinct from the longer
 * `METHOD_LABELS` in `SitePermissionsList` so the badges stay compact
 * — "Sign" reads well in a tag row, "Sign events" doesn't.
 *
 * `getPublicKey` / `getRelays` are intentionally absent: they are
 * implicit for every connected origin and never surface here.
 *
 * `signPsbt` is also absent: it's a per-call-only method (no
 * `allow-always` / `deny-always`), so no rule for it is ever persisted
 * and it has nothing to surface as a badge.
 */
const METHOD_BADGE_LABELS: Partial<Record<NostrRpcMethod, string>> = {
  signEvent: 'Sign',
  'nip04.encrypt': 'NIP-04 encrypt',
  'nip04.decrypt': 'NIP-04 decrypt',
  'nip44.encrypt': 'NIP-44 encrypt',
  'nip44.decrypt': 'NIP-44 decrypt',
};

/** What the X button clears, encoded so the click handler can dispatch. */
export type BadgeRule =
  | { kind: 'site-wide' }
  | { kind: 'method'; method: NostrRpcMethod }
  | { kind: 'sign-default' }
  | { kind: 'sign-kind'; eventKind: number };

export interface BadgeEntry {
  key: string;
  label: string;
  level: PermissionLevel;
  /** Site-wide block — gets a lock icon to distinguish from per-method denies. */
  siteWide?: boolean;
  rule: BadgeRule;
}

/**
 * Walk an origin's saved policy and produce one {@link BadgeEntry} per
 * rule. Order: site-wide wildcard first, then per-method rules
 * (excluding signEvent which is rendered via its own policy), then
 * signEvent.default, then per-kind signEvent rules sorted ascending.
 */
export function collectBadges(data: OriginPermissions): BadgeEntry[] {
  const out: BadgeEntry[] = [];

  // Site-wide wildcard. Only `deny` is meaningful here — there is no UI
  // path that writes `'*' === 'allow'`, but we guard for completeness.
  const wildcard = data.methods['*'];
  if (wildcard) {
    out.push({
      key: 'site-wide',
      label: wildcard === 'deny' ? 'Site blocked' : 'Site allowed',
      level: wildcard,
      siteWide: true,
      rule: { kind: 'site-wide' },
    });
  }

  // Per-method rules other than signEvent, which has its own kind-aware
  // policy below. `getPublicKey` / `getRelays` are stripped from
  // `data.methods` by `loadAll`, so they can't appear here.
  for (const [method, level] of Object.entries(data.methods) as [
    NostrRpcMethod | '*',
    PermissionLevel,
  ][]) {
    if (method === '*') continue;
    if (method === 'signEvent') continue; // covered by signEvent.default below
    out.push({
      key: `m:${method}`,
      label: METHOD_BADGE_LABELS[method as NostrRpcMethod] ?? method,
      level,
      rule: { kind: 'method', method: method as NostrRpcMethod },
    });
  }

  // signEvent.default — the catch-all "any kind" rule.
  if (data.signEvent?.default) {
    out.push({
      key: 'sign:*',
      label: 'Any event',
      level: data.signEvent.default,
      rule: { kind: 'sign-default' },
    });
  }

  // Per-kind signEvent rules, sorted by kind for stable ordering.
  if (data.signEvent?.kinds) {
    const kinds = Object.entries(data.signEvent.kinds)
      .map(([k, v]) => [Number(k), v] as [number, PermissionLevel])
      .filter(([k]) => Number.isFinite(k))
      .sort(([a], [b]) => a - b);
    for (const [kind, level] of kinds) {
      out.push({
        key: `sign:${kind}`,
        label: kindLabel(kind),
        level,
        rule: { kind: 'sign-kind', eventKind: kind },
      });
    }
  }

  return out;
}

/**
 * Whether the origin has any rule at all that would render a badge.
 * Lets callers decide whether to show a wrapping section header /
 * separator without first computing the badge list themselves.
 */
export function hasPermissionBadges(data: OriginPermissions): boolean {
  return collectBadges(data).length > 0;
}
