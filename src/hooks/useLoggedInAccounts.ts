import { useNostr } from '@nostrify/react';
import { authorQueryOptions } from './useAuthor';
import { useNostrLogin } from '@nostrify/react/login';
import { useQueries } from '@tanstack/react-query';
import { NostrEvent, NostrMetadata } from '@nostrify/nostrify';

export interface Account {
  id: string;
  pubkey: string;
  event?: NostrEvent;
  metadata: NostrMetadata;
}

export function useLoggedInAccounts() {
  const { nostr } = useNostr();
  const { logins, setLogin, removeLogin } = useNostrLogin();

  const profiles = useQueries({
    queries: logins.map(({ pubkey }) => authorQueryOptions(nostr, pubkey)),
  });
  const authors: Account[] = logins.map(({ id, pubkey }, index) => ({
    id,
    pubkey,
    metadata: profiles[index].data?.metadata ?? {},
    event: profiles[index].data?.event,
  }));
  const isLoading = profiles.some((profile) => profile.isLoading);

  // Current user is the first login
  const currentUser: Account | undefined = (() => {
    const login = logins[0];
    if (!login) return undefined;
    const author = authors.find((a) => a.id === login.id);
    return { metadata: {}, ...author, id: login.id, pubkey: login.pubkey };
  })();

  // Other users are all logins except the current one
  const otherUsers = authors.slice(1);

  return {
    authors,
    currentUser,
    otherUsers,
    isLoading,
    setLogin,
    removeLogin,
  };
}