import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';
import { useLoggedInAccounts } from './useLoggedInAccounts';

const { query, loginState } = vi.hoisted(() => ({
  query: vi.fn(),
  loginState: { logins: [] as { id: string; pubkey: string }[], setLogin: vi.fn(), removeLogin: vi.fn() },
}));
vi.mock('@nostrify/react', () => ({ useNostr: () => ({ nostr: { query } }) }));
vi.mock('@nostrify/react/login', () => ({ useNostrLogin: () => loginState }));

afterEach(() => { cleanup(); vi.clearAllMocks(); loginState.logins = []; });

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
let client: QueryClient;
const pubkey = 'a'.repeat(64);
const event: NostrEvent = {
  id: 'b'.repeat(64), pubkey, sig: 'c'.repeat(128), kind: 0,
  created_at: 1, tags: [], content: JSON.stringify({ name: 'Alice', picture: 'https://example.com/avatar.png' }),
};

describe('account metadata', () => {
  it('loads metadata after login and retries an empty relay response', async () => {
    client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([event]);
    const { result, rerender } = renderHook(() => useLoggedInAccounts(), { wrapper });
    expect(query).not.toHaveBeenCalled();
    loginState.logins = [{ id: 'login-a', pubkey }];
    rerender();
    expect(result.current.currentUser?.pubkey).toBe(pubkey);
    await waitFor(() => expect(result.current.currentUser?.metadata.name).toBe('Alice'));
    expect(result.current.currentUser?.metadata.picture).toBe('https://example.com/avatar.png');
    expect(query).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(['nostr', 'author', pubkey])).toEqual({ event, metadata: JSON.parse(event.content) });
    client.clear();
  });
});
