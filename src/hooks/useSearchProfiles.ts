import { useMemo } from 'react';
import { useNostr } from '@nostrify/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NSchema as n } from '@nostrify/nostrify';
import type { NostrEvent, NostrMetadata } from '@nostrify/nostrify';

import { useDebounce } from '@/hooks/useDebounce';

export interface SearchProfile {
  pubkey: string;
  metadata: NostrMetadata;
  event: NostrEvent;
}

/**
 * Search cached author profiles in the TanStack Query cache.
 *
 * Scans all `['nostr', 'author', pubkey]` entries (the key shape used by
 * {@link useAuthor}) for name / display_name / nip05 matches. This is the
 * offline fallback when the relay's NIP-50 search returns nothing.
 */
function searchCachedProfiles(
  queryClient: ReturnType<typeof useQueryClient>,
  query: string,
  limit = 10,
): SearchProfile[] {
  const lowerQuery = query.toLowerCase();
  const results: SearchProfile[] = [];

  const cache = queryClient.getQueryCache().findAll({ queryKey: ['nostr', 'author'] });

  for (const entry of cache) {
    const data = entry.state.data as { event?: NostrEvent; metadata?: NostrMetadata } | undefined;
    if (!data?.event || !data?.metadata) continue;

    const { metadata, event } = data;
    const name = metadata.name?.toLowerCase() ?? '';
    const displayName = metadata.display_name?.toLowerCase() ?? '';
    const nip05 = metadata.nip05?.toLowerCase() ?? '';

    if (name.includes(lowerQuery) || displayName.includes(lowerQuery) || nip05.includes(lowerQuery)) {
      results.push({ pubkey: event.pubkey, metadata, event });
    }
  }

  results.sort((a, b) => {
    const aName = (a.metadata.name || a.metadata.display_name || '').toLowerCase();
    const bName = (b.metadata.name || b.metadata.display_name || '').toLowerCase();
    return aName.localeCompare(bName);
  });

  return results.slice(0, limit);
}

/**
 * Search for profiles by username / NIP-05 using NIP-50 search on the
 * configured relays, falling back to the local author cache when the relay
 * returns nothing.
 *
 * Simplified from Ditto's hook: the extension has no follow list, so there is
 * no follow-ordering. The query is debounced so we don't hammer relays on
 * every keystroke.
 */
export function useSearchProfiles(query: string) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  const debouncedQuery = useDebounce(query, 300);

  const relayResults = useQuery<SearchProfile[]>({
    queryKey: ['search-profiles', debouncedQuery],
    queryFn: async ({ signal }) => {
      if (!debouncedQuery.trim()) return [];

      const events = await nostr.query(
        [{ kinds: [0], search: debouncedQuery.trim(), limit: 10 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) },
      );

      const profiles: SearchProfile[] = [];
      for (const event of events) {
        try {
          const metadata = n.json().pipe(n.metadata()).parse(event.content);
          profiles.push({ pubkey: event.pubkey, metadata, event });
        } catch {
          // Skip invalid metadata.
        }
      }

      // Deduplicate by pubkey, keeping the latest event.
      const seen = new Map<string, SearchProfile>();
      for (const profile of profiles) {
        const existing = seen.get(profile.pubkey);
        if (!existing || profile.event.created_at > existing.event.created_at) {
          seen.set(profile.pubkey, profile);
        }
      }

      return Array.from(seen.values());
    },
    enabled: debouncedQuery.trim().length >= 1,
    staleTime: 30 * 1000,
    placeholderData: (prev) => prev,
  });

  const data = useMemo(() => {
    const relayData = relayResults.data;

    if (relayData && relayData.length > 0) {
      return relayData;
    }

    // Relay returned nothing — search the local cache instead.
    if (debouncedQuery.trim().length >= 1) {
      return searchCachedProfiles(queryClient, debouncedQuery.trim());
    }

    return relayData;
  }, [relayResults.data, debouncedQuery, queryClient]);

  return {
    ...relayResults,
    data,
  };
}
