import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nip19 } from 'nostr-tools';
import {
  AlertTriangle,
  Bitcoin,
  Check,
  ExternalLink,
  EyeOff,
  Loader2,
  X,
} from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

import { useAppContext } from '@/hooks/useAppContext';
import { useAuthor } from '@/hooks/useAuthor';
import { useBitcoinSigner } from '@/hooks/useBitcoinSigner';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNip05Resolve } from '@/hooks/useNip05Resolve';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { PortalContainerProvider } from '@/hooks/usePortalContainer';
import { useSearchProfiles, type SearchProfile } from '@/hooks/useSearchProfiles';
import { useToast } from '@/hooks/useToast';
import { detectIdentifier, type IdentifierMatch } from '@/lib/nostrIdentifier';
import { cn } from '@/lib/utils';
import {
  broadcastTransaction,
  buildUnsignedPsbt,
  estimateFee,
  fetchUTXOs,
  finalizePsbt,
  getFeeRates,
  isLargeAmount,
  nostrPubkeyToBitcoinAddress,
  parseBitcoinUri,
  satsToUSD,
  validateBitcoinAddress,
  type FeeRates,
} from '@/lib/bitcoin';
import { isSilentPaymentAddress, decodeSilentPaymentAddress } from '@/lib/silentPayments';

/** Best-effort validity check for a silent payment address (no throw). */
function validateSilentPaymentAddress(addr: string): boolean {
  try {
    decodeSilentPaymentAddress(addr);
    return true;
  } catch {
    return false;
  }
}


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USD_PRESETS = [1, 5, 20, 50, 100];

/** Preset confirmation-speed tiers, plus a user-entered `'custom'` rate. */
type FeeSpeed = 'fastest' | 'halfHour' | 'hour' | 'economy' | 'custom';

/** The preset tiers (everything except `'custom'`), in display order. */
type PresetFeeSpeed = Exclude<FeeSpeed, 'custom'>;

const FEE_SPEED_LABELS: Record<FeeSpeed, string> = {
  fastest: '~10 min',
  halfHour: '~30 min',
  hour: '~1 hour',
  economy: '~1 day',
  custom: 'Custom',
};

const FEE_SPEED_ORDER: PresetFeeSpeed[] = ['fastest', 'halfHour', 'hour', 'economy'];

function getRateForSpeed(rates: FeeRates, speed: PresetFeeSpeed): number {
  switch (speed) {
    case 'fastest': return rates.fastestFee;
    case 'halfHour': return rates.halfHourFee;
    case 'hour': return rates.hourFee;
    case 'economy': return rates.economyFee;
  }
}

/** Deduplicate fee tiers that share the same sat/vB rate. */
function getUniqueFeeSpeeds(rates: FeeRates | undefined): PresetFeeSpeed[] {
  if (!rates) return FEE_SPEED_ORDER;
  const seen = new Set<number>();
  const result: PresetFeeSpeed[] = [];
  for (const speed of FEE_SPEED_ORDER) {
    const rate = getRateForSpeed(rates, speed);
    if (!seen.has(rate)) {
      seen.add(rate);
      result.push(speed);
    }
  }
  return result;
}

/**
 * Resolve the effective sat/vB rate for the current selection. For `'custom'`
 * the user-typed value wins (parsed, clamped to ≥ 1). For preset tiers we read
 * the loaded rates; returns `0` when rates haven't loaded, which callers treat
 * as "not ready" rather than a real rate.
 */
function resolveFeeRate(
  speed: FeeSpeed,
  rates: FeeRates | undefined,
  customFeeRate: string,
): number {
  if (speed === 'custom') {
    const parsed = Math.floor(Number(customFeeRate));
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : 0;
  }
  if (!rates) return 0;
  return getRateForSpeed(rates, speed);
}

// ---------------------------------------------------------------------------
// Recipient resolution
// ---------------------------------------------------------------------------

/**
 * Resolved recipient. Always carries a Bitcoin-spendable address; when
 * `pubkey` is set the recipient is also a Nostr identity, which gates the
 * kind 8333 onchain zap publish on success.
 */
interface ResolvedRecipient {
  /**
   * For regular sends, a P2TR Bitcoin address. For silent payment sends, the
   * literal `sp1…` string (the on-chain P2TR address is derived at build
   * time from the chosen input set and the sender's private key).
   */
  address: string;
  /** `'onchain'` for a regular P2TR address, `'sp'` for a silent payment. */
  kind: 'onchain' | 'sp';
  /** Hex Nostr pubkey, when the recipient is a Nostr user. */
  pubkey?: string;
  /** Inline profile from the search dropdown, to skip a redundant lookup. */
  profile?: SearchProfile;
  /** Raw text the user originally typed / pasted (for display). */
  raw: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SendBitcoinDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** BTC/USD price — passed from the parent to avoid a duplicate fetch. */
  btcPrice?: number;
}

interface SendResult {
  txid: string;
  amountSats: number;
  /** Set when the recipient was a Nostr user (kind 8333 published). */
  recipientPubkey?: string;
  /** Bitcoin network fee in satoshis. */
  fee: number;
}

/**
 * Wallet "Send Bitcoin" dialog. Mirrors Ditto's onchain-zap UX:
 *
 *  - Single screen, no review step. Big editable USD amount on top, USD preset
 *    chips below.
 *  - Recipient input accepts an npub, nprofile, NIP-05 identifier, raw hex
 *    pubkey, or a raw bc1… Bitcoin address.
 *  - Fee speed shown as a small line below the send button; popover for picking.
 *  - When the recipient is a Nostr identity, publishes a kind 8333 onchain zap
 *    event after broadcast (no `e`/`a` tag → profile-level zap, per NIP-BC).
 *  - Raw-address sends require an explicit privacy acknowledgement and a two-tap
 *    arm — Bitcoin's public ledger means the send is permanently linkable to the
 *    sender.
 *  - Amounts over $100 (large-send threshold) also require a two-tap arm.
 *
 * The extension does not have an in-app NIP-73 tx page, so the "View
 * transaction" link goes straight to mempool.space.
 */
