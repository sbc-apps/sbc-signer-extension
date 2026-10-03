import { useQuery } from '@tanstack/react-query';
import { queryProfile } from 'nostr-tools/nip05';

/**
 * Resolves a NIP-05 identifier (`name@domain` or bare `domain`) to a hex
 * pubkey by fetching the domain's `.well-known/nostr.json` endpoint via
 * nostr-tools' `queryProfile`.
 *
 * Returns `null` when the identifier doesn't resolve. Used by the Send
 * dialog's recipient dropdown to surface a profile row for a typed NIP-05.
 */
export function useNip05Resolve(identifier: string | undefined) {
  return useQuery<string | null>({
    queryKey: ['nip05-resolve', identifier],
    queryFn: async () => {
      if (!identifier) return null;
      const cleaned = identifier.startsWith('@') ? identifier.slice(1) : identifier;
      const profile = await queryProfile(cleaned);
      return profile?.pubkey ?? null;
    },
    enabled: !!identifier,
    staleTime: 60 * 60 * 1000, // 1 hour — NIP-05 records rarely change.
    gcTime: 2 * 60 * 60 * 1000,
    retry: 1,
  });
}
