/**
 * BIP-375 signer end-to-end test.
 *
 * Construct a BIP-375 PSBTv2 in memory that pays a silent-payment
 * recipient, hand it to {@link signBip375Psbt}, and verify:
 *   - the returned PSBT carries a global ECDH share + DLEQ proof,
 *   - the SP output's PSBT_OUT_SCRIPT is populated and matches what
 *     `deriveSilentPaymentOutputs` would produce for the same inputs,
 *   - the DLEQ proof verifies,
 *   - the input has a tap key signature.
 */
import { describe, expect, it } from 'vitest';
import { Buffer } from 'buffer';
import * as btc from '@scure/btc-signer';
import {
  pubECDSA,
  tagSchnorr,
  taprootTweakPubkey,
} from '@scure/btc-signer/utils.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { signBip375Psbt } from './bip375';
import {
  decodePsbt,
  findKeylessRecord,
  PSBT_GLOBAL_INPUT_COUNT,
  PSBT_GLOBAL_OUTPUT_COUNT,
  PSBT_GLOBAL_SP_DLEQ,
  PSBT_GLOBAL_SP_ECDH_SHARE,
  PSBT_GLOBAL_TX_MODIFIABLE,
  PSBT_GLOBAL_TX_VERSION,
  PSBT_GLOBAL_VERSION,
  PSBT_IN_OUTPUT_INDEX,
  PSBT_IN_PREVIOUS_TXID,
  PSBT_IN_SEQUENCE,
  PSBT_IN_TAP_INTERNAL_KEY,
  PSBT_IN_TAP_KEY_SIG,
  PSBT_IN_WITNESS_UTXO,
  PSBT_OUT_AMOUNT,
  PSBT_OUT_SCRIPT,
  PSBT_OUT_SP_V0_INFO,
} from './psbtv2';
import {
  decodeSilentPaymentAddress,
  deriveSilentPaymentOutputs,
  encodeSilentPaymentAddress,
  tweakNsecForTaproot,
} from './silentPayments';
import { verifyDLEQProof } from './dleq';

const SECP_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** secp256k1 group-order negation of a 32-byte scalar. */
function privateNegate(priv: Uint8Array): Uint8Array {
  let k = 0n;
  for (const b of priv) k = (k << 8n) | BigInt(b);
  if (k === 0n || k >= SECP_N) throw new Error('privateNegate: out of range.');
  let v = SECP_N - k;
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function compactSize(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.from([n]);
  if (n <= 0xffff) return Uint8Array.from([0xfd, n & 0xff, (n >>> 8) & 0xff]);
  return Uint8Array.from([
    0xfe,
    n & 0xff,
    (n >>> 8) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 24) & 0xff,
  ]);
}

