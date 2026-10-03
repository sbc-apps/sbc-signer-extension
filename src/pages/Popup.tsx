/**
 * Popup — the UI you see when clicking the extension's toolbar icon.
 *
 * Two states:
 *   1. Logged out → prompt to log in (nsec, bunker, nostrconnect).
 *      Reuses the `LoginArea` / `AuthDialog` from MKStack.
 *   2. Logged in  → NIP-22 comments thread for the active tab's URL.
 *      (Site-permission management lives on the Options page, reachable
 *      via the cog in the header.)
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, Loader2, Settings } from 'lucide-react';

import { LoginArea } from '@/components/auth/LoginArea';
import { BalancePill } from '@/components/BalancePill';
import { Logo } from '@/components/Logo';
import { SiteHeader } from '@/components/SiteHeader';
import { Button } from '@/components/ui/button';
import { useLoggedInAccounts } from '@/hooks/useLoggedInAccounts';
import { useActiveTabUrl } from '@/hooks/useActiveTabUrl';
import { PageCommentsPanel } from '@/components/comments/PageCommentsPanel';
import {
  getAllPermissions,
  type OriginPermissions,
  type PermissionsMap,
} from '@/extension/permissions';
import { openOptionsTab } from '@/extension/openOptionsTab';
import { extStorage, STORAGE_KEYS } from '@/extension/storage';
import { useToast } from '@/hooks/useToast';

export function Popup() {
  const { currentUser } = useLoggedInAccounts();
  const { url: activeTabUrl, title: activeTabTitle, favIconUrl: activeTabFavIcon } = useActiveTabUrl();

  // Origin of the active tab — used to surface that site's saved
  // permission entry above the comments. Only http(s) origins map to a
  // permission entry, so chrome:// / about:// tabs simply won't match.
  const activeOrigin = useMemo(() => {
    if (!activeTabUrl) return undefined;
    try {
      const u = new URL(activeTabUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
      return u.origin;
    } catch {
      return undefined;
    }
  }, [activeTabUrl]);

  // Cached title/icon for the active origin under the *current
  // account's* permission bucket. Used as a fallback when the live
  // `chrome.tabs` query hasn't yet reported a title/favicon (e.g. very
  // early in a navigation). Switching accounts re-resolves against
  // that account's bucket so a site connected under another identity
  // doesn't bleed its metadata into the popup for an unrelated
  // account.
  const activeOriginEntry = useActiveOriginEntry(currentUser?.pubkey, activeOrigin);

  // Cog → settings tab. Focuses an existing options/wallet tab and
  // routes it to '/' if one is already open; otherwise opens a fresh
  // tab. `chrome.runtime.openOptionsPage()` would spawn a duplicate
  // when the existing tab is on `#/wallet`.
  const openOptions = () => {
    void openOptionsTab('/');
  };

  const { archive, isArchiving } = useSaveAsNsite();

  return (
    <div className="flex flex-col min-h-[520px] w-[360px] bg-background/85 backdrop-blur text-foreground">
      <header className="flex items-center justify-between gap-2 px-4 h-14 border-b">
        <div className="flex items-center gap-2 min-w-0">
          <Logo className="size-7 shrink-0" alt="SBC Signer" />
          <span className="font-semibold text-sm truncate">SBC Signer Extension</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {currentUser && <BalancePill />}
          {currentUser && <LoginArea />}
          <Button
            size="icon"
            variant="ghost"
            onClick={openOptions}
            aria-label="Open settings"
            className="size-8 rounded-full"
          >
            <Settings className="size-4" />
          </Button>
        </div>
      </header>

      {!currentUser ? (
        <LoggedOutView />
      ) : (
        <div className="flex flex-col flex-1 min-h-0">
          {activeOrigin && (
            <div className="px-4 py-3 border-b flex items-center gap-2">
              <SiteHeader
                className="flex-1 min-w-0"
                origin={activeOrigin}
                icon={activeTabFavIcon ?? activeOriginEntry?.icon}
                title={activeTabTitle ?? activeOriginEntry?.title}
              />
              <Button
                size="icon"
                variant="ghost"
                onClick={archive}
                disabled={isArchiving}
                aria-label="Save page as nsite"
                title="Save page as nsite"
                className="size-8 shrink-0 rounded-full"
              >
                {isArchiving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Archive className="size-4" />
                )}
              </Button>
            </div>
          )}
          <div className="flex-1 min-h-0 flex flex-col px-4 pt-3 pb-0 gap-3">
            <PageCommentsPanel className="flex-1" />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * "Save as nsite" — hands the active tab to the background, which
 * captures it and opens the archive window.
 *
 * The background owns the whole sequence for the same reason it owns
 * `open-options-tab`: this popup is destroyed the instant the archive
 * window takes focus, which would abort an async chain running here.
 *
 * Unlike `openOptionsTab` this does await the reply, because the
 * background can refuse before opening anything (an unreadable page,
 * no login) and the popup is still alive to report it. A failure keeps
 * the popup open to show the toast; a success closes it explicitly
 * rather than assuming the new window steals focus, which doesn't
 * happen on every platform.
 */
