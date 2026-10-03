/**
 * Bitcoin Taproot helpers — ported from Ditto's lib/bitcoin.ts.
 *
 * The Nostr/Bitcoin connection: both use secp256k1 with 32-byte x-only
 * public keys and BIP-340 Schnorr signatures, so a Nostr pubkey can be
 * used directly as a Taproot internal key with no conversion. See
 * `WALLET.md` and `BITCOIN-SIGNING.md` in the Ditto project for the
 * full spec.
 *
 * Every fetcher takes an ordered `baseUrls` array (Esplora REST roots, e.g.
 * `['https://mempool.space/api', 'https://blockstream.info/api']`) and routes
 * the request through {@link esploraFetch}, which handles per-attempt
 * timeouts, exponential-backoff cool-downs, and ordered failover across
 * endpoints. Callers can also pass an `AbortSignal` (typically from a
 * TanStack Query `queryFn`) to cancel the inflight request.
 *
 * The mempool.space-specific `/v1/prices` endpoint is the one exception —
 * only `mempool.space`-compatible backends expose it. {@link fetchBtcPrice}
 * configures `skipStatuses: [404]` so non-mempool backends (Blockstream's
 * Esplora) coexist in the list without being penalised.
 *
 * The extension hardcodes the default list in `App.tsx` (config) but the
 * user can override per-account.
 *
 * Backed by `@scure/btc-signer` for all Bitcoin-protocol primitives — no
 * `bitcoinjs-lib` / `@bitcoinerlab/secp256k1` / `ecpair` dependency.
 */
import * as btc from '@scure/btc-signer';
import { pubSchnorr } from '@scure/btc-signer/utils.js';
import { nip19 } from 'nostr-tools';
import { esploraFetch } from './esplora';
import {
  decodeSilentPaymentAddress,
  deriveSilentPaymentOutputs,
  encodeSilentPaymentAddress,
  tweakNsecForTaproot,
  type SilentPaymentAddress,
  type SilentPaymentInput,
} from './silentPayments';
import { signBip375Psbt } from './bip375';
import {
  decodePsbt,
  findKeylessRecord,
  parseSpV0Info,
  PSBT_OUT_AMOUNT,
  PSBT_OUT_SCRIPT,
  PSBT_OUT_SP_V0_INFO,
  PSBT_IN_WITNESS_UTXO,
  readU64LE,
} from './psbtv2';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Standard Bitcoin dust limit in satoshis. */
const DUST_LIMIT = 546;

/** Estimated vBytes per P2TR input. */
const VBYTES_PER_INPUT = 57.5;

/** Estimated vBytes per P2TR output. */
const VBYTES_PER_OUTPUT = 43;

/** Estimated vBytes for transaction overhead (version, locktime, etc.). */
const VBYTES_OVERHEAD = 10.5;

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hexToBytes: odd-length string.');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error('hexToBytes: invalid character.');
    out[i] = b;
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += b[i].toString(16).padStart(2, '0');
  }
  return s;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Strict 32-byte hex validator. Rejects anything that isn't exactly 64
 * lowercase-or-uppercase hex characters.
 */
function isValidPubkeyHex(hex: string): boolean {
  return typeof hex === 'string' && /^[0-9a-fA-F]{64}$/.test(hex);
}

/**
 * Quick check: does this hex string look like a PSBTv2?
 *
 * PSBTv2 carries `PSBT_GLOBAL_VERSION = 0xfb` with value `02 00 00 00`. A
 * PSBT's first 5 bytes are the magic `70 73 62 74 ff` (`psbt\xff`); the
 * version field always appears in the globals section, and BIP-370
 * requires it to be present. Scanning the first ~64 bytes for the byte
 * sequence `01 fb 04 02 00 00 00` (key length 1, keytype 0xfb, value
 * length 4, value 2-LE) is a safe heuristic and lets us route without
 * fully parsing.
 *
 * False positives are essentially impossible: the version field is
 * unique by keytype, and a PSBTv0 must NOT carry it.
 */
function looksLikePsbtV2(psbtHex: string): boolean {
  // Cheap pre-check: must start with the PSBT magic.
  if (!psbtHex.toLowerCase().startsWith('70736274ff')) return false;
  const needle = '01fb040200000000'.toLowerCase();
  const head = psbtHex.toLowerCase().slice(0, 256);
  return head.includes(needle.slice(0, needle.length - 2)); // ignore trailing terminator byte
}

// ---------------------------------------------------------------------------
// Taproot output script / address helpers
// ---------------------------------------------------------------------------

/**
 * Derive the P2TR scriptPubKey + bech32m address for a 32-byte x-only key on
 * mainnet. Used by every "what does our P2TR look like?" code path in this
 * file.
 */
function p2trForXOnly(xonly: Uint8Array): { script: Uint8Array; address: string } {
  const pay = btc.p2tr(xonly, undefined, btc.NETWORK);
  if (!pay.script || !pay.address) {
    throw new Error('Failed to derive P2TR payment from x-only key.');
  }
  return { script: pay.script, address: pay.address };
}

/**
 * Encode a Bitcoin scriptPubKey (mainnet) as an address. Returns `undefined`
 * for scripts that can't be expressed as a standard address (e.g. unknown
 * scripts, OP_RETURN data outputs).
 */