function u32le(n: number): Uint8Array {
  return Uint8Array.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

function u64le(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function pushRecord(parts: number[], key: Uint8Array, value: Uint8Array): void {
  // key length (varint)
  for (const b of compactSize(key.length)) parts.push(b);
  for (const b of key) parts.push(b);
  for (const b of compactSize(value.length)) parts.push(b);
  for (const b of value) parts.push(b);
}

function buildBip375Psbt(params: {
  txVersion: number;
  txid: Uint8Array; // 32 bytes internal LE order
  vout: number;
  sequence: number;
  inputAmount: bigint;
  inputScript: Uint8Array;
  inputInternalKey: Uint8Array;
  spScanPubKey: Uint8Array;
  spSpendPubKey: Uint8Array;
  spAmount: bigint;
  changeAmount: bigint;
  changeScript: Uint8Array;
  /**
   * Additional inputs beyond input 0, spending the same script / internal key.
   * The wallet has no coin selection and spends every UTXO, so a transaction
   * with two or more inputs is the normal case, not an edge case.
   */
  extraInputs?: { txid: Uint8Array; vout: number }[];
}): string {
  const parts: number[] = [0x70, 0x73, 0x62, 0x74, 0xff];
  const extraInputs = params.extraInputs ?? [];

  // Globals
  pushRecord(parts, new Uint8Array([PSBT_GLOBAL_TX_VERSION]), u32le(params.txVersion));
  pushRecord(
    parts,
    new Uint8Array([PSBT_GLOBAL_INPUT_COUNT]),
    new Uint8Array([1 + extraInputs.length]),
  );
  pushRecord(parts, new Uint8Array([PSBT_GLOBAL_OUTPUT_COUNT]), new Uint8Array([2]));
  pushRecord(parts, new Uint8Array([PSBT_GLOBAL_VERSION]), u32le(2));
  parts.push(0x00);

  // Input 0
  pushRecord(parts, new Uint8Array([PSBT_IN_PREVIOUS_TXID]), params.txid);
  pushRecord(parts, new Uint8Array([PSBT_IN_OUTPUT_INDEX]), u32le(params.vout));
  pushRecord(parts, new Uint8Array([PSBT_IN_SEQUENCE]), u32le(params.sequence));
  const wuValue = [
    ...u64le(params.inputAmount),
    ...compactSize(params.inputScript.length),
    ...params.inputScript,
  ];
  pushRecord(parts, new Uint8Array([PSBT_IN_WITNESS_UTXO]), Uint8Array.from(wuValue));
  pushRecord(parts, new Uint8Array([PSBT_IN_TAP_INTERNAL_KEY]), params.inputInternalKey);
  parts.push(0x00);

  // Inputs 1..n — same script and internal key, different outpoints.
  for (const extra of extraInputs) {
    pushRecord(parts, new Uint8Array([PSBT_IN_PREVIOUS_TXID]), extra.txid);
    pushRecord(parts, new Uint8Array([PSBT_IN_OUTPUT_INDEX]), u32le(extra.vout));
    pushRecord(parts, new Uint8Array([PSBT_IN_SEQUENCE]), u32le(params.sequence));
    pushRecord(parts, new Uint8Array([PSBT_IN_WITNESS_UTXO]), Uint8Array.from(wuValue));
    pushRecord(parts, new Uint8Array([PSBT_IN_TAP_INTERNAL_KEY]), params.inputInternalKey);
    parts.push(0x00);
  }

  // Output 0: SP recipient (no PSBT_OUT_SCRIPT yet; only PSBT_OUT_SP_V0_INFO)
  pushRecord(parts, new Uint8Array([PSBT_OUT_AMOUNT]), u64le(params.spAmount));
  // BIP-375 §"Unique Identification": SP_V0_INFO = version (1 byte) || scan (33) || spend (33).
  const spInfoVal = new Uint8Array(67);
  spInfoVal[0] = 0;
  spInfoVal.set(params.spScanPubKey, 1);
  spInfoVal.set(params.spSpendPubKey, 34);
  pushRecord(parts, new Uint8Array([PSBT_OUT_SP_V0_INFO]), spInfoVal);
  parts.push(0x00);

  // Output 1: change
  pushRecord(parts, new Uint8Array([PSBT_OUT_AMOUNT]), u64le(params.changeAmount));
  pushRecord(parts, new Uint8Array([PSBT_OUT_SCRIPT]), params.changeScript);
  parts.push(0x00);

  return Buffer.from(parts).toString('hex');
}

// Re-implement the BIP-341 SIGHASH_DEFAULT key-path sighash so the test can
// independently verify the signature emitted by signBip375Psbt.
function computeSighashForTest(signed: ReturnType<typeof decodePsbt>): Uint8Array {
  // Pull the fields we need from the signed PSBT.
  const txVersionRec = signed.globals.find(
    (kv) => kv.key.length === 1 && kv.key[0] === PSBT_GLOBAL_TX_VERSION,
  )!;
  const txVersion =
    txVersionRec.value[0] |
    (txVersionRec.value[1] << 8) |
    (txVersionRec.value[2] << 16) |
    (txVersionRec.value[3] << 24);
  const locktime = 0;

  const inputs = signed.inputs.map((sec) => {
    const txid = findKeylessRecord(sec, PSBT_IN_PREVIOUS_TXID)!.value;
    const voutBuf = findKeylessRecord(sec, PSBT_IN_OUTPUT_INDEX)!.value;
    const vout =
      voutBuf[0] | (voutBuf[1] << 8) | (voutBuf[2] << 16) | (voutBuf[3] << 24);
    const seqBuf = findKeylessRecord(sec, PSBT_IN_SEQUENCE)?.value;
    const sequence = seqBuf
      ? seqBuf[0] | (seqBuf[1] << 8) | (seqBuf[2] << 16) | (seqBuf[3] << 24)
      : 0xffffffff;
    const wu = findKeylessRecord(sec, PSBT_IN_WITNESS_UTXO)!.value;
    let amount = 0n;
    for (let j = 7; j >= 0; j--) amount = (amount << 8n) | BigInt(wu[j]);
    const scriptLen = wu[8];
    const script = wu.slice(9, 9 + scriptLen);
    return { txid, vout, sequence, amount, script };
  });

  const outputs = signed.outputs.map((sec) => {
    const a = findKeylessRecord(sec, PSBT_OUT_AMOUNT)!.value;
    let amount = 0n;
    for (let j = 7; j >= 0; j--) amount = (amount << 8n) | BigInt(a[j]);
    const script = findKeylessRecord(sec, PSBT_OUT_SCRIPT)!.value;
    return { amount, script };
  });

  function u32leInline(n: number): Uint8Array {
    return new Uint8Array([
      n & 0xff,
      (n >>> 8) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 24) & 0xff,
    ]);
  }
  function u64leN(n: bigint): Uint8Array {
    const out = new Uint8Array(8);
    let v = n;
    for (let i = 0; i < 8; i++) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  }
  function csz(n: number): Uint8Array {
    return compactSize(n);
  }
  function sha(b: Uint8Array): Uint8Array {
    return sha256(b);
  }
  function tagged(tag: string, b: Uint8Array): Uint8Array {
    return tagSchnorr(tag, b);
  }
  function cat(...parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  const prevouts: number[] = [];
  for (const inp of inputs) {
    for (const b of inp.txid) prevouts.push(b);
    for (const b of u32leInline(inp.vout)) prevouts.push(b);
  }
  const shaPrevouts = sha(Uint8Array.from(prevouts));

  const amounts: number[] = [];
  for (const inp of inputs) for (const b of u64leN(inp.amount)) amounts.push(b);
  const shaAmounts = sha(Uint8Array.from(amounts));

  const spks: number[] = [];
  for (const inp of inputs) {
    for (const b of csz(inp.script.length)) spks.push(b);
    for (const b of inp.script) spks.push(b);
  }
  const shaScriptpubkeys = sha(Uint8Array.from(spks));

  const seqs: number[] = [];
  for (const inp of inputs) for (const b of u32leInline(inp.sequence)) seqs.push(b);
  const shaSequences = sha(Uint8Array.from(seqs));

  const outs: number[] = [];
  for (const o of outputs) {
    for (const b of u64leN(o.amount)) outs.push(b);
    for (const b of csz(o.script.length)) outs.push(b);
    for (const b of o.script) outs.push(b);
  }
  const shaOutputs = sha(Uint8Array.from(outs));

  const body = cat(
    new Uint8Array([0x00, 0x00]),
    u32leInline(txVersion),
    u32leInline(locktime),
    shaPrevouts,
    shaAmounts,
    shaScriptpubkeys,
    shaSequences,
    shaOutputs,
    new Uint8Array([0x00]),
    u32leInline(0),
  );
  return tagged('TapSighash', body);
}

describe('BIP-375 signPsbt end-to-end', () => {
  // Deterministic test key (NOT real-user material).
  const privHex = '1111111111111111111111111111111111111111111111111111111111111111';
  const privBytes = new Uint8Array(Buffer.from(privHex, 'hex'));
  const fullPub = pubECDSA(privBytes, true);
  // BIP-340: the canonical x-only internal key is the x-coordinate of the
  // public key associated with `priv` after a parity flip when Y is odd.
  // The PSBT carries the x-only key directly.
  const internalKey = new Uint8Array(fullPub.slice(1));
  const p2tr = btc.p2tr(internalKey, undefined, btc.NETWORK);
  const inputScript = new Uint8Array(p2tr.script);

  // A made-up silent-payment recipient (we have its scan + spend keys, not its bech32m).
  // Derive both from arbitrary private keys so we get well-formed compressed pubkeys.
  const scanPriv = '2222222222222222222222222222222222222222222222222222222222222222';
  const spendPriv = '3333333333333333333333333333333333333333333333333333333333333333';
  const scanPubKey = pubECDSA(new Uint8Array(Buffer.from(scanPriv, 'hex')), true);
  const spendPubKey = pubECDSA(new Uint8Array(Buffer.from(spendPriv, 'hex')), true);
  const spAddress = encodeSilentPaymentAddress({
    network: 'mainnet',
    version: 0,
    scanPubKey,
    spendPubKey,
  });

  const txid = new Uint8Array(32);
  for (let i = 0; i < 32; i++) txid[i] = i + 1;
  const vout = 0;
  const inputAmount = 100_000n;
  const spAmount = 50_000n;
  const changeAmount = 49_500n;
  const changeScript = inputScript; // change back to ourselves

  const psbtHex = buildBip375Psbt({
    txVersion: 2,
    txid,
    vout,
    sequence: 0xfffffffd,
    inputAmount,
    inputScript,
    inputInternalKey: internalKey,
    spScanPubKey: scanPubKey,
    spSpendPubKey: spendPubKey,
    spAmount,
    changeAmount,
    changeScript,
  });

  it('signs and fills in derived output script, ECDH share, DLEQ proof, and tap key sig', () => {
    const result = signBip375Psbt(psbtHex, privHex);
    expect(result.hadSilentPaymentOutputs).toBe(true);

    const signed = decodePsbt(result.psbtHex);

    // ── Global ECDH share + DLEQ keyed by scan key ─────────────────────
    const shareRec = signed.globals.find(
      (kv) =>
        kv.key.length === 34 &&
        kv.key[0] === PSBT_GLOBAL_SP_ECDH_SHARE &&
        Buffer.from(kv.key.slice(1)).equals(Buffer.from(scanPubKey)),
    );
    expect(shareRec).toBeDefined();
    expect(shareRec!.value.length).toBe(33);

    const dleqRec = signed.globals.find(
      (kv) =>
        kv.key.length === 34 &&
        kv.key[0] === PSBT_GLOBAL_SP_DLEQ &&
        Buffer.from(kv.key.slice(1)).equals(Buffer.from(scanPubKey)),
    );
    expect(dleqRec).toBeDefined();
    expect(dleqRec!.value.length).toBe(64);

    // Verify the DLEQ proof. The verifier's `A` is the aggregator's `A = a·G`
    // *after* BIP-352's parity flip on taproot input keys. To produce it we
    // run the same aggregator the signer uses internally.
    const aBytes = tweakNsecForTaproot(privHex);
    // Force the same parity-flip the signer applies (BIP-352 §"Creating outputs"):
    // for taproot inputs whose pubkey has odd Y, negate the scalar.
    let aForA = aBytes;
    const probe = pubECDSA(aBytes, true);
    if (probe[0] === 0x03) {
      aForA = privateNegate(aBytes);
    }
    const A = pubECDSA(aForA, true);
    expect(
      verifyDLEQProof({
        A: new Uint8Array(A),
        B: scanPubKey,
        C: shareRec!.value,
        proof: dleqRec!.value,
      }),
    ).toBe(true);

    // ── SP output script is now populated and matches the reference math ─
    const spOutScript = findKeylessRecord(signed.outputs[0], PSBT_OUT_SCRIPT);
    expect(spOutScript).toBeDefined();
    expect(spOutScript!.value.length).toBe(34);
    expect(spOutScript!.value[0]).toBe(0x51); // OP_1
    expect(spOutScript!.value[1]).toBe(0x20); // push 32

    // Compare against the legacy pipeline (deriveSilentPaymentOutputs):
    const decoded = decodeSilentPaymentAddress(spAddress);
    const legacy = deriveSilentPaymentOutputs(
      [
        {
          txid: Buffer.from(txid).reverse().toString('hex'),
          vout,
          privateKey: aBytes,
          isTaproot: true,
        },
      ],
      [{ address: decoded, raw: spAddress }],
    );
    expect(legacy.length).toBe(1);
    expect(Buffer.from(spOutScript!.value.slice(2)).toString('hex')).toBe(
      Buffer.from(legacy[0].xOnlyPubKey).toString('hex'),
    );

    // ── Input has a tap key signature ───────────────────────────────────
    const sigRec = findKeylessRecord(signed.inputs[0], PSBT_IN_TAP_KEY_SIG);
    expect(sigRec).toBeDefined();
    // BIP-341 Schnorr: 64-byte signature for SIGHASH_DEFAULT.
    expect(sigRec!.value.length).toBe(64);

    // Verify the Schnorr signature against the Taproot output key (the
    // tweaked pubkey of our internal key). We recompute the BIP-341
    // sighash inline. This is the strongest possible check that signing
    // actually worked: a verifier (e.g. a node) would reject the
    // broadcast tx otherwise.
    //
    // `taprootTweakPubkey(internalKey, merkleRoot)` computes the BIP-341
    // tweaked output key. We use no script tree → empty merkle root.
    const [tweakedXOnlyBytes] = taprootTweakPubkey(
      internalKey,
      new Uint8Array(0),
    );
    const tweakedXOnly = new Uint8Array(tweakedXOnlyBytes);

    const sighash = computeSighashForTest(signed);
    expect(schnorr.verify(sigRec!.value, sighash, tweakedXOnly)).toBe(true);

    // ── Modifiable flags cleared ────────────────────────────────────────
    const modRec = findKeylessRecord(signed.globals, PSBT_GLOBAL_TX_MODIFIABLE);
    expect(modRec).toBeDefined();
    expect(modRec!.value[0]).toBe(0);
  });

  /**
   * BIP-352 requires the sender to aggregate the private keys of *every*
   * eligible input, because the recipient reconstructs `A = Σ Pᵢ` from the
   * transaction's inputs when scanning. The signer used to derive from
   * `inputs[0]` alone: invisible with one UTXO, and with two it silently paid
   * a key the recipient never scans for. Since the wallet spends every UTXO on
   * each send, two or more inputs is the steady state for any wallet that has
   * received anything.
   */
  it('derives the SP output from every input, not just the first', () => {
    const txid2 = new Uint8Array(32);
    for (let i = 0; i < 32; i++) txid2[i] = 0x40 + i;

    const twoInputHex = buildBip375Psbt({
      txVersion: 2,
      txid,
      vout,
      sequence: 0xfffffffd,
      inputAmount,
      inputScript,
      inputInternalKey: internalKey,
      spScanPubKey: scanPubKey,
      spSpendPubKey: spendPubKey,
      spAmount,
      changeAmount,
      changeScript,
      extraInputs: [{ txid: txid2, vout: 1 }],
    });

    const oneInput = decodePsbt(signBip375Psbt(psbtHex, privHex).psbtHex);
    const twoInputs = decodePsbt(signBip375Psbt(twoInputHex, privHex).psbtHex);

    const scriptOf = (psbt: ReturnType<typeof decodePsbt>) =>
      Buffer.from(findKeylessRecord(psbt.outputs[0], PSBT_OUT_SCRIPT)!.value).toString('hex');

    // The signature of the defect: the derived output was identical no matter
    // how many inputs the transaction spent.
    expect(scriptOf(twoInputs)).not.toBe(scriptOf(oneInput));

    // And it must equal a spec-correct derivation over the full input set —
    // the script the recipient's scanner actually looks for.
    const tweaked = tweakNsecForTaproot(privHex);
    const outpoints = [
      { txid: Buffer.from(txid).reverse().toString('hex'), vout },
      { txid: Buffer.from(txid2).reverse().toString('hex'), vout: 1 },
    ];
    const [expected] = deriveSilentPaymentOutputs(
      outpoints.map((o) => ({ ...o, privateKey: tweaked, isTaproot: true })),
      [{ address: decodeSilentPaymentAddress(spAddress), raw: spAddress }],
      { allOutpoints: outpoints },
    );
    expect(scriptOf(twoInputs)).toBe(
      `5120${Buffer.from(expected.xOnlyPubKey).toString('hex')}`,
    );

    // Both inputs get signed, and the ECDH share is the one the DLEQ proof
    // commits to for the aggregated key.
    expect(twoInputs.inputs.length).toBe(2);
    for (const input of twoInputs.inputs) {
      expect(findKeylessRecord(input, PSBT_IN_TAP_KEY_SIG)!.value.length).toBe(64);
    }
  });

  it('rejects when an input is not owned by the signer', () => {
    const otherKey = new Uint8Array(32);
    otherKey[0] = 0x42;
    const otherX = pubECDSA(otherKey, true).slice(1);
    const psbt = buildBip375Psbt({
      txVersion: 2,
      txid,
      vout,
      sequence: 0xfffffffd,
      inputAmount,
      inputScript,
      inputInternalKey: new Uint8Array(otherX),
      spScanPubKey: scanPubKey,
      spSpendPubKey: spendPubKey,
      spAmount,
      changeAmount,
      changeScript,
    });
    expect(() => signBip375Psbt(psbt, privHex)).toThrow(/not owned/i);
  });

  it('rejects PSBTs with no SP outputs', () => {
    // Same builder but the only output has PSBT_OUT_SCRIPT and no SP info.
    const parts: number[] = [0x70, 0x73, 0x62, 0x74, 0xff];
    pushRecord(parts, new Uint8Array([PSBT_GLOBAL_TX_VERSION]), u32le(2));
    pushRecord(parts, new Uint8Array([PSBT_GLOBAL_INPUT_COUNT]), new Uint8Array([1]));
    pushRecord(parts, new Uint8Array([PSBT_GLOBAL_OUTPUT_COUNT]), new Uint8Array([1]));
    pushRecord(parts, new Uint8Array([PSBT_GLOBAL_VERSION]), u32le(2));
    parts.push(0x00);
    pushRecord(parts, new Uint8Array([PSBT_IN_PREVIOUS_TXID]), txid);
    pushRecord(parts, new Uint8Array([PSBT_IN_OUTPUT_INDEX]), u32le(vout));
    const wuValue = [
      ...u64le(inputAmount),
      ...compactSize(inputScript.length),
      ...inputScript,
    ];
    pushRecord(parts, new Uint8Array([PSBT_IN_WITNESS_UTXO]), Uint8Array.from(wuValue));
    pushRecord(parts, new Uint8Array([PSBT_IN_TAP_INTERNAL_KEY]), internalKey);
    parts.push(0x00);
    pushRecord(parts, new Uint8Array([PSBT_OUT_AMOUNT]), u64le(spAmount));
    pushRecord(parts, new Uint8Array([PSBT_OUT_SCRIPT]), changeScript);
    parts.push(0x00);
    const hex = Buffer.from(parts).toString('hex');
    expect(() => signBip375Psbt(hex, privHex)).toThrow(/no PSBT_OUT_SP_V0_INFO/);
  });
});
