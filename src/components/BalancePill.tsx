import { useBitcoinWallet } from '@/hooks/useBitcoinWallet';
import { satsToUSD } from '@/lib/bitcoin';
import { openOptionsTab } from '@/extension/openOptionsTab';

/**
 * Compact USD balance pill for the popup header.
 *
 * Renders to the left of the account switcher only when:
 *   - the user is logged in
 *   - the wallet has loaded a balance
 *   - the BTC/USD price is known
 *   - the balance is greater than zero
 *
 * Clicking opens the wallet view of the options page
 * (`options.html#/wallet`). If a settings/wallet tab is already open,
 * it focuses that tab and routes it to `/wallet` instead of spawning a
 * duplicate.
 */
export function BalancePill() {
  const { addressData, btcPrice, isLoading } = useBitcoinWallet();

  if (isLoading) return null;
  if (!addressData) return null;
  if (!btcPrice) return null;
  if (addressData.totalBalance <= 0) return null;

  const openWallet = () => {
    void openOptionsTab('/wallet');
  };

  return (
    <button
      type="button"
      onClick={openWallet}
      className="inline-flex items-center h-8 px-2.5 rounded-full bg-orange-500/10 text-orange-600 dark:text-orange-400 hover:bg-orange-500/20 transition-colors text-xs font-medium tabular-nums"
      aria-label="Open Bitcoin wallet"
      title="Open Bitcoin wallet"
    >
      {satsToUSD(addressData.totalBalance, btcPrice)}
    </button>
  );
}
