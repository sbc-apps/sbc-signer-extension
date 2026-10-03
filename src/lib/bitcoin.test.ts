import { afterEach, describe, expect, it, vi } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils.js';
import { pubECDSA } from '@scure/btc-signer/utils.js';

import {
  buildUnsignedSilentPaymentPsbt,
  estimateFee,
  type FeeRates,
  getFeeRates,
  parseBitcoinUri,
  type UTXO,
} from './bitcoin';
import { _resetEsploraStateForTests } from './esplora';
import {
  decodeSilentPaymentAddress,
  deriveSilentPaymentOutputs,
  encodeSilentPaymentAddress,
  tweakNsecForTaproot,
} from './silentPayments';

describe('parseBitcoinUri', () => {
  it('returns null for inputs without a bitcoin: scheme', () => {
    expect(parseBitcoinUri('')).toBeNull();
    expect(parseBitcoinUri('bc1p2wsldez5mud2yam29q22wgfh9439spgduvct83k3pm50fcxa5dps59h4z5')).toBeNull();
    expect(parseBitcoinUri('lightning:lnbc...')).toBeNull();
  });

  it('extracts the address from a bare bitcoin: URI', () => {
    expect(parseBitcoinUri('bitcoin:bc1p2wsldez5mud2yam29q22wgfh9439spgduvct83k3pm50fcxa5dps59h4z5')).toEqual({
      address: 'bc1p2wsldez5mud2yam29q22wgfh9439spgduvct83k3pm50fcxa5dps59h4z5',
      sp: undefined,
      amountSats: undefined,
    });
  });

  it('is case-insensitive on the scheme', () => {
    expect(parseBitcoinUri('BITCOIN:1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toEqual({
      address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
      sp: undefined,
      amountSats: undefined,
    });
  });

  it('strips a trailing query string and surfaces the sp parameter', () => {
    const uri = 'bitcoin:bc1p2wsldez5mud2yam29q22wgfh9439spgduvct83k3pm50fcxa5dps59h4z5?label=Tip&sp=sp1qq';
    expect(parseBitcoinUri(uri)).toEqual({
      address: 'bc1p2wsldez5mud2yam29q22wgfh9439spgduvct83k3pm50fcxa5dps59h4z5',
      sp: 'sp1qq',
      amountSats: undefined,
    });
  });

  it('ignores non-amount/non-sp parameters', () => {
    const uri = 'bitcoin:1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2?label=Tip&message=hi';
    expect(parseBitcoinUri(uri)).toEqual({
      address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
      sp: undefined,
      amountSats: undefined,
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseBitcoinUri('  bitcoin:1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2  ')).toEqual({
      address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
      sp: undefined,
      amountSats: undefined,
    });
  });

  it('parses the BIP-21 amount (BTC) into satoshis', () => {
    expect(parseBitcoinUri('bitcoin:1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2?amount=0.5')).toEqual({
      address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
      sp: undefined,
      amountSats: 50_000_000,
    });
    expect(parseBitcoinUri('bitcoin:1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2?amount=0.00012345')).toEqual({
      address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
      sp: undefined,
      amountSats: 12_345,
    });
  });

  it('rounds the amount down rather than overstating it', () => {
    // 0.000000019 BTC = 1.9 sats — must floor to 1, never round up to 2.
    expect(parseBitcoinUri('bitcoin:1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2?amount=0.000000019')?.amountSats).toBe(1);
  });

  it('omits amountSats when the parameter is malformed or non-positive', () => {
    expect(parseBitcoinUri('bitcoin:1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2?amount=abc')?.amountSats).toBeUndefined();
    expect(parseBitcoinUri('bitcoin:1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2?amount=0')?.amountSats).toBeUndefined();
    expect(parseBitcoinUri('bitcoin:1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2?amount=-1')?.amountSats).toBeUndefined();
    expect(parseBitcoinUri('bitcoin:1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2?amount=')?.amountSats).toBeUndefined();
  });
});

/**
 * Fee rates come from an operator-chosen, user-editable endpoint. `Math.ceil`
 * of a truthy non-number is NaN, and NaN passes every downstream guard because
 * they are all `<` / `>=` comparisons — the change output silently disappears
 * and the wallet's whole balance becomes the miner fee. Everything here must
 * come back finite.
 */
describe('getFeeRates', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetEsploraStateForTests();
  });

  const stubFeeEstimates = (body: unknown) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );
  };

  const expectAllFinite = (rates: FeeRates) => {
    for (const [tier, rate] of Object.entries(rates)) {
      expect(Number.isFinite(rate), `${tier} is not finite`).toBe(true);
      expect(rate).toBeGreaterThanOrEqual(1);
    }
  };

  it('accepts well-formed numeric estimates', async () => {
    stubFeeEstimates({ '1': 12, '3': 8, '6': 5.2, '144': 2, '504': 1 });
    const rates = await getFeeRates(['https://example.test/api']);
    expect(rates).toEqual({
      fastestFee: 12,
      halfHourFee: 8,
      hourFee: 6, // rounded up
      economyFee: 2,
      minimumFee: 1,
    });
  });

  it('falls back to 1 sat/vB for truthy non-numbers', async () => {
    // `{"1": {"fee": 5}}` and `{"1": "5"}` are what an API-version mismatch
    // looks like, and both used to produce NaN.
    for (const body of [
      { '1': { fee: 5 }, '3': '5', '6': [], '144': true, '504': 'fast' },
      { '1': null, '3': 0, '6': -4, '144': Infinity, '504': NaN },
      {},
      [],
      null,
    ]) {
      stubFeeEstimates(body);
      _resetEsploraStateForTests();
      const rates = await getFeeRates(['https://example.test/api']);
      expectAllFinite(rates);
    }
  });

  it('caps implausibly large rates', async () => {
    stubFeeEstimates({ '1': 10_000_000, '3': 5, '6': 5, '144': 5, '504': 5 });
    const rates = await getFeeRates(['https://example.test/api']);
    expect(rates.fastestFee).toBe(5_000);
  });
});

