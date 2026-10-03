/**
 * Compact, color-coded summary of every saved allow/deny rule for a
 * single origin. Green badges mean the rule is `allow`, red badges mean
 * `deny`. Each badge has an X button that clears that specific rule.
 * The sequence shows, at a glance, every choice the user has recorded
 * for the site without expanding into rows.
 *
 * Used in two places:
 *  - The popup header, beneath the site title, to remind the user what
 *    they've granted to the active tab.
 *  - The options page, inside each origin's card, as the compact view
 *    above the per-rule controls.
 *
 * Rules surfaced:
 *  - The site-wide `'*'` wildcard (deny only — set when the user blocks
 *    a site outright).
 *  - Every `methods[*]` entry. `getPublicKey` / `getRelays` are no
 *    longer granular permissions — they're implicitly granted to every
 *    connected origin and `loadAll` strips any legacy entries on read,
 *    so they never appear in this list.
 *  - `signEvent.default` (the "any kind" rule) and every per-kind rule
 *    in `signEvent.kinds`, each labeled with the friendly kind name.
 *
 * Renders nothing when there's nothing to summarize; callers can
 * conditionally include it without a wrapping check.
 */
import { Lock, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  collectBadges,
  type BadgeEntry,
  type BadgeRule,
} from '@/components/permissionBadgeData';
import {
  getAllPermissions,
  revokeOrigin,
  revokePermission,
  setPermission,
  type OriginPermissions,
} from '@/extension/permissions';

interface PermissionBadgesProps {
  /**
   * Pubkey of the account these rules belong to. All revoke / rewrite
   * operations triggered from a badge's X button are scoped to this
   * pubkey, so badges for one account never mutate another account's
   * connected sites.
   */
  pubkey: string;
  origin: string;
  data: OriginPermissions;
  className?: string;
  /** Optional extra class applied to every badge (e.g. for size tweaks). */
  badgeClassName?: string;
}

/**
 * Apply a badge's "remove" action to the permissions store. Site-wide
 * blocks are removed by clearing the whole entry — there's no
 * meaningful "SBC Signer Extension knows about you but with no rules" state
 * for a blocked site, and clearing only the `'*'` wildcard would
 * leave a stale `lastSeen` entry implying activity that didn't happen.
 * For everything else we surgically drop just the one rule via
 * `revokePermission` so the rest of the site's policy is preserved.
 */
async function removeRule(pubkey: string, origin: string, rule: BadgeRule): Promise<void> {
  switch (rule.kind) {
    case 'site-wide':
      await revokeOrigin(pubkey, origin);
      return;
    case 'method':
      await revokePermission(pubkey, origin, rule.method);
      return;
    case 'sign-default':
      // `revokePermission(_, 'signEvent')` with no kind clears the whole
      // signEvent policy — both the default and every per-kind rule.
      // We want to clear only the default here, so write a manual update
      // by re-using the per-kind path with a sentinel: there is no API
      // to clear just the default, so reach into setPermission's
      // counterpart by clearing the whole policy and rewriting kinds.
      await clearSignEventDefault(pubkey, origin);
      return;
    case 'sign-kind':
      await revokePermission(pubkey, origin, 'signEvent', rule.eventKind);
      return;
  }
}

/**
 * Clear `signEvent.default` while preserving any per-kind rules. The
 * `permissions.ts` API doesn't expose this directly, so we round-trip
 * through the public surface: snapshot the current per-kind rules,
 * wipe the whole policy, then rewrite each per-kind rule.
 */
async function clearSignEventDefault(pubkey: string, origin: string): Promise<void> {
  const all = await getAllPermissions(pubkey);
  const entry = all[origin];
  const kinds = entry?.signEvent?.kinds ?? {};
  // Wipes default + kinds.
  await revokePermission(pubkey, origin, 'signEvent');
  // Restore per-kind rules.
  for (const [k, level] of Object.entries(kinds)) {
    const kind = Number(k);
    if (!Number.isFinite(kind)) continue;
    await setPermission(pubkey, origin, 'signEvent', level, { kind });
  }
}

export function PermissionBadges({
  pubkey,
  origin,
  data,
  className,
  badgeClassName,
}: PermissionBadgesProps) {
  const badges = collectBadges(data);
  if (badges.length === 0) return null;

  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {badges.map((b) => (
        <PermissionBadge
          key={b.key}
          entry={b}
          className={badgeClassName}
          onRemove={() => {
            void removeRule(pubkey, origin, b.rule);
          }}
        />
      ))}
    </div>
  );
}

function PermissionBadge({
  entry,
  className,
  onRemove,
}: {
  entry: BadgeEntry;
  className?: string;
  onRemove: () => void;
}) {
  const allowed = entry.level === 'allow';
  return (
    <Badge
      // We want explicit green/red, independent of the theme's primary
      // color. Tailwind's emerald/red 600 reads as a clear stoplight in
      // both light and dark mode and stays accessible on white text.
      className={cn(
        'rounded-md border-transparent text-white pl-2 pr-1 gap-1.5',
        allowed
          ? 'bg-emerald-600 dark:bg-emerald-700'
          : 'bg-red-600 dark:bg-red-700',
        className,
      )}
      title={`${entry.label}: ${allowed ? 'allowed' : 'blocked'}`}
    >
      {entry.siteWide && <Lock aria-hidden className="size-3" />}
      <span>{entry.label}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        aria-label={`Remove ${entry.label}`}
        className={cn(
          'inline-flex items-center justify-center size-4 rounded-sm transition-colors',
          'hover:bg-white/20 focus-visible:bg-white/20 focus-visible:outline-none',
        )}
      >
        <X className="size-3" />
      </button>
    </Badge>
  );
}