export function SendBitcoinDialog({ isOpen, onClose, btcPrice }: SendBitcoinDialogProps) {
  const { user } = useCurrentUser();
  const { canSignPsbt, canSendSilentPayment, signPsbt, buildSilentPaymentPsbt } = useBitcoinSigner();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const { toast } = useToast();
  const { config } = useAppContext();
  const { esploraApis } = config;
  const queryClient = useQueryClient();

  // ── Form state ───────────────────────────────────────────────
  const [recipient, setRecipient] = useState<ResolvedRecipient | null>(null);
  const [usdAmount, setUsdAmount] = useState<number | string>(5);
  const [feeSpeed, setFeeSpeed] = useState<FeeSpeed>('halfHour');
  /** Raw text for the custom sat/vB rate input (only used when feeSpeed === 'custom'). */
  const [customFeeRate, setCustomFeeRate] = useState('');
  const [error, setError] = useState('');
  const [editingAmount, setEditingAmount] = useState(false);
  const [feePopoverOpen, setFeePopoverOpen] = useState(false);
  const [success, setSuccess] = useState<SendResult | null>(null);

  const amountInputRef = useRef<HTMLInputElement>(null);
  // The dialog content element, used as the portal container for the recipient
  // dropdown so it stays inside the dialog's RemoveScroll boundary (touch
  // scroll inside the results list keeps working).
  const [dialogContent, setDialogContent] = useState<HTMLDivElement | null>(null);
  // True after the user has picked a fee speed manually; suppresses the
  // auto-tune logic below. Stored as state (not a ref) so it can be safely
  // read during render to gate the derived "auto-pick a speed" calculation.
  const [feeSpeedUserChanged, setFeeSpeedUserChanged] = useState(false);

  const senderAddress = user ? nostrPubkeyToBitcoinAddress(user.pubkey) : '';

  // ── Data fetching ────────────────────────────────────────────

  const { data: utxos } = useQuery({
    queryKey: ['bitcoin-utxos', esploraApis, senderAddress],
    queryFn: ({ signal }) => fetchUTXOs(senderAddress, esploraApis, signal),
    enabled: !!senderAddress && isOpen && canSignPsbt,
    staleTime: 30_000,
  });

  const {
    data: feeRates,
    isLoading: feeRatesLoading,
    isError: feeRatesError,
    refetch: refetchFeeRates,
  } = useQuery({
    queryKey: ['bitcoin-fee-rates', esploraApis],
    queryFn: ({ signal }) => getFeeRates(esploraApis, signal),
    enabled: isOpen && canSignPsbt,
    staleTime: 30_000,
  });

  const totalBalance = useMemo(
    () => utxos?.reduce((s, u) => s + u.value, 0) ?? 0,
    [utxos],
  );

  const currentFeeRate = useMemo(
    () => resolveFeeRate(feeSpeed, feeRates, customFeeRate),
    [feeSpeed, feeRates, customFeeRate],
  );

  // ── USD → sats conversion ────────────────────────────────────

  const amountSats = useMemo(() => {
    if (!btcPrice) return 0;
    const usd = typeof usdAmount === 'string' ? parseFloat(usdAmount) : usdAmount;
    if (!Number.isFinite(usd) || usd <= 0) return 0;
    const btc = usd / btcPrice;
    return Math.round(btc * 100_000_000);
  }, [usdAmount, btcPrice]);

  const estimatedFeeSats = useMemo(() => {
    if (!utxos?.length || !currentFeeRate || !amountSats) return 0;
    // Estimate with 2 outputs first, then check whether change would be dust
    const fee2 = estimateFee(utxos.length, 2, currentFeeRate);
    const change = totalBalance - amountSats - fee2;
    const numOutputs = change > 546 ? 2 : 1;
    return estimateFee(utxos.length, numOutputs, currentFeeRate);
  }, [utxos, currentFeeRate, amountSats, totalBalance]);

  const totalSats = amountSats + estimatedFeeSats;
  const insufficient = totalBalance > 0 && totalSats > totalBalance;
  const showBalance = insufficient || (amountSats > 0 && totalBalance === 0);

  // Auto-tune the fee speed so the network fee stays under 40% of the send
  // amount, unless the user has manually picked a speed.
  //
  // Derived during render via the "store previous inputs in state and reset
  // if they changed" pattern from the React docs, rather than a setState
  // inside useEffect (which lints as cascading-render).
  const autoSpeedKey = `${amountSats}|${utxos?.length ?? 0}|${totalBalance}|${feeRates ? `${feeRates.fastestFee}-${feeRates.halfHourFee}-${feeRates.hourFee}-${feeRates.economyFee}` : ''}`;
  const [lastAutoSpeedKey, setLastAutoSpeedKey] = useState<string | null>(null);
  if (autoSpeedKey !== lastAutoSpeedKey && !feeSpeedUserChanged) {
    setLastAutoSpeedKey(autoSpeedKey);
    if (utxos?.length && feeRates && amountSats > 0) {
      const uniqueSpeeds = getUniqueFeeSpeeds(feeRates);
      const threshold = amountSats * 0.4;
      let target: PresetFeeSpeed = uniqueSpeeds[uniqueSpeeds.length - 1];
      for (const speed of uniqueSpeeds) {
        const rate = getRateForSpeed(feeRates, speed);
        const fee2 = estimateFee(utxos.length, 2, rate);
        const change = totalBalance - amountSats - fee2;
        const outputs = change > 546 ? 2 : 1;
        const fee = estimateFee(utxos.length, outputs, rate);
        if (fee <= threshold) {
          target = speed;
          break;
        }
      }
      if (target !== feeSpeed) setFeeSpeed(target);
    }
  }

  const handleFeeSpeedChange = useCallback((speed: FeeSpeed) => {
    setFeeSpeedUserChanged(true);
    setFeeSpeed(speed);
    // Keep the popover open for 'custom' so the user can type a rate; close it
    // for preset tiers since the choice is complete.
    if (speed !== 'custom') setFeePopoverOpen(false);
  }, []);

  // ── Recipient resolution ─────────────────────────────────────

  // Called by the RecipientPicker once the user picks (or clears) a recipient.
  // We re-validate the few cross-cutting concerns the picker can't know about:
  // self-send and the bunker-can't-do-silent-payments restriction.
  const handleRecipientChange = useCallback((resolved: ResolvedRecipient | null) => {
    setError('');
    if (!resolved) {
      setRecipient(null);
      return;
    }
    if (user && resolved.pubkey === user.pubkey) {
      setError("You can't send to yourself.");
      return;
    }
    if (resolved.kind === 'sp' && !canSendSilentPayment) {
      setError(
        'Silent payments require logging in with your secret key. Remote signers cannot build silent payment outputs.',
      );
      return;
    }
    setRecipient(resolved);

    // If the recipient was pasted as a BIP-21 `bitcoin:` URI carrying an
    // `amount=`, prefill the USD amount field by converting the requested
    // sats at the current price. We only do this when a price is known;
    // otherwise the user keeps their existing amount.
    const uri = parseBitcoinUri(resolved.raw);
    if (uri?.amountSats && btcPrice) {
      const usd = (uri.amountSats / 100_000_000) * btcPrice;
      if (Number.isFinite(usd) && usd > 0) {
        setUsdAmount(Number(usd.toFixed(2)));
      }
    }
  }, [user, canSendSilentPayment, btcPrice]);


  // ── Two-tap "arm" for large amounts ──────────────────────────

  const isLarge = isLargeAmount(totalSats, btcPrice);
  const [confirmArmed, setConfirmArmed] = useState(false);

  // ── Raw Bitcoin address privacy notice ──────────────────────
  //
  // When the recipient is a raw on-chain address (no Nostr pubkey attached),
  // Bitcoin's public ledger means the send can be linked back to the sender's
  // wallet forever. We show a soft amber notice so the user understands the
  // trade-off, but don't gate the send on it — the warning is informational.
  //
  // Silent payment recipients (BIP-352) do not have this problem — the
  // on-chain output is derived per-transaction and is indistinguishable
  // from any other P2TR output, so the recipient's identity isn't exposed
  // on chain. We skip the notice for SP sends.
  const isRawAddress = !!recipient && !recipient.pubkey && recipient.kind !== 'sp';

  // Reset the arm whenever the user changes any input that materially affects
  // what's about to be sent. Implemented as a "previous inputs in state" check
  // during render rather than a setState inside useEffect.
  const armResetKey = `${amountSats}|${currentFeeRate}|${btcPrice ?? ''}|${recipient?.address ?? ''}`;
  const [lastArmResetKey, setLastArmResetKey] = useState<string | null>(null);
  if (armResetKey !== lastArmResetKey) {
    setLastArmResetKey(armResetKey);
    if (confirmArmed) setConfirmArmed(false);
  }

  // The two-tap arm is reserved for large amounts; raw on-chain sends no
  // longer trigger it on their own.
  const requiresArm = isLarge;

  // ── Big amount focus management ──────────────────────────────

  useEffect(() => {
    if (editingAmount) {
      amountInputRef.current?.focus();
      amountInputRef.current?.select();
    }
  }, [editingAmount]);

  const commitAmountEdit = useCallback(() => {
    setEditingAmount(false);
    if (typeof usdAmount === 'string' && usdAmount.trim() === '') {
      setUsdAmount(0);
    }
  }, [usdAmount]);

  // ── Send mutation ────────────────────────────────────────────

  const [progress, setProgress] = useState<'idle' | 'building' | 'signing' | 'broadcasting' | 'publishing'>('idle');

  const sendMutation = useMutation<SendResult, Error, void>({
    mutationFn: async () => {
      if (!user) throw new Error('You must be logged in.');
      if (!recipient) throw new Error('Choose a recipient.');
      if (!canSignPsbt || !signPsbt) throw new Error("Your login doesn't support sending Bitcoin.");
      if (!utxos?.length) throw new Error('No spendable Bitcoin available.');
      if (feeSpeed !== 'custom' && !feeRates) throw new Error('Fee rates not loaded.');
      if (recipient.pubkey === user.pubkey) throw new Error("You can't send to yourself.");
      if (amountSats <= 0) throw new Error('Enter an amount.');
      if (insufficient) throw new Error('Not enough Bitcoin for this amount + network fee.');
      if (recipient.kind === 'sp' && !buildSilentPaymentPsbt) {
        throw new Error(
          'Silent payments require logging in with your secret key. Bunker (NIP-46) signers cannot build silent payment outputs.',
        );
      }

      setProgress('building');
      const rate = resolveFeeRate(feeSpeed, feeRates, customFeeRate);
      if (rate < 1) throw new Error('Enter a fee rate of at least 1 sat/vB.');
      const { psbtHex, fee } = recipient.kind === 'sp' && buildSilentPaymentPsbt
        ? buildSilentPaymentPsbt(recipient.address, amountSats, utxos, rate)
        : buildUnsignedPsbt(
            user.pubkey,
            recipient.address,
            amountSats,
            utxos,
            rate,
          );

      setProgress('signing');
      const signedHex = await signPsbt(psbtHex);
      const txHex = finalizePsbt(signedHex);

      setProgress('broadcasting');
      const txid = await broadcastTransaction(txHex, esploraApis);

      // When the recipient is a Nostr identity, publish a kind 8333 profile
      // zap attesting the send. Per NIP-BC, omitting `e`/`a` targets the
      // recipient's profile (a tip to the pubkey, not a specific event).
      //
      // Silent payment recipients have no Nostr identity attached, so we
      // skip the kind-8333 publish for them.
      if (recipient.pubkey) {
        setProgress('publishing');
        try {
          await publishEvent({
            kind: 8333,
            content: '',
            tags: [
              ['i', `bitcoin:tx:${txid}`],
              ['p', recipient.pubkey],
              ['amount', String(amountSats)],
              ['alt', `On-chain zap: ${amountSats.toLocaleString()} sats`],
            ],
          });
        } catch (err) {
          // The Bitcoin transaction already broadcast — the kind 8333 is a
          // best-effort attestation. Surface the failure but don't blow up
          // the success screen.
          console.warn('Failed to publish kind 8333 zap event:', err);
        }
      }

      return {
        txid,
        amountSats,
        recipientPubkey: recipient.pubkey,
        fee,
      };
    },
    onSuccess: (result) => {
      setSuccess(result);
      queryClient.invalidateQueries({ queryKey: ['bitcoin-utxos'] });
      queryClient.invalidateQueries({ queryKey: ['bitcoin-balance'] });
      queryClient.invalidateQueries({ queryKey: ['bitcoin-txs'] });
    },
    onError: (err) => {
      toast({ title: 'Transaction failed', description: err.message, variant: 'destructive' });
    },
    onSettled: () => {
      setProgress('idle');
    },
  });

  // ── Send handler ─────────────────────────────────────────────

  const handleSend = useCallback(async () => {
    setError('');
    if (!user) { setError('You must be logged in.'); return; }
    if (!recipient) { setError('Choose a recipient.'); return; }
    if (recipient.pubkey === user.pubkey) { setError("You can't send to yourself."); return; }
    if (!btcPrice) { setError('Waiting for BTC price…'); return; }
    if (amountSats <= 0) { setError('Enter an amount.'); return; }
    if (!utxos?.length) { setError("You don't have any Bitcoin yet."); return; }
    if (currentFeeRate < 1) {
      setError(
        feeSpeed === 'custom'
          ? 'Enter a fee rate of at least 1 sat/vB.'
          : "Fee rates haven't loaded yet.",
      );
      return;
    }
    if (insufficient) { setError('Not enough Bitcoin for this amount + network fee.'); return; }

    if (requiresArm && !confirmArmed) {
      setConfirmArmed(true);
      return;
    }

    try {
      await sendMutation.mutateAsync();
    } catch {
      // Toast handled in onError; nothing further to do here.
    }
  }, [user, recipient, btcPrice, amountSats, utxos, currentFeeRate, feeSpeed, insufficient, requiresArm, confirmArmed, sendMutation]);

  // ── Reset on close ───────────────────────────────────────────

  const handleClose = useCallback(() => {
    setRecipient(null);
    setUsdAmount(5);
    setError('');
    setFeeSpeed('halfHour');
    setCustomFeeRate('');
    setSuccess(null);
    setConfirmArmed(false);
    setEditingAmount(false);
    setFeeSpeedUserChanged(false);
    onClose();
  }, [onClose]);

  // ── Render ───────────────────────────────────────────────────

  const currentUsd = typeof usdAmount === 'string' ? parseFloat(usdAmount) : usdAmount;
  const hasValidAmount = Number.isFinite(currentUsd) && currentUsd > 0;
  const totalUsdString = btcPrice ? satsToUSD(totalSats, btcPrice) : '';
  const uniqueFeeSpeeds = useMemo(() => getUniqueFeeSpeeds(feeRates), [feeRates]);
  const isPending = sendMutation.isPending;

  // ── Unsupported signer ───────────────────────────────────────

  if (isOpen && !canSignPsbt) {
    return (
      <Dialog open={isOpen} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-orange-500" />
            Sending Not Available
          </DialogTitle>
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertDescription>
              Your login doesn't support sending Bitcoin. Log in with your secret key to send.
            </AlertDescription>
          </Alert>
          <Button onClick={handleClose}>Close</Button>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent
        ref={setDialogContent}
        className="max-w-sm sm:max-w-sm rounded-2xl p-0 gap-0 border-border overflow-visible max-h-[95vh] [&>button]:hidden"
      >
        <PortalContainerProvider value={dialogContent ?? undefined}>
        <div className="flex items-center justify-between px-4 h-12">
          <DialogTitle className="text-base font-semibold flex items-center gap-1.5">
            {success ? 'Success' : 'Send Bitcoin'}
          </DialogTitle>
          <button
            onClick={handleClose}
            className="p-1.5 -mr-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="overflow-y-auto overflow-x-visible">
          {success ? (
            <SuccessView
              result={success}
              btcPrice={btcPrice}
              onClose={handleClose}
            />
          ) : (
            <div className="grid gap-4 px-4 py-4 w-full">
              {/* Big editable USD amount */}
              <div className="flex flex-col items-center pt-2">
                {editingAmount ? (
                  <div className="flex items-baseline justify-center">
                    <span className={`text-4xl font-semibold ${insufficient ? 'text-destructive' : 'text-muted-foreground'}`}>$</span>
                    <input
                      ref={amountInputRef}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.01"
                      value={usdAmount}
                      onChange={(e) => { setUsdAmount(e.target.value); setError(''); }}
                      onBlur={commitAmountEdit}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commitAmountEdit(); }
                      }}
                      aria-label="Amount in USD"
                      className={`bg-transparent border-0 outline-none text-4xl font-semibold text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${insufficient ? 'text-destructive' : ''}`}
                      style={{ width: `${Math.max(2, String(usdAmount).length + 1)}ch` }}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setEditingAmount(true)}
                    aria-label="Edit amount"
                    className="flex items-baseline justify-center rounded-md px-2 -mx-2 hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
                  >
                    <span className={`text-4xl font-semibold ${insufficient ? 'text-destructive' : 'text-muted-foreground'}`}>$</span>
                    <span className={`text-4xl font-semibold tabular-nums ${insufficient ? 'text-destructive' : ''}`}>
                      {hasValidAmount ? currentUsd : 0}
                    </span>
                  </button>
                )}
              </div>

              {/* Preset chips */}
              <ToggleGroup
                type="single"
                spacing={1}
                value={USD_PRESETS.includes(Number(usdAmount)) ? String(usdAmount) : ''}
                onValueChange={(v) => { if (v) { setUsdAmount(Number(v)); setError(''); setEditingAmount(false); } }}
                className="grid grid-cols-5 gap-1 w-full"
              >
                {USD_PRESETS.map((v) => (
                  <ToggleGroupItem
                    key={v}
                    value={String(v)}
                    className="h-8 min-w-0 text-xs font-semibold px-1 rounded-md"
                  >
                    ${v}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>

              {/* Recipient picker */}
              <RecipientPicker
                value={recipient}
                onChange={handleRecipientChange}
              />


              {/* Error */}
              {error && (
                <p className="text-xs text-destructive">{error}</p>
              )}

              {/* Privacy notice for raw Bitcoin addresses. Informational
                  only — we no longer gate the send on an acknowledgement. */}
              {isRawAddress && (
                <Alert className="border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300 [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400">
                  <AlertTriangle className="size-4" />
                  <AlertDescription className="text-xs">
                    Money you send is public and can be traced back to you.{' '}
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className="underline underline-offset-2 font-medium hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                        >
                          Learn more
                        </button>
                      </PopoverTrigger>
                      <PopoverContent side="top" align="start" className="w-72 text-xs leading-relaxed">
                        Bitcoin is a public ledger. Transactions you send can
                        be traced back to you forever, even after being
                        exchanged by multiple people. Send it only to those
                        you wish to support publicly, or cash out at an
                        exchange.
                      </PopoverContent>
                    </Popover>
                  </AlertDescription>
                </Alert>
              )}

              {/* Send button */}
              <Button
                onClick={handleSend}
                disabled={
                  !btcPrice
                  || amountSats <= 0
                  || isPending
                  || insufficient
                  || !recipient
                  || currentFeeRate < 1
                }
                variant={(insufficient || requiresArm) && !isPending ? 'destructive' : 'default'}
                className="w-full"
              >
                {isPending ? (
                  <>
                    <Loader2 className="size-4 mr-1.5 animate-spin" />
                    {progressLabel(progress)}
                  </>
                ) : insufficient ? (
                  <>Not enough Bitcoin</>
                ) : requiresArm && confirmArmed ? (
                  <>Tap again to send {totalUsdString}</>
                ) : (
                  <>Send {totalUsdString || (hasValidAmount ? `$${currentUsd}` : '')}</>
                )}
              </Button>

              {/* Fee line / picker */}
              {amountSats > 0 && (
                <div className="flex items-center justify-center gap-3 -mt-1 text-xs">
                  <Popover open={feePopoverOpen} onOpenChange={setFeePopoverOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <span>
                          Fee{' '}
                          {estimatedFeeSats > 0 && btcPrice
                            ? `≈ ${satsToUSD(estimatedFeeSats, btcPrice)}`
                            : feeRatesLoading && feeSpeed !== 'custom'
                              ? 'loading…'
                              : feeRatesError && feeSpeed !== 'custom'
                                ? 'unavailable'
                                : '…'}
                          <span className="opacity-60">
                            {' · '}
                            {feeSpeed === 'custom' && currentFeeRate >= 1
                              ? `${currentFeeRate} sat/vB`
                              : FEE_SPEED_LABELS[feeSpeed]}
                          </span>
                        </span>
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="center" sideOffset={6} className="w-56 p-1">
                      <div className="flex flex-col">
                        {feeRatesError && (
                          <div className="px-2 py-1.5 text-xs text-muted-foreground">
                            <p className="text-destructive">Couldn't load fee rates.</p>
                            <button
                              type="button"
                              onClick={() => refetchFeeRates()}
                              className="mt-1 underline hover:text-foreground transition-colors"
                            >
                              Retry
                            </button>
                            <p className="mt-1">Or enter a custom rate below.</p>
                          </div>
                        )}
                        {feeRatesLoading && !feeRatesError && (
                          <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                            <Loader2 className="size-3 animate-spin" />
                            Loading fee rates…
                          </div>
                        )}
                        {feeRates && uniqueFeeSpeeds.map((speed) => {
                          const rate = getRateForSpeed(feeRates, speed);
                          const selected = speed === feeSpeed;
                          return (
                            <button
                              key={speed}
                              type="button"
                              onClick={() => handleFeeSpeedChange(speed)}
                              className={cn(
                                'flex items-center justify-between px-2 py-1.5 rounded-sm text-xs text-left hover:bg-muted transition-colors',
                                selected && 'bg-muted font-medium',
                              )}
                            >
                              <span>{FEE_SPEED_LABELS[speed]}</span>
                              <span className="text-muted-foreground">{rate} sat/vB</span>
                            </button>
                          );
                        })}
                        {/* Custom fee rate */}
                        <button
                          type="button"
                          onClick={() => handleFeeSpeedChange('custom')}
                          className={cn(
                            'flex items-center justify-between px-2 py-1.5 rounded-sm text-xs text-left hover:bg-muted transition-colors',
                            feeSpeed === 'custom' && 'bg-muted font-medium',
                          )}
                        >
                          <span>{FEE_SPEED_LABELS.custom}</span>
                        </button>
                        {feeSpeed === 'custom' && (
                          <div className="flex items-center gap-1.5 px-2 py-1.5">
                            <Input
                              type="number"
                              inputMode="decimal"
                              min={1}
                              step={1}
                              autoFocus
                              value={customFeeRate}
                              onChange={(e) => setCustomFeeRate(e.target.value)}
                              placeholder="e.g. 5"
                              className="h-7 text-xs"
                              aria-label="Custom fee rate in sat/vB"
                            />
                            <span className="text-xs text-muted-foreground whitespace-nowrap">sat/vB</span>
                          </div>
                        )}
                      </div>
                    </PopoverContent>
                  </Popover>

                  {showBalance && !insufficient && btcPrice && (
                    <span className="text-muted-foreground">
                      Balance: {satsToUSD(totalBalance, btcPrice)}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        </PortalContainerProvider>
      </DialogContent>
    </Dialog>
  );
}

function progressLabel(progress: 'idle' | 'building' | 'signing' | 'broadcasting' | 'publishing'): string {
  switch (progress) {
    case 'building': return 'Building…';
    case 'signing': return 'Signing…';
    case 'broadcasting': return 'Broadcasting…';
    case 'publishing': return 'Publishing…';
    default: return 'Sending…';
  }
}

// ═══════════════════════════════════════════════════════════════════
// Recipient picker
// ═══════════════════════════════════════════════════════════════════

interface RecipientPickerProps {
  value: ResolvedRecipient | null;
  onChange: (value: ResolvedRecipient | null) => void;
}

/**
 * Combobox that lets the user pick a Nostr profile from autocomplete, paste a
 * Nostr identifier (npub / nprofile / NIP-05 / hex), or type a raw Bitcoin or
 * silent payment address (or a `bitcoin:` BIP-21 URI).
 *
 * The dropdown only surfaces profile-shaped suggestions plus address rows —
 * every selection is something the user can actually be paid. A dual-endpoint
 * `bitcoin:` URI (both an on-chain address and a valid `sp=`) keeps the
 * dropdown open so the user explicitly picks privacy (sp) vs. compatibility.
 */
function RecipientPicker({ value, onChange }: RecipientPickerProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverContentRef = useRef<HTMLDivElement>(null);

  // BIP-21 `bitcoin:` URI handling. A raw bc1…/sp1… input falls through here
  // unchanged: `bip21` is null and the candidate is just the trimmed query.
  const trimmedRaw = query.trim();
  const bip21 = useMemo(() => parseBitcoinUri(trimmedRaw), [trimmedRaw]);

  const btcCandidate = useMemo(() => {
    const c = bip21 ? bip21.address : trimmedRaw;
    if (!c) return '';
    if (isSilentPaymentAddress(c)) return ''; // sp addresses live in spCandidate
    return validateBitcoinAddress(c) ? c : '';
  }, [bip21, trimmedRaw]);

  const spCandidate = useMemo(() => {
    // From the URI: prefer `sp=` if valid; otherwise the path may itself be an
    // sp1 address (`bitcoin:sp1…` is a URI without an on-chain fallback).
    const c = bip21 ? (bip21.sp ?? bip21.address) : trimmedRaw;
    if (!c) return '';
    if (!isSilentPaymentAddress(c)) return '';
    return validateSilentPaymentAddress(c) ? c : '';
  }, [bip21, trimmedRaw]);

  // Suppress profile search when the input already resolves to an address /
  // URI — avoids leaking the recipient to the search relay and stops stale
  // profile rows from racing the address-recognition path.
  const isAddressLike = !!btcCandidate || !!spCandidate;
  const searchQuery = isAddressLike ? '' : query;

  const { data: rawProfiles, isFetching: rawIsFetching } = useSearchProfiles(searchQuery);
  const profiles = isAddressLike ? undefined : rawProfiles;
  const isFetching = isAddressLike ? false : rawIsFetching;

  const identifierMatch = useMemo(() => detectIdentifier(query), [query]);

  const hasBtcAddress = !identifierMatch && !!btcCandidate && !profiles?.length;
  const hasSpAddress = !identifierMatch && !!spCandidate && !profiles?.length;

  const identifierPubkey = useMemo(() => {
    if (!identifierMatch) return undefined;
    if (identifierMatch.type === 'npub' || identifierMatch.type === 'nprofile') return identifierMatch.pubkey;
    if (identifierMatch.type === 'hex') return identifierMatch.hex;
    return undefined; // nip05 resolves async; handled by IdentifierRow
  }, [identifierMatch]);

  const filteredProfiles = useMemo(() => {
    if (!profiles || !identifierPubkey) return profiles ?? [];
    return profiles.filter((p) => p.pubkey !== identifierPubkey);
  }, [profiles, identifierPubkey]);

  const hasIdentifier = !!identifierMatch;
  const profileCount = filteredProfiles.length;
  const totalItems = (hasIdentifier ? 1 : 0) + profileCount + (hasSpAddress ? 1 : 0) + (hasBtcAddress ? 1 : 0);

  // Track whether the user explicitly dismissed the dropdown (outside-click /
  // Escape) so we don't immediately reopen it on the next render. Tapping the
  // input clears this. We compute the *effective* open state below from this
  // flag plus whether there's anything to show — no setState-in-effect.
  const [dismissed, setDismissed] = useState(false);

  // Reset the keyboard selection highlight whenever the result set changes.
  // Derived during render via the "previous inputs in state" pattern rather
  // than a setState-in-effect (which the lint forbids).
  const resultsKey = `${identifierMatch?.type ?? ''}|${profiles?.map((p) => p.pubkey).join(',') ?? ''}|${hasBtcAddress}|${hasSpAddress}`;
  const [lastResultsKey, setLastResultsKey] = useState<string | null>(null);
  if (resultsKey !== lastResultsKey) {
    setLastResultsKey(resultsKey);
    if (selectedIndex !== -1) setSelectedIndex(-1);
  }

  const selectProfile = useCallback((profile: SearchProfile) => {
    const address = nostrPubkeyToBitcoinAddress(profile.pubkey);
    if (!address) return;
    onChange({ address, kind: 'onchain', pubkey: profile.pubkey, profile, raw: query });
    setQuery('');
    setDismissed(true);
    inputRef.current?.blur();
  }, [onChange, query]);

  const selectPubkey = useCallback((pubkey: string, raw: string) => {
    if (!/^[0-9a-f]{64}$/.test(pubkey)) return;
    const address = nostrPubkeyToBitcoinAddress(pubkey);
    if (!address) return;
    onChange({ address, kind: 'onchain', pubkey, raw });
    setQuery('');
    setDismissed(true);
    inputRef.current?.blur();
  }, [onChange]);

  const selectBtcAddress = useCallback((address: string) => {
    onChange({ address, kind: 'onchain', raw: address });
    setQuery('');
    setDismissed(true);
    inputRef.current?.blur();
  }, [onChange]);

  const selectSpAddress = useCallback((address: string) => {
    onChange({ address, kind: 'sp', raw: address });
    setQuery('');
    setDismissed(true);
    inputRef.current?.blur();
  }, [onChange]);

  // Auto-select when the input resolves to a single unambiguous recipient:
  //   - a bare npub / nprofile / hex pubkey resolves synchronously → chip;
  //   - a bare address or single-endpoint `bitcoin:` URI → chip too.
  // A dual-endpoint URI (both btc and sp valid) keeps the dropdown so the user
  // picks; a `nip05` identifier stays in its row because resolution is async.
  //
  // Run from the input's `onChange` (an event handler) rather than an effect,
  // so we never call setState synchronously inside an effect body. Returns
  // `true` when it committed a recipient (so the caller skips opening the
  // dropdown for that keystroke).
  const tryAutoSelect = useCallback((raw: string): boolean => {
    const trimmed = raw.trim();
    if (!trimmed) return false;

    const match = detectIdentifier(trimmed);
    if (match) {
      if (match.type === 'npub' || match.type === 'nprofile') {
        selectPubkey(match.pubkey, match.raw);
        return true;
      }
      if (match.type === 'hex') {
        selectPubkey(match.hex, match.hex);
        return true;
      }
      // nip05 resolves asynchronously — leave it to IdentifierRow.
      return false;
    }

    const uri = parseBitcoinUri(trimmed);
    const btc = uri ? uri.address : trimmed;
    const sp = uri ? (uri.sp ?? uri.address) : trimmed;
    const validBtc = !!btc && !isSilentPaymentAddress(btc) && validateBitcoinAddress(btc);
    const validSp = !!sp && isSilentPaymentAddress(sp) && validateSilentPaymentAddress(sp);

    if (validBtc && validSp) return false; // dual-endpoint → let user pick
    if (validBtc) {
      selectBtcAddress(btc);
      return true;
    }
    if (validSp) {
      selectSpAddress(sp);
      return true;
    }
    return false;
  }, [selectPubkey, selectBtcAddress, selectSpAddress]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(true);
      inputRef.current?.blur();
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIndex >= 0 && selectedIndex < totalItems) {
        // Order: [identifier?, ...profiles, btcAddress?, spAddress?]
        let idx = selectedIndex;
        if (hasIdentifier) {
          if (idx === 0) {
            const items = popoverContentRef.current?.querySelectorAll('[data-recipient-item]');
            (items?.[selectedIndex] as HTMLElement | undefined)?.click();
            return;
          }
          idx -= 1;
        }
        if (idx < profileCount) {
          selectProfile(filteredProfiles[idx]);
          return;
        }
        idx -= profileCount;
        if (hasBtcAddress && idx === 0) {
          selectBtcAddress(btcCandidate);
          return;
        }
        if (hasBtcAddress) idx -= 1;
        if (hasSpAddress && idx === 0) {
          selectSpAddress(spCandidate);
          return;
        }
      }
      return;
    }

    if (totalItems === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev < totalItems - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : totalItems - 1));
    }
  };

  // ── Selected-chip view ─────────────────────────────────────

  if (value) {
    return <SelectedRecipientChip value={value} onClear={() => onChange(null)} />;
  }

  // ── Input + dropdown ───────────────────────────────────────

  const hasSuggestions = hasIdentifier || hasBtcAddress || hasSpAddress || profileCount > 0 || isFetching;
  const showEmptyState = trimmedRaw.length > 0 && !isFetching && totalItems === 0;
  // Effective open state: show the dropdown when there's something to show and
  // the user hasn't explicitly dismissed it. No setState-in-effect needed —
  // this is fully derived from render state.
  const popoverOpen = !dismissed && trimmedRaw.length > 0 && (hasSuggestions || showEmptyState) && (totalItems > 0 || showEmptyState);

  return (
    <Popover open={popoverOpen} onOpenChange={(next) => { if (!next) setDismissed(true); }}>
      <PopoverAnchor asChild>
        <div className="relative">
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              const next = e.target.value;
              setDismissed(false);
              // Commit immediately on an unambiguous paste/type; otherwise keep
              // the text in the field and let the dropdown surface choices.
              if (!tryAutoSelect(next)) {
                setQuery(next);
              }
            }}
            onFocus={() => setDismissed(false)}
            // Tapping the input reopens the dropdown after an outside-click
            // dismiss. `onFocus` only fires on the first tap; subsequent taps
            // while still focused need their own opener.
            onClick={() => setDismissed(false)}
            onKeyDown={handleKeyDown}
            placeholder="Search people, paste npub, or enter a Bitcoin or sp1… address"
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={popoverOpen}
            aria-haspopup="listbox"
            aria-autocomplete="list"
            className="rounded-full"
          />
        </div>
      </PopoverAnchor>

      <PopoverContent
        ref={popoverContentRef}
        align="start"
        sideOffset={6}
        // Keep typing focus in the input on open/close — Radix's default is to
        // focus the popover content, which would steal focus from the input.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        style={{ width: 'var(--radix-popover-trigger-width)' }}
        className="p-0 w-[--radix-popover-trigger-width] rounded-xl border border-border bg-popover shadow-lg overflow-hidden"
      >
        {totalItems > 0 ? (
          <div role="listbox" className="max-h-[280px] overflow-y-auto py-1">
            {hasIdentifier && (
              <IdentifierRow
                match={identifierMatch!}
                isSelected={selectedIndex === 0}
                onSelectPubkey={selectPubkey}
              />
            )}
            {filteredProfiles.map((profile, i) => (
              <ProfileRow
                key={profile.pubkey}
                profile={profile}
                isSelected={selectedIndex === (hasIdentifier ? i + 1 : i)}
                onClick={selectProfile}
              />
            ))}
            {hasBtcAddress && (
              <BtcAddressRow
                address={btcCandidate}
                isSelected={selectedIndex === (hasIdentifier ? 1 : 0) + profileCount}
                onClick={selectBtcAddress}
              />
            )}
            {hasSpAddress && (
              <SpAddressRow
                address={spCandidate}
                isSelected={selectedIndex === totalItems - 1}
                onClick={selectSpAddress}
              />
            )}
          </div>
        ) : (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No matches. Paste an npub, a Bitcoin address, or a silent payment address.
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Selected recipient chip ───────────────────────────────────

function SelectedRecipientChip({
  value,
  onClear,
}: {
  value: ResolvedRecipient;
  onClear: () => void;
}) {
  const { pubkey, profile, address, kind } = value;
  // Author lookup only when we have a pubkey but no inline profile.
  const author = useAuthor(profile ? undefined : pubkey);
  const metadata = profile?.metadata ?? author.data?.metadata;

  const displayName = pubkey
    ? metadata?.name || metadata?.display_name || 'Anonymous'
    : kind === 'sp'
      ? 'Silent payment address'
      : 'Bitcoin address';

  const subtitle = pubkey
    ? metadata?.nip05 ?? nip19.npubEncode(pubkey)
    : `${address.slice(0, 12)}…${address.slice(-8)}`;

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-muted/40 pl-2 pr-2 py-1.5 w-full min-w-0 max-w-full">
      {pubkey ? (
        <Avatar className="size-9 shrink-0">
          <AvatarImage src={metadata?.picture} alt={displayName} />
          <AvatarFallback className="bg-primary/20 text-primary text-sm">
            {displayName[0]?.toUpperCase() || '?'}
          </AvatarFallback>
        </Avatar>
      ) : kind === 'sp' ? (
        <div className="size-9 shrink-0 rounded-full bg-violet-500/10 flex items-center justify-center">
          <EyeOff className="size-4 text-violet-500" />
        </div>
      ) : (
        <div className="size-9 shrink-0 rounded-full bg-orange-500/10 flex items-center justify-center">
          <Bitcoin className="size-4 text-orange-500" />
        </div>
      )}
      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="text-[11px] text-muted-foreground leading-tight">To</div>
        <div className="text-sm font-medium truncate">{displayName}</div>
        <div className={cn('text-xs text-muted-foreground truncate', !pubkey && 'font-mono')}>
          {subtitle}
        </div>
      </div>
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear recipient"
        className="p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors shrink-0"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

// ── Profile dropdown row ──────────────────────────────────────

function ProfileRow({
  profile,
  isSelected,
  onClick,
}: {
  profile: SearchProfile;
  isSelected: boolean;
  onClick: (profile: SearchProfile) => void;
}) {
  const { metadata, pubkey } = profile;
  const displayName = metadata.name || metadata.display_name || 'Anonymous';
  const subtitle = metadata.nip05 ?? nip19.npubEncode(pubkey);

  return (
    <button
      type="button"
      data-recipient-item
      role="option"
      aria-selected={isSelected}
      onClick={() => onClick(profile)}
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2 text-left transition-colors cursor-pointer',
        isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-secondary/60',
      )}
    >
      <Avatar className="size-9 shrink-0">
        <AvatarImage src={metadata.picture} alt={displayName} />
        <AvatarFallback className="bg-primary/20 text-primary text-sm">
          {displayName[0]?.toUpperCase() || '?'}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm truncate">{displayName}</div>
        <div className={cn('text-xs text-muted-foreground truncate', !metadata.nip05 && 'font-mono')}>
          {subtitle}
        </div>
      </div>
    </button>
  );
}

// ── Identifier (npub / nprofile / nip05 / hex) dropdown row ───

function IdentifierRow({
  match,
  isSelected,
  onSelectPubkey,
}: {
  match: IdentifierMatch;
  isSelected: boolean;
  onSelectPubkey: (pubkey: string, raw: string) => void;
}) {
  // Resolve nip05 → pubkey asynchronously. Other types have the pubkey inline.
  const nip05Id = match.type === 'nip05' ? match.identifier : undefined;
  const { data: nip05Pubkey, isLoading: isResolvingNip05 } = useNip05Resolve(nip05Id);

  const pubkey = match.type === 'npub' || match.type === 'nprofile'
    ? match.pubkey
    : match.type === 'hex'
      ? match.hex
      : nip05Pubkey ?? undefined;

  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const displayName = pubkey
    ? metadata?.name || metadata?.display_name || 'Anonymous'
    : match.type === 'nip05' ? match.identifier : '';

  const subtitle = match.type === 'nip05'
    ? match.identifier
    : pubkey
      ? metadata?.nip05 ?? `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`
      : '';

  const handleClick = useCallback(() => {
    if (!pubkey) return;
    const raw = match.type === 'nip05' ? match.identifier
      : match.type === 'hex' ? match.hex
        : match.raw;
    onSelectPubkey(pubkey, raw);
  }, [pubkey, match, onSelectPubkey]);

  if (isResolvingNip05) {
    return (
      <div
        data-recipient-item
        className={cn(
          'w-full flex items-center gap-3 px-3 py-2 text-left',
          isSelected && 'bg-accent text-accent-foreground',
        )}
      >
        <div className="size-9 shrink-0 rounded-full bg-secondary animate-pulse" />
        <div className="flex-1 min-w-0 space-y-1">
          <div className="h-3.5 w-24 bg-secondary animate-pulse rounded" />
          <div className="h-3 w-32 bg-secondary animate-pulse rounded" />
        </div>
      </div>
    );
  }

  if (!pubkey) {
    // nip05 didn't resolve — drop the row entirely.
    return null;
  }

  return (
    <button
      type="button"
      data-recipient-item
      role="option"
      aria-selected={isSelected}
      onClick={handleClick}
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2 text-left transition-colors cursor-pointer',
        isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-secondary/60',
      )}
    >
      <Avatar className="size-9 shrink-0">
        <AvatarImage src={metadata?.picture} alt={displayName} />
        <AvatarFallback className="bg-primary/20 text-primary text-sm">
          {displayName[0]?.toUpperCase() || '?'}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm truncate">
          {author.isLoading ? (
            <span className="text-muted-foreground">Loading profile…</span>
          ) : (
            displayName
          )}
        </div>
        <div className={cn('text-xs text-muted-foreground truncate', match.type !== 'nip05' && !metadata?.nip05 && 'font-mono')}>
          {subtitle}
        </div>
      </div>
    </button>
  );
}

// ── Raw bitcoin address dropdown row ──────────────────────────

function BtcAddressRow({
  address,
  isSelected,
  onClick,
}: {
  address: string;
  isSelected: boolean;
  onClick: (address: string) => void;
}) {
  return (
    <button
      type="button"
      data-recipient-item
      role="option"
      aria-selected={isSelected}
      onClick={() => onClick(address)}
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2 text-left transition-colors cursor-pointer',
        isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-secondary/60',
      )}
    >
      <div className="size-9 shrink-0 rounded-full bg-orange-500/10 flex items-center justify-center">
        <Bitcoin className="size-4 text-orange-500" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm truncate">Send to Bitcoin address</div>
        <div className="text-xs text-muted-foreground truncate font-mono">
          {address.length > 28 ? `${address.slice(0, 14)}…${address.slice(-10)}` : address}
        </div>
      </div>
    </button>
  );
}