/**
 * The wallet has no coin selection: every send spends every UTXO. BIP-352
 * requires the sender to aggregate the private keys of all of them, since the
 * recipient reconstructs `A = Σ Pᵢ` from the transaction's inputs when
 * scanning. Deriving from `utxos[0]` alone paid an address the recipient never
 * scans for, and nothing about the transaction looked wrong.
 */
describe('buildUnsignedSilentPaymentPsbt', () => {
  const privHex = '1111111111111111111111111111111111111111111111111111111111111111';
  const scanPubKey = pubECDSA(
    hexToBytes('2222222222222222222222222222222222222222222222222222222222222222'),
    true,
  );
  const spendPubKey = pubECDSA(
    hexToBytes('3333333333333333333333333333333333333333333333333333333333333333'),
    true,
  );
  const spAddress = encodeSilentPaymentAddress({
    network: 'mainnet',
    version: 0,
    scanPubKey,
    spendPubKey,
  });

  const utxos: UTXO[] = [
    {
      txid: 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16',
      vout: 0,
      value: 100_000,
      status: { confirmed: true },
    },
    {
      txid: '0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098',
      vout: 1,
      value: 60_000,
      status: { confirmed: true },
    },
  ];

  const build = (spend: UTXO[]) =>
    buildUnsignedSilentPaymentPsbt(privHex, spAddress, 40_000, spend, 5).resolvedAddress;

  it('derives the output from every UTXO, not just the first', () => {
    // The signature of the defect: the resolved address was identical no
    // matter how many UTXOs the transaction spent.
    expect(build(utxos)).not.toBe(build([utxos[0]]));

    // And it must match a spec-correct derivation over the full input set.
    const tweaked = tweakNsecForTaproot(privHex);
    const outpoints = utxos.map((u) => ({ txid: u.txid, vout: u.vout }));
    const [expected] = deriveSilentPaymentOutputs(
      outpoints.map((o) => ({ ...o, privateKey: tweaked, isTaproot: true })),
      [{ address: decodeSilentPaymentAddress(spAddress), raw: spAddress }],
      { allOutpoints: outpoints },
    );
    expect(build(utxos)).toBe(expected.address);
  });
});

describe('estimateFee', () => {
  it('computes the vsize-based fee for a sane rate', () => {
    expect(estimateFee(1, 2, 1)).toBeGreaterThan(0);
    expect(estimateFee(1, 2, 10)).toBe(estimateFee(1, 2, 1) * 10);
  });

  /**
   * Assert rather than infer. Callers used to conclude a fee was safe from
   * `change < 0` being false, which NaN satisfies — so a bad rate surfaced as
   * a broadcastable transaction that paid the balance to miners instead of an
   * error.
   */
  it('throws rather than returning NaN for an invalid rate', () => {
    expect(() => estimateFee(1, 2, NaN)).toThrow(/invalid fee rate/i);
    expect(() => estimateFee(1, 2, Infinity)).toThrow(/invalid fee rate/i);
    expect(() => estimateFee(1, 2, 0)).toThrow(/invalid fee rate/i);
    expect(() => estimateFee(1, 2, -5)).toThrow(/invalid fee rate/i);
  });
});
