import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useAppContext } from '@/hooks/useAppContext';
import {
  fetchAddressData,
  fetchBtcPrice,
  fetchTransactions,
  nostrPubkeyToBitcoinAddress,
} from '@/lib/bitcoin';

/**
 * Hook that derives a Bitcoin Taproot address from the current user's
 * Nostr pubkey and fetches its on-chain balance + transactions from the
 * configured Esplora-compatible API (default: mempool.space). BTC/USD
 * price also comes from the same API.
 *
 * Auto-refreshes balance and transactions every 30s; price every 60s.
 */
export function useBitcoinWallet() {
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { esploraApis } = config;

  const bitcoinAddress = useMemo(() => {
    if (!user) return '';
    return nostrPubkeyToBitcoinAddress(user.pubkey);
  }, [user]);

  const {
    data: addressData,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['bitcoin-balance', esploraApis, bitcoinAddress],
    queryFn: ({ signal }) => fetchAddressData(bitcoinAddress, esploraApis, signal),
    enabled: !!bitcoinAddress,
    refetchInterval: 30_000,
  });

  const { data: btcPrice } = useQuery({
    queryKey: ['btc-price', esploraApis],
    queryFn: ({ signal }) => fetchBtcPrice(esploraApis, signal),
    // Mempool.space refreshes its price feed roughly once a minute;
    // there's no reason to refetch faster than that, and treating the
    // value as fresh for the same window means the popup doesn't fire
    // off a request every time the user clicks the toolbar icon.
    refetchInterval: 60_000,
    staleTime: 60_000,
  });

  const {
    data: transactions,
    isLoading: isLoadingTxs,
  } = useQuery({
    queryKey: ['bitcoin-txs', esploraApis, bitcoinAddress],
    queryFn: ({ signal }) => fetchTransactions(bitcoinAddress, esploraApis, signal),
    enabled: !!bitcoinAddress,
    refetchInterval: 30_000,
  });

  return {
    bitcoinAddress,
    addressData,
    btcPrice,
    transactions,
    isLoading,
    isLoadingTxs,
    error,
    refetch,
    pubkey: user?.pubkey ?? '',
  };
}