function scriptToAddress(script: Uint8Array): string | undefined {
  try {
    const decoded = btc.OutScript.decode(script);
    if (!decoded) return undefined;
    // `btc.OutScript.decode` returns a structurally typed descriptor whose
    // byte fields are typed as the loose `Bytes` (Uint8Array<ArrayBufferLike>).
    // `btc.Address(...).encode` is typed against `Uint8Array<ArrayBuffer>`,
    // which is a stricter sub-shape; the two are interchangeable at runtime,
    // so we narrow the type at this single boundary rather than copying the
    // bytes.
    return btc.Address(btc.NETWORK).encode(
      decoded as Parameters<ReturnType<typeof btc.Address>['encode']>[0],
    );
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Convert a Nostr public key (32-byte hex) to a Bitcoin Taproot (P2TR) address.
// ---------------------------------------------------------------------------

/**
 * Both Nostr and Bitcoin Taproot use secp256k1 with 32-byte x-only public keys
 * (Schnorr / BIP-340), so the key can be used directly as a Taproot internal
 * public key with no mathematical conversion.
 *
 * Returns an empty string if the input is malformed or not a valid x-only key
 * on the secp256k1 curve.
 */
export function nostrPubkeyToBitcoinAddress(pubkeyHex: string): string {
  if (!isValidPubkeyHex(pubkeyHex)) return '';

  try {
    const xonly = hexToBytes(pubkeyHex);
    return p2trForXOnly(xonly).address;
  } catch (error) {
    console.error('Error generating Bitcoin address:', error);
    return '';
  }
}

/**
 * Convert a bech32 `npub1...` identifier to a Bitcoin Taproot (P2TR) address.
 * Decodes the npub to a hex pubkey, then delegates to {@link nostrPubkeyToBitcoinAddress}.
 */
export function npubToBitcoinAddress(npub: string): string {
  const decoded = nip19.decode(npub);
  if (decoded.type !== 'npub') {
    throw new Error('Invalid npub format');
  }
  return nostrPubkeyToBitcoinAddress(decoded.data);
}

// ---------------------------------------------------------------------------
// Balance / Address data (wallet page)
// ---------------------------------------------------------------------------

/** Balance data returned by the Esplora API. */
export interface AddressData {
  /** Confirmed on-chain balance in satoshis. */
  balance: number;
  /** Unconfirmed mempool balance in satoshis. */
  pendingBalance: number;
  /** Sum of confirmed + pending balance. */
  totalBalance: number;
  /** Total satoshis ever received (confirmed). */
  totalReceived: number;
  /** Total satoshis ever sent (confirmed). */
  totalSent: number;
  /** Confirmed transaction count. */
  txCount: number;
  /** Pending (mempool) transaction count. */
  pendingTxCount: number;
}

/**
 * Fetch balance and transaction stats for a Bitcoin address from an
 * Esplora-compatible REST API (e.g. mempool.space, Blockstream).
 *
 * @param address    The Bitcoin address to look up.
 * @param baseUrls   Ordered list of Esplora REST roots tried with failover.
 * @param signal     Optional abort signal (e.g. from TanStack Query).
 */
export async function fetchAddressData(
  address: string,
  baseUrls: string[],
  signal?: AbortSignal,
): Promise<AddressData> {
  const response = await esploraFetch(baseUrls, `/address/${address}`, { signal, retryStatuses: [404] });

  if (!response.ok) {
    throw new Error('Failed to fetch balance');
  }

  const data = await response.json();

  const confirmedBalance = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
  const pendingBalance = data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;

  return {
    balance: confirmedBalance,
    pendingBalance,
    totalBalance: confirmedBalance + pendingBalance,
    totalReceived: data.chain_stats.funded_txo_sum,
    totalSent: data.chain_stats.spent_txo_sum,
    txCount: data.chain_stats.tx_count,
    pendingTxCount: data.mempool_stats.tx_count,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Convert satoshis to a BTC string with up to 8 decimal places. */
export function satsToBTC(sats: number): string {
  return (sats / 100_000_000).toFixed(8);
}

/**
 * Convert satoshis to a BTC string with trailing zeros stripped.
 * E.g. `formatBTC(100_000_000)` → `"1"`, `formatBTC(1_234_560)` → `"0.0123456"`.
 */
export function formatBTC(sats: number): string {
  return satsToBTC(sats).replace(/\.?0+$/, '');
}

/** Format a satoshi amount with locale-aware thousand separators. */
export function formatSats(sats: number): string {
  return sats.toLocaleString();
}

/**
 * Fetch the current BTC price in USD from a mempool.space-compatible API.
 *
 * Note: the `/v1/prices` endpoint is a mempool.space extension to the
 * standard Esplora REST surface. Backends like Blockstream's Esplora do
 * not expose it — those endpoints return `404` and the failover client
 * silently advances to the next URL (without penalising the endpoint).
 *
 * @param baseUrls   Ordered list of Esplora REST roots tried with failover.
 * @param signal     Optional abort signal (e.g. from TanStack Query).
 */
export async function fetchBtcPrice(baseUrls: string[], signal?: AbortSignal): Promise<number> {
  const response = await esploraFetch(baseUrls, `/v1/prices`, {
    // /v1/prices is a mempool.space extension — 404 means "endpoint doesn't
    // speak this path", not "the endpoint is dead". Soft-failover to the
    // next URL without putting this one in cool-down.
    skipStatuses: [404],
    signal,
  });

  if (!response.ok) {
    throw new Error('Failed to fetch BTC price');
  }

  const data = await response.json();
  const usd = Number(data?.USD);
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error('Invalid BTC price response');
  }
  return usd;
}

/** Convert a BTC amount to satoshis (rounded to nearest integer). */
export function btcToSats(btc: number): number {
  return Math.round(btc * 100_000_000);
}

/**
 * USD threshold above which Bitcoin send/zap flows require explicit
 * confirmation (two-tap). Chosen to catch meaningful dollar amounts without
 * nagging on everyday $5–$25 zaps.
 */
export const LARGE_AMOUNT_USD_THRESHOLD = 100;

/**
 * Whether a given satoshi amount crosses the "large amount" threshold at the
 * current BTC/USD price. Returns false when `btcPrice` is unavailable, so the
 * UI does not arm confirmation without a known USD value.
 */
export function isLargeAmount(sats: number, btcPrice: number | undefined): boolean {
  if (!btcPrice || !Number.isFinite(btcPrice) || btcPrice <= 0) return false;
  if (!Number.isFinite(sats) || sats <= 0) return false;
  const usd = (sats / 100_000_000) * btcPrice;
  return usd >= LARGE_AMOUNT_USD_THRESHOLD;
}

/** Convert satoshis to USD given a BTC price. */
export function satsToUSD(sats: number, btcPrice: number): string {
  const btc = sats / 100_000_000;
  return (btc * btcPrice).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ---------------------------------------------------------------------------
// Wallet-page transaction list (simplified per-address view)
// ---------------------------------------------------------------------------

/** A simplified transaction relevant to a specific address. */
export interface Transaction {
  /** Transaction ID (hex). */
  txid: string;
  /** Net satoshi change for the address (positive = received, negative = sent). */
  amount: number;
  /** Whether this is a receive or send relative to the address. */
  type: 'receive' | 'send';
  /** Whether the transaction is confirmed. */
  confirmed: boolean;
  /** Unix timestamp of the block (undefined if unconfirmed). */
  timestamp?: number;
}

/**
 * Fetch transactions for a Bitcoin address from an Esplora-compatible API.
 * Returns simplified transactions with net amount relative to the address.
 *
 * @param address    The Bitcoin address to look up.
 * @param baseUrls   Ordered list of Esplora REST roots tried with failover.
 * @param signal     Optional abort signal (e.g. from TanStack Query).
 */
export async function fetchTransactions(
  address: string,
  baseUrls: string[],
  signal?: AbortSignal,
): Promise<Transaction[]> {
  const response = await esploraFetch(baseUrls, `/address/${address}/txs`, { signal, retryStatuses: [404] });

  if (!response.ok) {
    throw new Error('Failed to fetch transactions');
  }

  const txs = await response.json();

  return txs.map((tx: Record<string, unknown>) => {
    const vin = tx.vin as Array<{ prevout: { scriptpubkey_address?: string; value: number } | null }>;
    const vout = tx.vout as Array<{ scriptpubkey_address?: string; value: number }>;
    const status = tx.status as { confirmed: boolean; block_time?: number };

    // Sum sats flowing out of this address (inputs we owned)
    const totalIn = vin.reduce((sum, input) => {
      if (input.prevout?.scriptpubkey_address === address) {
        return sum + input.prevout.value;
      }
      return sum;
    }, 0);

    // Sum sats flowing into this address (outputs we own)
    const totalOut = vout.reduce((sum, output) => {
      if (output.scriptpubkey_address === address) {
        return sum + output.value;
      }
      return sum;
    }, 0);

    const net = totalOut - totalIn;

    return {
      txid: tx.txid as string,
      amount: Math.abs(net),
      type: net >= 0 ? 'receive' : 'send',
      confirmed: status.confirmed,
      timestamp: status.block_time,
    } satisfies Transaction;
  });
}

// ---------------------------------------------------------------------------
// Full transaction detail (Esplora /tx/<txid>)
// ---------------------------------------------------------------------------

/** A single input in a full transaction. */
export interface TxInput {
  txid: string;
  vout: number;
  address?: string;
  value: number;
  isCoinbase: boolean;
}

/** A single output in a full transaction. */
export interface TxOutput {
  address?: string;
  value: number;
  scriptpubkeyType: string;
  /** True if the output has been spent. */
  spent: boolean;
}

/** Full transaction detail returned by the Esplora API. */
export interface TxDetail {
  txid: string;
  version: number;
  locktime: number;
  size: number;
  weight: number;
  fee: number;
  confirmed: boolean;
  blockHeight?: number;
  blockHash?: string;
  blockTime?: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  /** Total value of all inputs (sats). */
  totalInput: number;
  /** Total value of all outputs (sats). */
  totalOutput: number;
}

/**
 * Fetch full transaction details from an Esplora-compatible API.
 *
 * @param txid       The transaction ID (hex).
 * @param baseUrls   Ordered list of Esplora REST roots tried with failover.
 * @param signal     Optional abort signal (e.g. from TanStack Query).
 */
export async function fetchTxDetail(
  txid: string,
  baseUrls: string[],
  signal?: AbortSignal,
): Promise<TxDetail> {
  const response = await esploraFetch(baseUrls, `/tx/${txid}`, { signal });
  if (!response.ok) throw new Error('Failed to fetch transaction');

  const tx = await response.json();

  const vin = tx.vin as Array<{
    txid: string;
    vout: number;
    prevout: { scriptpubkey_address?: string; value: number } | null;
    is_coinbase: boolean;
  }>;
  const vout = tx.vout as Array<{
    scriptpubkey_address?: string;
    value: number;
    scriptpubkey_type: string;
  }>;
  const status = tx.status as { confirmed: boolean; block_height?: number; block_hash?: string; block_time?: number };

  const inputs: TxInput[] = vin.map((input) => ({
    txid: input.txid,
    vout: input.vout,
    address: input.prevout?.scriptpubkey_address,
    value: input.prevout?.value ?? 0,
    isCoinbase: input.is_coinbase,
  }));

  const outputs: TxOutput[] = vout.map((output) => ({
    address: output.scriptpubkey_address,
    value: output.value,
    scriptpubkeyType: output.scriptpubkey_type,
    spent: false, // Esplora /tx endpoint doesn't include spending info
  }));

  const totalInput = inputs.reduce((sum, i) => sum + i.value, 0);
  const totalOutput = outputs.reduce((sum, o) => sum + o.value, 0);

  return {
    txid: tx.txid as string,
    version: tx.version as number,
    locktime: tx.locktime as number,
    size: tx.size as number,
    weight: tx.weight as number,
    fee: tx.fee as number,
    confirmed: status.confirmed,
    blockHeight: status.block_height,
    blockHash: status.block_hash,
    blockTime: status.block_time,
    inputs,
    outputs,
    totalInput,
    totalOutput,
  };
}

// ---------------------------------------------------------------------------
// Full address detail (combined balance + recent transactions)
// ---------------------------------------------------------------------------

/** Full address detail combining balance stats + recent transactions. */
export interface AddressDetail {
  address: string;
  balance: number;
  pendingBalance: number;
  totalBalance: number;
  totalReceived: number;
  totalSent: number;
  txCount: number;
  pendingTxCount: number;
  /** Most recent transactions (up to 25). */
  recentTxs: Transaction[];
}

/**
 * Fetch full address details (balance + recent txs) from an Esplora-compatible API.
 *
 * @param address    The Bitcoin address to look up.
 * @param baseUrls   Ordered list of Esplora REST roots tried with failover.
 * @param signal     Optional abort signal (e.g. from TanStack Query).
 */
export async function fetchAddressDetail(
  address: string,
  baseUrls: string[],
  signal?: AbortSignal,
): Promise<AddressDetail> {
  const [addrData, txs] = await Promise.all([
    fetchAddressData(address, baseUrls, signal),
    fetchTransactions(address, baseUrls, signal),
  ]);

  return {
    address,
    ...addrData,
    recentTxs: txs.slice(0, 25),
  };
}

// ---------------------------------------------------------------------------
// Sending: UTXOs, fee estimation, transaction construction, broadcast
// ---------------------------------------------------------------------------

/** An unspent transaction output. */
export interface UTXO {
  txid: string;
  vout: number;
  /** Value in satoshis. */
  value: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
}

/**
 * Fetch UTXOs for a Bitcoin address from an Esplora-compatible API.
 *
 * @param address    The Bitcoin address to look up.
 * @param baseUrls   Ordered list of Esplora REST roots tried with failover.
 * @param signal     Optional abort signal (e.g. from TanStack Query).
 */
export async function fetchUTXOs(
  address: string,
  baseUrls: string[],
  signal?: AbortSignal,
): Promise<UTXO[]> {
  const response = await esploraFetch(baseUrls, `/address/${address}/utxo`, { signal, retryStatuses: [404] });
  if (!response.ok) throw new Error('Failed to fetch UTXOs');
  return response.json();
}

/** Fee rate estimates keyed by confirmation speed. */
export interface FeeRates {
  /** ~10 min / next block (target 1). */
  fastestFee: number;
  /** ~30 min (target 3). */
  halfHourFee: number;
  /** ~1 hour (target 6). */
  hourFee: number;
  /** ~1 day (target 144). */
  economyFee: number;
  /** Minimum relay fee (target 504). */
  minimumFee: number;
}

/**
 * Fetch recommended fee rates (sat/vB) from an Esplora-compatible API.
 *
 * @param baseUrls   Ordered list of Esplora REST roots tried with failover.
 * @param signal     Optional abort signal (e.g. from TanStack Query).
 */
export async function getFeeRates(baseUrls: string[], signal?: AbortSignal): Promise<FeeRates> {
  // `/fee-estimates` is always present on a healthy Esplora backend, so a 404
  // never means "not found" — it means the endpoint is misbehaving (notably
  // mempool.space serving 404 instead of 429 to rate-limited clients). Treat
  // it as a retryable failure so we fail over to the next endpoint instead of
  // trusting the 404 and giving up.
  const response = await esploraFetch(baseUrls, `/fee-estimates`, { signal, retryStatuses: [404] });
  if (!response.ok) throw new Error('Failed to fetch fee estimates');

  const data = await response.json();

  return {
    fastestFee: sanitizeFeeRate(data?.['1']),
    halfHourFee: sanitizeFeeRate(data?.['3']),
    hourFee: sanitizeFeeRate(data?.['6']),
    economyFee: sanitizeFeeRate(data?.['144']),
    minimumFee: sanitizeFeeRate(data?.['504']),
  };
}

/**
 * Highest fee rate we will accept from a remote endpoint, in sat/vB. Well
 * above any real congestion (mainnet peaks have not passed ~2000 sat/vB) and
 * far below anything that could quietly consume a wallet.
 */
const MAX_PLAUSIBLE_FEE_RATE = 5_000;

/**
 * Coerce a fee rate from an Esplora `/fee-estimates` response to a usable
 * sat/vB number, falling back to 1 for anything implausible.
 *
 * The endpoint is operator-chosen and user-editable, and this used to be
 * `Math.ceil(data['1'] || 1)`. `||` only catches *falsy* values, so a missing
 * key was safe but a truthy non-number — `{"1": "5"}`, `{"1": {"fee": 5}}`,
 * the sort of thing an API-version mismatch produces — yielded `NaN`. NaN then
 * passed every downstream guard, because they are all `<` / `>=` comparisons
 * and every comparison with NaN is false: no change output was added, nothing
 * threw, the balance check passed, and the UI rendered "Fee 0" because `!NaN`
 * is true. The result was a valid, broadcastable transaction that paid the
 * wallet's entire remaining balance to miners.
 */
function sanitizeFeeRate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  if (value < 1) return 1;
  if (value > MAX_PLAUSIBLE_FEE_RATE) return MAX_PLAUSIBLE_FEE_RATE;
  return Math.ceil(value);
}

/**
 * Estimate the fee for a P2TR transaction in satoshis.
 *
 * @param numInputs  Number of Taproot inputs.
 * @param numOutputs Number of outputs (recipient + optional change).
 * @param feeRate    Fee rate in sat/vB.
 */
export function estimateFee(numInputs: number, numOutputs: number, feeRate: number): number {
  // Assert rather than infer. A non-finite rate produces a NaN fee, and every
  // guard downstream of this is a `<` or `>=` comparison, all of which are
  // false for NaN — so the failure surfaces as a transaction that hands the
  // wallet's balance to miners rather than as an error.
  if (!Number.isFinite(feeRate) || feeRate < 1) {
    throw new Error(`Invalid fee rate: ${feeRate} sat/vB.`);
  }
  const vBytes = numInputs * VBYTES_PER_INPUT + numOutputs * VBYTES_PER_OUTPUT + VBYTES_OVERHEAD;
  return Math.ceil(vBytes * feeRate);
}

/**
 * Validate a Bitcoin address (mainnet). Returns `true` if the address has a
 * valid format and checksum, `false` otherwise.
 */
export function validateBitcoinAddress(address: string): boolean {
  try {
    btc.Address(btc.NETWORK).decode(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parsed BIP-21 payment URI.
 *
 * `address` is the on-chain fallback (the URI's path); `sp` is the BIP-352
 * silent payment recipient if the URI included a valid `sp=` parameter;
 * `amountSats` is the BIP-21 `amount=` parameter converted from BTC to
 * satoshis. Other BIP-21 parameters (`label`, `message`, `lightning`, …) are
 * not surfaced — we have no lightning support to fall back to.
 */
export interface ParsedBitcoinUri {
  /** On-chain address from the URI path. May be empty for sp-only URIs. */
  address: string;
  /** BIP-352 silent payment address from the `sp=` parameter, if present. */
  sp?: string;
  /**
   * Amount in satoshis, parsed from the BIP-21 `amount=` parameter (which is
   * specified in BTC). Undefined when the URI has no amount or the value is
   * malformed / non-positive / non-finite. Rounded down to whole sats so we
   * never overstate the requester's intent.
   */
  amountSats?: number;
}

/**
 * Parse a `bitcoin:` BIP-21 URI without committing to any particular address
 * format. Returns `null` for anything that isn't `bitcoin:…`.
 *
 * The scheme check is case-insensitive (`bitcoin:` and `BITCOIN:` both parse).
 * Validation of the address/sp values is left to the caller — this helper
 * just splits the URI into its parts.
 */
export function parseBitcoinUri(input: string): ParsedBitcoinUri | null {
  const trimmed = input.trim();
  if (!/^bitcoin:/i.test(trimmed)) return null;

  const payload = trimmed.slice('bitcoin:'.length);
  const qIdx = payload.indexOf('?');
  const address = (qIdx === -1 ? payload : payload.slice(0, qIdx)).trim();

  let sp: string | undefined;
  let amountSats: number | undefined;
  if (qIdx !== -1) {
    // URLSearchParams handles percent-decoding and repeated keys.
    const params = new URLSearchParams(payload.slice(qIdx + 1));
    sp = params.get('sp')?.trim() || undefined;

    const amountRaw = params.get('amount')?.trim();
    if (amountRaw) {
      const amountBtc = Number(amountRaw);
      if (Number.isFinite(amountBtc) && amountBtc > 0) {
        // Round down — never overstate the requested amount.
        amountSats = Math.floor(amountBtc * 100_000_000);
      }
    }
  }

  return { address, sp, amountSats };
}

/**
 * Broadcast a signed transaction hex to the Bitcoin network via an
 * Esplora-compatible API. Returns the txid.
 *
 * Broadcast is idempotent at the Bitcoin protocol layer — re-broadcasting a
 * tx that's already in mempool is harmless — so we let the failover client
 * retry across endpoints normally. The first endpoint that accepts the tx
 * wins.
 *
 * @param txHex      The signed transaction hex.
 * @param baseUrls   Ordered list of Esplora REST roots tried with failover.
 * @param signal     Optional abort signal (e.g. from TanStack Query).
 */
export async function broadcastTransaction(
  txHex: string,
  baseUrls: string[],
  signal?: AbortSignal,
): Promise<string> {
  const response = await esploraFetch(baseUrls, `/tx`, {
    method: 'POST',
    body: txHex,
    signal,
    // A 404 on broadcast is never a legitimate "not found" — fail over.
    retryStatuses: [404],
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Broadcast failed: ${body}`);
  }

  return response.text();
}

/**
 * Compute the maximum sendable amount (in sats) after fees.
 *
 * @param totalBalance Total spendable sats across all UTXOs.
 * @param numInputs    Number of UTXOs that will be consumed.
 * @param feeRate      Fee rate in sat/vB.
 * @returns The max amount in sats, or 0 if the balance cannot cover fees.
 */
export function maxSendable(totalBalance: number, numInputs: number, feeRate: number): number {
  // When sending max there is no change output, so only 1 output.
  const fee = estimateFee(numInputs, 1, feeRate);
  return Math.max(0, totalBalance - fee);
}

/** Result of building an unsigned PSBT. */
export interface UnsignedPsbt {
  /** Hex-encoded unsigned PSBT. */
  psbtHex: string;
  /** Fee in satoshis. */
  fee: number;
}

/**
 * Add a single Taproot input that we own to a `btc.Transaction`. The input's
 * `tapInternalKey` is the signer's x-only Nostr key; `@scure/btc-signer`
 * applies the BIP-341 tweak at sign-time.
 */
function addOwnedTaprootInput(
  tx: btc.Transaction,
  utxo: UTXO,
  internalKey: Uint8Array,
  script: Uint8Array,
): void {
  tx.addInput({
    txid: hexToBytes(utxo.txid),
    index: utxo.vout,
    witnessUtxo: {
      script,
      amount: BigInt(utxo.value),
    },
    tapInternalKey: internalKey,
  });
}

/**
 * Build an unsigned Taproot PSBT ready for signing.
 *
 * This function constructs the PSBT with all inputs and outputs but does NOT
 * sign it. The returned hex can be passed to any signer (local nsec, NIP-07
 * extension, or NIP-46 remote signer).
 *
 * @param senderPubkeyHex 32-byte hex x-only public key of the sender.
 * @param toAddress       Recipient Bitcoin address.
 * @param amountSats      Amount to send in satoshis.
 * @param utxos           Available UTXOs (all will be consumed).
 * @param feeRate         Fee rate in sat/vB.
 */
export function buildUnsignedPsbt(
  senderPubkeyHex: string,
  toAddress: string,
  amountSats: number,
  utxos: UTXO[],
  feeRate: number,
): UnsignedPsbt {
  const internalPubkey = hexToBytes(senderPubkeyHex);
  const { script: ourScript, address: changeAddress } = p2trForXOnly(internalPubkey);

  const tx = new btc.Transaction();
  let totalInput = 0;

  for (const utxo of utxos) {
    addOwnedTaprootInput(tx, utxo, internalPubkey, ourScript);
    totalInput += utxo.value;
  }

  // Estimate fee — first assume 2 outputs (recipient + change). Change at the
  // dust limit exactly is still standard, so use >= (not >) per BIP-141/P2TR
  // relay policy (minimum non-dust output is 546 sats).
  const change2Out = totalInput - amountSats - estimateFee(utxos.length, 2, feeRate);
  const hasChange = change2Out >= DUST_LIMIT;
  const numOutputs = hasChange ? 2 : 1;
  const fee = estimateFee(utxos.length, numOutputs, feeRate);
  const change = totalInput - amountSats - fee;

  if (change < 0) {
    throw new Error(
      `Insufficient funds. Need ${(amountSats + fee).toLocaleString()} sats, have ${totalInput.toLocaleString()} sats.`,
    );
  }

  // Add outputs
  tx.addOutputAddress(toAddress, BigInt(amountSats), btc.NETWORK);

  if (hasChange) {
    tx.addOutputAddress(changeAddress, BigInt(change), btc.NETWORK);
  }

  return { psbtHex: bytesToHex(tx.toPSBT()), fee };
}

/** A single recipient output for a multi-output PSBT. */
export interface PsbtRecipient {
  /** Bitcoin address to pay. */
  address: string;
  /** Amount to send to this address in satoshis. */
  amountSats: number;
}

/**
 * Build an unsigned Taproot PSBT with multiple recipient outputs.
 *
 * Same flow as {@link buildUnsignedPsbt} but produces a single transaction
 * paying many recipients in one broadcast. Used by the "zap all" flow where
 * the sender wants to tip every member of a NIP-51 follow set / pack with one
 * signature and one network fee.
 *
 * Per-recipient amounts MUST each be at or above {@link DUST_LIMIT} (546 sats);
 * dust outputs are rejected by Bitcoin's standardness rules and the whole tx
 * would fail to broadcast. The caller is responsible for filtering small
 * recipients or bumping their amounts before calling this.
 *
 * @param senderPubkeyHex 32-byte hex x-only public key of the sender.
 * @param recipients      List of recipient (address, amountSats) pairs.
 * @param utxos           Available UTXOs (all will be consumed).
 * @param feeRate         Fee rate in sat/vB.
 */
export function buildUnsignedPsbtMulti(
  senderPubkeyHex: string,
  recipients: PsbtRecipient[],
  utxos: UTXO[],
  feeRate: number,
): UnsignedPsbt {
  if (recipients.length === 0) throw new Error('At least one recipient is required.');

  for (const r of recipients) {
    if (!Number.isFinite(r.amountSats) || r.amountSats < DUST_LIMIT) {
      throw new Error(
        `Each recipient must receive at least ${DUST_LIMIT} sats (dust limit). Got ${r.amountSats}.`,
      );
    }
  }

  const internalPubkey = hexToBytes(senderPubkeyHex);
  const { script: ourScript, address: changeAddress } = p2trForXOnly(internalPubkey);

  const tx = new btc.Transaction();
  let totalInput = 0;

  for (const utxo of utxos) {
    addOwnedTaprootInput(tx, utxo, internalPubkey, ourScript);
    totalInput += utxo.value;
  }

  const totalOut = recipients.reduce((s, r) => s + r.amountSats, 0);

  // Estimate fee — first assume N + 1 outputs (recipients + change).
  const numRecipients = recipients.length;
  const feeWithChange = estimateFee(utxos.length, numRecipients + 1, feeRate);
  const changeWithBoth = totalInput - totalOut - feeWithChange;
  const hasChange = changeWithBoth >= DUST_LIMIT;
  const numOutputs = hasChange ? numRecipients + 1 : numRecipients;
  const fee = estimateFee(utxos.length, numOutputs, feeRate);
  const change = totalInput - totalOut - fee;

  if (change < 0) {
    throw new Error(
      `Insufficient funds. Need ${(totalOut + fee).toLocaleString()} sats, have ${totalInput.toLocaleString()} sats.`,
    );
  }

  for (const r of recipients) {
    tx.addOutputAddress(r.address, BigInt(r.amountSats), btc.NETWORK);
  }

  if (hasChange) {
    tx.addOutputAddress(changeAddress, BigInt(change), btc.NETWORK);
  }

  return { psbtHex: bytesToHex(tx.toPSBT()), fee };
}

/**
 * Sign a PSBT locally using a raw private key (nsec).
 *
 * Applies the BIP-341 TapTweak to the private key, signs all inputs whose
 * `tapInternalKey` matches, and returns the signed (but not finalized) PSBT hex.
 *
 * If the input is a BIP-375 PSBTv2 carrying silent-payment outputs
 * (`PSBT_OUT_SP_V0_INFO`), we route through the BIP-375 signer flow which
 * additionally computes ECDH shares, generates DLEQ proofs, and writes the
 * derived `PSBT_OUT_SCRIPT` for each SP output before signing.
 *
 * @param psbtHex       Hex-encoded unsigned PSBT (v0 or BIP-375 v2).
 * @param privateKeyHex 32-byte hex private key.
 * @returns Hex-encoded signed PSBT (not finalized).
 */
export function signPsbtLocal(psbtHex: string, privateKeyHex: string): string {
  // Detect BIP-375 PSBTv2 quickly by sniffing the version byte. Full
  // detection happens inside `signBip375Psbt`; this just routes.
  if (looksLikePsbtV2(psbtHex)) {
    const { psbtHex: signed } = signBip375Psbt(psbtHex, privateKeyHex);
    return signed;
  }

  const tx = btc.Transaction.fromPSBT(hexToBytes(psbtHex));
  const privKey = hexToBytes(privateKeyHex);
  const internalPubkey = pubSchnorr(privKey);

  // Per the NIP spec: inputs whose `tapInternalKey` does not match the
  // signer's x-only pubkey MUST be left unchanged. This matters for future
  // multi-signer PSBTs; today `buildUnsignedPsbt` only ever adds the user's
  // own UTXOs, so in practice every input matches.
  //
  // `signIdx` handles the BIP-341 parity-flip + TapTweak internally when the
  // input has `tapInternalKey` set, so we pass the raw nsec scalar.
  let signedAny = false;
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    const inputInternalKey = input.tapInternalKey;
    if (!inputInternalKey || !equalBytes(inputInternalKey, internalPubkey)) {
      continue;
    }
    if (tx.signIdx(privKey, i)) {
      signedAny = true;
    }
  }

  if (!signedAny) {
    throw new Error('No inputs in this PSBT are owned by the signer.');
  }

  return bytesToHex(tx.toPSBT());
}

/**
 * Finalize a signed PSBT and extract the raw transaction hex.
 *
 * @param psbtHex Hex-encoded signed PSBT.
 * @returns Raw transaction hex ready for broadcast.
 */
export function finalizePsbt(psbtHex: string): string {
  const tx = btc.Transaction.fromPSBT(hexToBytes(psbtHex));
  tx.finalize();
  return bytesToHex(tx.extract());
}

/**
 * Create, sign, and return a raw Bitcoin Taproot transaction.
 *
 * Convenience wrapper that calls {@link buildUnsignedPsbt},
 * {@link signPsbtLocal}, and {@link finalizePsbt} in sequence.
 *
 * @param privateKeyHex 32-byte hex private key (from Nostr nsec).
 * @param toAddress     Recipient Bitcoin address.
 * @param amountSats    Amount to send in satoshis.
 * @param utxos         Available UTXOs (all will be consumed).
 * @param feeRate       Fee rate in sat/vB.
 * @returns The signed transaction hex and the fee paid.
 */
export function createBitcoinTransaction(
  privateKeyHex: string,
  toAddress: string,
  amountSats: number,
  utxos: UTXO[],
  feeRate: number,
): { txHex: string; fee: number } {
  // Derive the x-only pubkey from the private key for buildUnsignedPsbt
  const internalPubkey = pubSchnorr(hexToBytes(privateKeyHex));
  const senderPubkeyHex = bytesToHex(internalPubkey);

  const { psbtHex, fee } = buildUnsignedPsbt(senderPubkeyHex, toAddress, amountSats, utxos, feeRate);
  const signedHex = signPsbtLocal(psbtHex, privateKeyHex);
  const txHex = finalizePsbt(signedHex);

  return { txHex, fee };
}

// ---------------------------------------------------------------------------
// PSBT inspection (for the extension prompt UI)
// ---------------------------------------------------------------------------
//
// Used by the extension's NIP-07 `signPsbt` confirmation prompt to render a
// human-readable summary of what the signer is about to authorise. Lives in
// the extension because the Ditto web app never has a third party hand it a
// raw PSBT to sign — every PSBT it touches it built itself.

export interface PsbtSummaryInput {
  /** Address of the input, if derivable from `witnessUtxo`. */
  address?: string;
  /** Value in sats, if derivable. */
  value?: number;
  /** Whether this input belongs to the active signer. */
  isOurs: boolean;
}

export interface PsbtSummaryOutput {
  address?: string;
  value: number;
  /** Whether this output is going to the active signer's own address. */
  isChange: boolean;
  /**
   * If the output is a BIP-375 silent-payment output (carries
   * `PSBT_OUT_SP_V0_INFO`), the recipient's `sp1…` / `tsp1…` address — the
   * intent the user sees in the prompt, even when the on-chain P2TR address
   * has not been derived yet.
   */
  silentPaymentAddress?: string;
}

export interface PsbtSummary {
  inputs: PsbtSummaryInput[];
  outputs: PsbtSummaryOutput[];
  /** Sum of input values, if every witnessUtxo is present. */
  totalInput?: number;
  /** Sum of output values. */
  totalOutput: number;
  /** totalInput - totalOutput, when totalInput is known. */
  fee?: number;
  /** Net debit for the signer (sats sent away). */
  netDebit?: number;
}

/**
 * Decode a PSBT and produce a human-readable summary scoped to a specific
 * signer pubkey. Used by the prompt window to render a confirmation view
 * for `signPsbt` calls without finalizing or signing anything.
 *
 * The signer pubkey is the 32-byte x-only Nostr pubkey (hex). Inputs and
 * outputs whose script matches the P2TR derived from this key are flagged
 * as "ours".
 */
export function summarizePsbt(psbtHex: string, signerPubkeyHex: string): PsbtSummary {
  if (looksLikePsbtV2(psbtHex)) {
    return summarizeBip375Psbt(psbtHex, signerPubkeyHex);
  }
  const tx = btc.Transaction.fromPSBT(hexToBytes(psbtHex));

  let ourScriptHex = '';
  let ourAddress = '';
  if (isValidPubkeyHex(signerPubkeyHex)) {
    const internalPubkey = hexToBytes(signerPubkeyHex);
    try {
      const { script, address } = p2trForXOnly(internalPubkey);
      ourScriptHex = bytesToHex(script);
      ourAddress = address;
    } catch {
      // Invalid x-only key (not on curve) — leave ourScriptHex / ourAddress
      // empty, so nothing matches.
    }
  }

  const inputs: PsbtSummaryInput[] = [];
  let totalInput = 0;
  let allKnown = true;
  for (let i = 0; i < tx.inputsLength; i++) {
    const data = tx.getInput(i);
    const wu = data.witnessUtxo;
    if (!wu) {
      allKnown = false;
      inputs.push({ isOurs: false });
      continue;
    }
    const value = Number(wu.amount);
    const address = scriptToAddress(wu.script);
    const isOurs = ourScriptHex
      ? bytesToHex(wu.script) === ourScriptHex
      : false;
    totalInput += value;
    inputs.push({ address, value, isOurs });
  }

  const outputs: PsbtSummaryOutput[] = [];
  let totalOutput = 0;
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i);
    const value = Number(out.amount ?? 0n);
    totalOutput += value;
    const address = out.script ? scriptToAddress(out.script) : undefined;
    const isChange = !!ourAddress && address === ourAddress;
    outputs.push({ address, value, isChange });
  }

  const fee = allKnown ? totalInput - totalOutput : undefined;
  // Net debit = sum of values *leaving* our address (input from us minus
  // change back to us). When inputs are unknown we can't compute this.
  let netDebit: number | undefined;
  if (allKnown) {
    const inFromUs = inputs
      .filter((i) => i.isOurs)
      .reduce((s, i) => s + (i.value ?? 0), 0);
    const backToUs = outputs
      .filter((o) => o.isChange)
      .reduce((s, o) => s + o.value, 0);
    netDebit = inFromUs - backToUs;
  }

  return {
    inputs,
    outputs,
    totalInput: allKnown ? totalInput : undefined,
    totalOutput,
    fee,
    netDebit,
  };
}

/**
 * Summarize a BIP-375 PSBTv2 for the prompt UI.
 *
 * Mirrors {@link summarizePsbt} but reads the wire format with our minimal
 * PSBTv2 codec. SP outputs are surfaced with the recipient's bech32m
 * `sp1…` address — the intent the user is approving — even before the
 * on-chain P2TR script has been derived.
 */
function summarizeBip375Psbt(psbtHex: string, signerPubkeyHex: string): PsbtSummary {
  const psbt = decodePsbt(psbtHex);

  let ourScriptHex = '';
  let ourAddress = '';
  if (isValidPubkeyHex(signerPubkeyHex)) {
    const internalPubkey = hexToBytes(signerPubkeyHex);
    try {
      const { script, address } = p2trForXOnly(internalPubkey);
      ourScriptHex = bytesToHex(script);
      ourAddress = address;
    } catch {
      // ignore — nothing matches.
    }
  }

  const inputs: PsbtSummaryInput[] = [];
  let totalInput = 0;
  let allKnown = true;
  for (const section of psbt.inputs) {
    const wuRec = findKeylessRecord(section, PSBT_IN_WITNESS_UTXO);
    if (!wuRec) {
      allKnown = false;
      inputs.push({ isOurs: false });
      continue;
    }
    // Layout: amount (8 LE) || varint scriptLen || script.
    const amount = Number(readU64LE(wuRec.value.slice(0, 8)));
    let off = 8;
    const tag = wuRec.value[off++];
    let scriptLen = 0;
    if (tag < 0xfd) {
      scriptLen = tag;
    } else if (tag === 0xfd) {
      scriptLen = wuRec.value[off] | (wuRec.value[off + 1] << 8);
      off += 2;
    } else if (tag === 0xfe) {
      scriptLen =
        wuRec.value[off] |
        (wuRec.value[off + 1] << 8) |
        (wuRec.value[off + 2] << 16) |
        (wuRec.value[off + 3] << 24);
      off += 4;
    }
    const script = wuRec.value.slice(off, off + scriptLen);
    const address = scriptToAddress(script);
    const isOurs = ourScriptHex
      ? bytesToHex(script) === ourScriptHex
      : false;
    totalInput += amount;
    inputs.push({ address, value: amount, isOurs });
  }

  const outputs: PsbtSummaryOutput[] = [];
  let totalOutput = 0;
  for (const section of psbt.outputs) {
    const amountRec = findKeylessRecord(section, PSBT_OUT_AMOUNT);
    if (!amountRec) {
      // Malformed; skip.
      continue;
    }
    const amount = Number(readU64LE(amountRec.value));
    totalOutput += amount;

    const spRec = findKeylessRecord(section, PSBT_OUT_SP_V0_INFO);
    const scriptRec = findKeylessRecord(section, PSBT_OUT_SCRIPT);

    if (spRec) {
      // Silent payment recipient: render the `sp1…` address as the user
      // intent. If the on-chain P2TR script is already derived (signer
      // partially completed), include it too.
      const info = parseSpV0Info(spRec.value);
      const spAddress = encodeSilentPaymentAddress({
        network: 'mainnet',
        version: 0,
        scanPubKey: info.scanPubKey,
        spendPubKey: info.spendPubKey,
      });
      const onchainAddress =
        scriptRec && scriptRec.value.length > 0
          ? scriptToAddress(scriptRec.value)
          : undefined;
      outputs.push({
        address: onchainAddress,
        value: amount,
        isChange: false,
        silentPaymentAddress: spAddress,
      });
      continue;
    }

    // Regular output.
    const address = scriptRec ? scriptToAddress(scriptRec.value) : undefined;
    const isChange = !!ourAddress && address === ourAddress;
    outputs.push({ address, value: amount, isChange });
  }

  const fee = allKnown ? totalInput - totalOutput : undefined;
  let netDebit: number | undefined;
  if (allKnown) {
    const inFromUs = inputs
      .filter((i) => i.isOurs)
      .reduce((s, i) => s + (i.value ?? 0), 0);
    const backToUs = outputs
      .filter((o) => o.isChange)
      .reduce((s, o) => s + o.value, 0);
    netDebit = inFromUs - backToUs;
  }

  return {
    inputs,
    outputs,
    totalInput: allKnown ? totalInput : undefined,
    totalOutput,
    fee,
    netDebit,
  };
}

// ---------------------------------------------------------------------------
// BIP352 silent payment sends (sp1…)
// ---------------------------------------------------------------------------
//
// The wallet's only signing input is the user's Nostr nsec used as a Taproot
// internal key with no script tree. For BIP352 the sender's `a_i` contribution
// is the *tweaked* private key (the one that actually signs the P2TR input,
// per BIP341), with the parity-flip rule applied so the resulting pubkey has
// an even Y. `tweakNsecForTaproot` handles both steps.
//
// A silent payment output is parameterised by the chosen input set, so the
// build step has to:
//   1. lock in coin selection (we use every UTXO, matching the rest of the
//      wallet),
//   2. compute the tweaked input scalar,
//   3. derive the per-recipient one-shot P2TR output via BIP352,
//   4. assemble the PSBT just like any other Taproot send.
//
// Bunker logins cannot do step 3 (we have no NIP-46 method for "give me your
// tweaked private key" or "do this ECDH"), so this path is nsec-only.

/** Result of building a silent payment PSBT. */
export interface UnsignedSilentPaymentPsbt extends UnsignedPsbt {
  /**
   * The concrete P2TR address the silent payment resolved to for this input
   * set. Surfaced for UI / mempool.space links; not needed for signing.
   */
  resolvedAddress: string;
}

/**
 * Build an unsigned PSBT that pays a BIP352 silent payment address.
 *
 * Unlike {@link buildUnsignedPsbt}, this function needs the sender's private
 * key — the recipient's address depends on the input set's keys. The PSBT it
 * returns can then be signed by {@link signPsbtLocal} (using the same
 * `privateKeyHex`) like any other.
 *
 * @param privateKeyHex 32-byte hex private key (the nsec from the active login).
 * @param spAddress     The recipient's `sp1…` silent payment address.
 * @param amountSats    Amount to send in satoshis.
 * @param utxos         Available UTXOs (all consumed, matching the rest of the wallet).
 * @param feeRate       Fee rate in sat/vB.
 */
export function buildUnsignedSilentPaymentPsbt(
  privateKeyHex: string,
  spAddress: string,
  amountSats: number,
  utxos: UTXO[],
  feeRate: number,
): UnsignedSilentPaymentPsbt {
  if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
    throw new Error('Silent payment send: invalid private key.');
  }
  if (utxos.length === 0) {
    throw new Error('Silent payment send: no UTXOs available.');
  }

  // 1. Decode the silent payment address.
  const decoded: SilentPaymentAddress = decodeSilentPaymentAddress(spAddress);
  if (decoded.network !== 'mainnet') {
    // The wallet only operates on mainnet; testnet/signet would be a
    // different scriptPubKey network anyway.
    throw new Error('Silent payment send: testnet addresses are not supported.');
  }

  // 2. Compute the tweaked scalar (BIP341 + parity flip).
  const tweaked = tweakNsecForTaproot(privateKeyHex);

  // 3. Derive the per-recipient P2TR output.
  //
  // BIP-352 requires the sender to aggregate the private keys of *every*
  // eligible input (`a = Σ aᵢ`), because the recipient reconstructs the
  // matching `A = Σ Pᵢ` from the transaction's inputs when scanning. Deriving
  // from `utxos[0]` alone was invisible with a single UTXO and silently
  // misdirected the payment with two — the steady state for any wallet that
  // has received something, since we spend every UTXO on each send. The
  // transaction still confirmed and change still came back; the recipient
  // simply never saw a payment that landed on a key nobody scans for.
  const spInputs: SilentPaymentInput[] = utxos.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    privateKey: tweaked,
    isTaproot: true,
  }));
  const outputs = deriveSilentPaymentOutputs(
    spInputs,
    [{ address: decoded, raw: spAddress }],
    { allOutpoints: utxos.map((u) => ({ txid: u.txid, vout: u.vout })) },
  );
  if (outputs.length !== 1) {
    throw new Error('Silent payment send: derivation produced unexpected output count.');
  }
  const resolvedAddress = outputs[0].address;

  // 4. From here on the PSBT build is identical to a regular Taproot send.
  //    We compute the sender's pubkey directly from the private key so we
  //    don't need to plumb it through separately.
  const internalPubkey = pubSchnorr(hexToBytes(privateKeyHex));
  const senderPubkeyHex = bytesToHex(internalPubkey);

  const { psbtHex, fee } = buildUnsignedPsbt(
    senderPubkeyHex,
    resolvedAddress,
    amountSats,
    utxos,
    feeRate,
  );

  return { psbtHex, fee, resolvedAddress };
}
