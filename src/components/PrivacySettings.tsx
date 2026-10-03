/**
 * Privacy settings — toggles that govern when the extension talks to
 * relays in the background.
 *
 * Currently exposes a single control: the comment-presence toolbar
 * badge. When enabled, the background service worker queries relays for
 * NIP-22 comments keyed by the canonical URL of every http(s) page you
 * visit, so it can paint a green dot on the toolbar icon. That means
 * those relays see (relay-side) the URL + your IP for essentially your
 * whole browsing history, so it ships OFF by default and is strictly
 * opt-in.
 *
 * This does NOT affect the popup: opening the popup always fetches
 * comments for the current page on demand, regardless of this setting.
 */

import { useEffect, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  extStorage,
  STORAGE_KEYS,
  COMMENT_BADGE_ENABLED_DEFAULT,
} from '@/extension/storage';

export function PrivacySettings() {
  const [badgeEnabled, setBadgeEnabled] = useState(COMMENT_BADGE_ENABLED_DEFAULT);

  useEffect(() => {
    let cancelled = false;

    extStorage
      .get<boolean>(STORAGE_KEYS.commentBadgeEnabled, COMMENT_BADGE_ENABLED_DEFAULT)
      .then((value) => {
        if (!cancelled) setBadgeEnabled(value);
      });

    // Keep in sync if another surface (or the background) flips it.
    const unsub = extStorage.onChange<boolean>(
      STORAGE_KEYS.commentBadgeEnabled,
      (next) => setBadgeEnabled(next ?? COMMENT_BADGE_ENABLED_DEFAULT),
    );

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const handleToggle = async (checked: boolean) => {
    // Optimistic: reflect immediately, then persist. The onChange
    // subscription will reconcile if the write is somehow rejected.
    setBadgeEnabled(checked);
    await extStorage.set(STORAGE_KEYS.commentBadgeEnabled, checked);
  };

  return (
    <div className="flex items-start justify-between gap-4 py-4">
      <div className="space-y-1">
        <Label htmlFor="comment-badge-toggle" className="text-sm font-medium">
          Show comment indicator on the toolbar
        </Label>
        <p className="text-sm text-muted-foreground">
          Checks relays for comments on each page you visit. Off by default for privacy.
        </p>
      </div>
      <Switch
        id="comment-badge-toggle"
        checked={badgeEnabled}
        onCheckedChange={handleToggle}
        className="mt-0.5"
      />
    </div>
  );
}

export default PrivacySettings;
