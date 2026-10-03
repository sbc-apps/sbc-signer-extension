/**
 * Lists every origin the user has interacted with under the active
 * account, plus the per-method allow/deny state. Used in both the popup
 * (compact mode) and the full options page (expanded with the badge
 * sequence rendered by {@link PermissionBadges}).
 *
 * Permissions are scoped per-account: this list shows only what the
 * currently active pubkey has approved. Switching accounts in the
 * header swaps the list out for the other account's connections.
 */
import { useEffect, useState } from 'react';
import { Globe, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PermissionBadges } from '@/components/PermissionBadges';
import { hasPermissionBadges } from '@/components/permissionBadgeData';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import {
  getAllPermissions,
  revokeOrigin,
  type OriginPermissions,
  type PermissionsMap,
} from '@/extension/permissions';
import type { NostrRpcMethod } from '@/extension/messages';
import { extStorage, STORAGE_KEYS } from '@/extension/storage';

interface SitePermissionsListProps {
  /** Compact rendering for the popup. */
  compact?: boolean;
  /**
   * If set, only render the entry for this origin (or nothing at all if
   * the user has no saved permissions for it). Used in the popup to show
   * the active tab's connection card above the comments section.
   */
  originFilter?: string;
  /**
   * If true and `originFilter` is set, renders nothing when the origin
   * has no entry. Defaults to true; set to false to keep the empty-state
   * card.
   */
  hideWhenEmpty?: boolean;
}

export function SitePermissionsList({
  compact = false,
  originFilter,
  hideWhenEmpty = true,
}: SitePermissionsListProps) {
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;
  const [sites, setSites] = useState<PermissionsMap>({});
  // Logged-out renders don't need a loading state — there's nothing to
  // load. Initialize `loading` from the presence of a pubkey so the
  // first paint is correct (no skeleton flash for logged-out users).
  const [loading, setLoading] = useState(() => Boolean(pubkey));

  useEffect(() => {
    if (!pubkey) {
      // Logged out (or account removed): nothing to load and nothing to
      // subscribe to. Don't touch `sites` from inside the effect — the
      // render path below already treats "no pubkey" as the empty case.
      return;
    }

    let cancelled = false;
    const load = async () => {
      const all = await getAllPermissions(pubkey);
      if (!cancelled) {
        setSites(all);
        setLoading(false);
      }
    };
    load();

    // The store is a `Record<pubkey, PermissionsMap>`; pluck out the
    // current account's slice on every change so the UI stays in sync
    // when the background writes new rules.
    const unsub = extStorage.onChange<Record<string, PermissionsMap>>(
      STORAGE_KEYS.permissions,
      (next) => {
        setSites(next?.[pubkey] ?? {});
      },
    );

    return () => {
      cancelled = true;
      unsub();
    };
  }, [pubkey]);

  // When logged out, ignore any stale `sites` left over from a previous
  // login and render the empty-state branch below.
  const effectiveSites = pubkey ? sites : {};
  const allEntries = Object.entries(effectiveSites).sort(([, a], [, b]) => b.lastSeen - a.lastSeen);
  const entries = originFilter
    ? allEntries.filter(([origin]) => origin === originFilter)
    : allEntries;

  if (loading && pubkey) {
    // When filtering to a single origin (popup case), don't show a 3-row
    // skeleton — it's misleading. Render nothing while loading.
    if (originFilter) return null;
    return (
      <div className="py-6 flex flex-col gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (entries.length === 0) {
    if (originFilter && hideWhenEmpty) return null;
    return (
      <Card className="border-dashed mt-2">
        <CardContent className="py-8 px-4 text-center">
          <p className="text-sm text-muted-foreground">
            No sites yet. When a Nostr app asks for permission, it will show up here.
          </p>
        </CardContent>
      </Card>
    );
  }

  const handleRevoke = async (origin: string) => {
    if (!pubkey) return;
    await revokeOrigin(pubkey, origin);
  };

  // We only get here if `entries.length > 0`, which means `sites` has
  // entries, which means `pubkey` was defined when the load ran. Reassert
  // that to TypeScript: the alternative is plumbing an optional pubkey
  // into every leaf component for an unreachable branch.
  if (!pubkey) return null;

  return (
    <ul className="space-y-2 py-2">
      {entries.map(([origin, data]) => (
        <li key={origin}>
          {compact ? (
            <CompactRow origin={origin} data={data} onRevoke={handleRevoke} />
          ) : (
            <ExpandedRow pubkey={pubkey} origin={origin} data={data} onRevoke={handleRevoke} />
          )}
        </li>
      ))}
    </ul>
  );
}

function OriginIcon({ icon, origin }: { icon?: string; origin: string }) {
  return (
    <div className="size-8 rounded-md bg-muted flex items-center justify-center overflow-hidden shrink-0">
      {icon ? (
        <img
          src={icon}
          alt=""
          className="size-full object-cover"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : (
        <Globe className="size-4 text-muted-foreground" aria-label={origin} />
      )}
    </div>
  );
}

function CompactRow({
  origin,
  data,
  onRevoke,
}: {
  origin: string;
  data: OriginPermissions;
  onRevoke: (origin: string) => void;
}) {
  const host = safeHost(origin);
  // `getPublicKey` / `getRelays` are stripped from `data.methods` by
  // `loadAll` (they're implicit for every connected origin), so we can
  // count `methods` directly without filtering.
  const visibleMethods = Object.entries(data.methods) as [
    NostrRpcMethod,
    'allow' | 'deny',
  ][];
  let allowedCount = visibleMethods.filter(([, v]) => v === 'allow').length;
  let deniedCount = visibleMethods.filter(([, v]) => v === 'deny').length;
  // Count per-kind signEvent rules and the optional "any kind" default
  // so the popup summary reflects the granular policy.
  if (data.signEvent?.default === 'allow') allowedCount += 1;
  if (data.signEvent?.default === 'deny') deniedCount += 1;
  if (data.signEvent?.kinds) {
    for (const v of Object.values(data.signEvent.kinds)) {
      if (v === 'allow') allowedCount += 1;
      else if (v === 'deny') deniedCount += 1;
    }
  }

  return (
    <div className="flex items-center gap-3 py-2">
      <OriginIcon icon={data.icon} origin={origin} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{host}</p>
        <p className="text-xs text-muted-foreground truncate">
          {allowedCount > 0 && `${allowedCount} allowed`}
          {allowedCount > 0 && deniedCount > 0 && ' · '}
          {deniedCount > 0 && `${deniedCount} blocked`}
          {allowedCount === 0 && deniedCount === 0 && 'No saved choices'}
        </p>
      </div>
      <Button
        size="icon"
        variant="ghost"
        onClick={() => onRevoke(origin)}
        aria-label={`Remove ${host}`}
        className="size-8 text-muted-foreground hover:text-destructive"
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}

function ExpandedRow({
  pubkey,
  origin,
  data,
  onRevoke,
}: {
  pubkey: string;
  origin: string;
  data: OriginPermissions;
  onRevoke: (origin: string) => void;
}) {
  const host = safeHost(origin);
  const showBadges = hasPermissionBadges(data);

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-3">
          <OriginIcon icon={data.icon} origin={origin} />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">{data.title ?? host}</p>
            <a
              href={origin}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground font-mono truncate hover:underline"
            >
              {host}
            </a>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onRevoke(origin)}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-4 mr-1" />
            Remove
          </Button>
        </div>

        {showBadges ? (
          <PermissionBadges pubkey={pubkey} origin={origin} data={data} />
        ) : (
          <p className="text-xs text-muted-foreground">
            No saved choices yet for this site.
          </p>
        )}
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