function useSaveAsNsite() {
  const { toast } = useToast();
  const [isArchiving, setIsArchiving] = useState(false);

  const archive = useCallback(async () => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    setIsArchiving(true);

    try {
      const response: unknown = await chrome.runtime.sendMessage({ kind: 'open-archive' });
      const failed =
        response && typeof response === 'object' && (response as { ok?: unknown }).ok !== true;

      if (failed) {
        toast({
          title: (response as { error?: string }).error ?? 'Could not archive this page.',
          variant: 'destructive',
        });
      } else {
        // The archive window is where the user's attention goes now;
        // leaving the popup open behind it serves no purpose.
        window.close();
      }
    } catch {
      toast({ title: 'Could not archive this page.', variant: 'destructive' });
    } finally {
      setIsArchiving(false);
    }
  }, [toast]);

  return { archive, isArchiving };
}

/**
 * Subscribes to the permissions store and returns the entry for the
 * given (pubkey, origin) tuple, or undefined if there's no saved entry
 * / no origin / no logged-in user. Updates live when the store changes
 * so the popup reflects new connections without needing a re-open.
 */
function useActiveOriginEntry(
  pubkey: string | undefined,
  origin: string | undefined,
): OriginPermissions | undefined {
  // State is keyed by (pubkey, origin) so it's automatically reset to
  // undefined whenever either input changes. This avoids the
  // react-hooks/set-state-in-effect warning that would fire if we
  // synchronously called setEntry(undefined) from inside the effect
  // when origin disappeared.
  const [state, setState] = useState<{
    pubkey: string | undefined;
    origin: string | undefined;
    entry: OriginPermissions | undefined;
  }>(() => ({ pubkey, origin, entry: undefined }));

  useEffect(() => {
    if (!origin || !pubkey) return;
    let cancelled = false;
    (async () => {
      const all = await getAllPermissions(pubkey);
      if (!cancelled) setState({ pubkey, origin, entry: all[origin] });
    })();
    // The store is `Record<pubkey, PermissionsMap>`; pluck out the
    // current account's slice, then this origin's entry.
    const unsub = extStorage.onChange<Record<string, PermissionsMap>>(
      STORAGE_KEYS.permissions,
      (next) => {
        setState({ pubkey, origin, entry: next?.[pubkey]?.[origin] });
      },
    );
    return () => {
      cancelled = true;
      unsub();
    };
  }, [pubkey, origin]);

  // Only surface the entry when it matches the current (pubkey, origin)
  // — otherwise an entry from a previous account/origin would briefly
  // show through after a switch.
  return state.pubkey === pubkey && state.origin === origin ? state.entry : undefined;
}

function LoggedOutView() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 text-center gap-5">
      <Logo className="size-20" alt="SBC Signer" />
      <div className="space-y-1.5">
        <h1 className="text-lg font-semibold">Sign into Nostr</h1>
        <p className="text-sm text-muted-foreground max-w-[260px]">
          Log in once, then approve which Nostr apps can read your public key and sign events.
          You can also comment on any page you visit.
        </p>
      </div>
      <LoginArea className="w-full" />
    </div>
  );
}

export default Popup;
