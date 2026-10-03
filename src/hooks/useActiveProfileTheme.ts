import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';

import { ACTIVE_THEME_KIND, parseActiveProfileTheme, type ActiveProfileTheme } from '@/lib/themeEvent';

/**
 * Query the user's active profile theme (kind 16767).
 *
 * NIP-01 replaceable event — at most one per author. We constrain
 * `authors` to a single pubkey so a malicious relay can't substitute a
 * forged event from someone else.
 *
 * Caching matches the canonical Ditto implementation
 * (ditto/src/hooks/useActiveProfileTheme.ts):
 *   - staleTime  5 min
 *   - gcTime    10 min
 */
export function useActiveProfileTheme(pubkey: string | undefined) {
  const { nostr } = useNostr();

  return useQuery<ActiveProfileTheme | null>({
    queryKey: ['nostr', 'activeProfileTheme', pubkey ?? ''],
    queryFn: async () => {
      if (!pubkey) return null;

      const events = await nostr.query(
        [{
          kinds: [ACTIVE_THEME_KIND],
          authors: [pubkey],
          limit: 1,
        }],
        { signal: AbortSignal.timeout(5000) },
      );

      if (events.length === 0) return null;
      return parseActiveProfileTheme(events[0]);
    },
    enabled: !!pubkey,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}