// ── Silent payment address (sp1…) dropdown row ────────────────

/**
 * Dropdown row for BIP-352 silent payment addresses. A distinct label and
 * icon (privacy eye-off) tells the user at a glance that this is a static,
 * unlinkable address rather than a regular Bitcoin scriptPubKey.
 */
function SpAddressRow({
  address,
  isSelected,
  onClick,
}: {
  address: string;
  isSelected: boolean;
  onClick: (address: string) => void;
}) {
  return (
    <button
      type="button"
      data-recipient-item
      role="option"
      aria-selected={isSelected}
      onClick={() => onClick(address)}
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2 text-left transition-colors cursor-pointer',
        isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-secondary/60',
      )}
    >
      <div className="size-9 shrink-0 rounded-full bg-violet-500/10 flex items-center justify-center">
        <EyeOff className="size-4 text-violet-500" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm truncate">Send to silent payment address</div>
        <div className="text-xs text-muted-foreground truncate font-mono">
          {address.length > 28 ? `${address.slice(0, 14)}…${address.slice(-10)}` : address}
        </div>
      </div>
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Success view
// ═══════════════════════════════════════════════════════════════════

interface SuccessViewProps {
  result: SendResult;
  btcPrice: number | undefined;
  onClose: () => void;
}

/**
 * Success view shown after a broadcast lands. Single layout for both raw-address
 * and Nostr-recipient sends — the extension does not have an in-app NIP-73 page
 * to send Nostr-recipient users to, so the "View transaction" link goes straight
 * to mempool.space in both cases.
 */
