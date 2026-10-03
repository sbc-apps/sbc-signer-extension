import { type NPool, type NostrEvent, type NostrMetadata, NSchema as n } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';

export function useAuthor(pubkey: string | undefined) {
  const { nostr } = useNostr();

  return useQuery(authorQueryOptions(nostr, pubkey));
}

export function authorQueryOptions(nostr: Pick<NPool, 'query'>, pubkey: string | undefined) {
  return {
    queryKey: ['nostr', 'author', pubkey ?? ''],
    queryFn: async (): Promise<{ event?: NostrEvent; metadata?: NostrMetadata }> => {
      if (!pubkey) {
        return {};
      }

      const [event] = await nostr.query(
        [{ kinds: [0], authors: [pubkey], limit: 1 }],
        { signal: AbortSignal.timeout(10_000) },
      );

      if (!event) {
        throw new Error('No event found');
      }

      try {
        const metadata = n.json().pipe(n.metadata()).parse(event.content);
        return { metadata, event };
      } catch {
        return { event };
      }
    },
    enabled: !!pubkey,
    staleTime: 5 * 60 * 1000, // Keep cached data fresh for 5 minutes
    retry: 3,
  };
}