function SuccessView({ result, btcPrice, onClose }: SuccessViewProps) {
  const { txid, amountSats } = result;
  const usdDisplay = btcPrice ? satsToUSD(amountSats, btcPrice) : '';

  return (
    <div
      role="status"
      aria-live="polite"
      className="relative grid gap-5 px-6 py-8 w-full overflow-hidden text-center"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_50%_35%,hsl(var(--primary)/0.18),transparent_65%)]"
      />

      <div className="relative mx-auto flex size-28 items-center justify-center">
        <span
          aria-hidden
          className="absolute inset-0 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 shadow-lg shadow-orange-500/30"
        />
        <Check className="relative size-14 text-white drop-shadow-sm" strokeWidth={3} aria-hidden />
      </div>

      <div className="grid gap-1">
        <h2 className="text-lg font-semibold tracking-tight">Bitcoin sent</h2>
        <div className="text-4xl font-bold tabular-nums bg-gradient-to-br from-amber-500 to-orange-600 bg-clip-text text-transparent">
          {usdDisplay || `${amountSats.toLocaleString()} sats`}
        </div>
      </div>

      <div className="grid gap-2">
        <Button
          type="button"
          variant="outline"
          asChild
          className="w-full"
        >
          <a
            href={`https://mempool.space/tx/${txid}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink className="size-4 mr-2" />
            View transaction
          </a>
        </Button>
        <Button type="button" onClick={onClose} className="w-full">
          Done
        </Button>
      </div>
    </div>
  );
}
