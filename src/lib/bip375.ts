/**
 * BIP-375 signer flow: take a PSBTv2 carrying silent-payment outputs,
 * fill in `PSBT_OUT_SCRIPT` / global ECDH shares / DLEQ proofs, sign the
 * Taproot inputs we own, and return the updated PSBTv2.
 *
 * Scope: this implementation handles the common "single-signer, all-inputs-
 * P2TR-with-our-key" case that the extension produces and consumes today.
 * Specifically:
 *
 *   - The user owns every eligible input (no co-signer scenarios).
 *   - All inputs are P2TR key-path spends; their `tapInternalKey` matches
 *     our x-only Nostr pubkey.
 *   - We emit a **global** ECDH share + DLEQ proof per scan key (per
 *     BIP-375 §"Computing the ECDH Shares").
 *   - We refuse to sign if any input is SegWit > 1.
 *   - We enforce SIGHASH_ALL.
 *   - We set the modifiable flags to 0 after signing.
 *
 * This is intentionally narrow. If a dapp hands us a more complex PSBT
 * (mixed input types, foreign keys, etc.) we error rather than guess.
 *
 * Backed by `@scure/btc-signer` (Schnorr signing, Taproot tweaks) and
 * `@noble/hashes` (SHA-256) — no `bitcoinjs-lib` / `@bitcoinerlab/secp256k1`
 * dependency.
 */
import {
  pubSchnorr,
  signSchnorr,
  tagSchnorr,
  taprootTweakPrivKey,
} from '@scure/btc-signer/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { generateDLEQProof, verifyDLEQProof } from './dleq';
import {
  decodePsbt,
  encodePsbtHex,
  findKeylessRecord,
  isBip375Psbt,
  parseSpV0Info,
  PSBT_GLOBAL_FALLBACK_LOCKTIME,
  PSBT_GLOBAL_SP_DLEQ,
  PSBT_GLOBAL_SP_ECDH_SHARE,
  PSBT_GLOBAL_TX_MODIFIABLE,
  PSBT_GLOBAL_TX_VERSION,
  PSBT_IN_OUTPUT_INDEX,
  PSBT_IN_PREVIOUS_TXID,
  PSBT_IN_SEQUENCE,
  PSBT_IN_SIGHASH_TYPE,
  PSBT_IN_TAP_INTERNAL_KEY,
  PSBT_IN_TAP_KEY_SIG,
  PSBT_IN_WITNESS_UTXO,
  PSBT_OUT_AMOUNT,
  PSBT_OUT_SCRIPT,
  PSBT_OUT_SP_V0_INFO,
  readU32LE,
  readU64LE,
  type Psbt as PsbtV2,
  u32leBytes,
  upsertKeylessRecord,
} from './psbtv2';
import {
  aggregateSenderPrivateKey,
  computeBip375EcdhShare,
  deriveSPOutputScriptFromShare,
  p2trScriptPubKey,
  type SilentPaymentInput,
} from './silentPayments';

const SIGHASH_ALL = 0x01;
const SIGHASH_DEFAULT = 0x00;

// ---------------------------------------------------------------------------
// Field readers (single-record helpers)
// ---------------------------------------------------------------------------

function readSingleKeyless(
  section: PsbtV2['inputs'][number],
  keytype: number,
): Uint8Array | undefined {
  return findKeylessRecord(section, keytype)?.value;
}

// ---------------------------------------------------------------------------
// Unsigned-transaction synthesis (PSBTv2 → raw tx for BIP-341 sighash)
// ---------------------------------------------------------------------------

function bigintToU64LE(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function compactSize(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.from([n]);
  if (n <= 0xffff) return Uint8Array.from([0xfd, n & 0xff, (n >>> 8) & 0xff]);
  if (n <= 0xffffffff)
    return Uint8Array.from([
      0xfe,
      n & 0xff,
      (n >>> 8) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 24) & 0xff,
    ]);
  throw new Error('compactSize > 2^32 not supported.');
}

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

interface DecodedInput {
  txid: Uint8Array; // 32-byte LE internal order, as stored in the PSBT
  vout: number;
  sequence: number;
  witnessUtxo: { value: bigint; script: Uint8Array };
  tapInternalKey: Uint8Array;
}

interface DecodedOutput {
  amount: bigint;
  script: Uint8Array;
  spInfo?: { scanPubKey: Uint8Array; spendPubKey: Uint8Array };
}

function decodeInputs(psbt: PsbtV2): DecodedInput[] {
  return psbt.inputs.map((section, i) => {
    const txidRec = readSingleKeyless(section, PSBT_IN_PREVIOUS_TXID);
    const voutRec = readSingleKeyless(section, PSBT_IN_OUTPUT_INDEX);
    if (!txidRec || txidRec.length !== 32) {
      throw new Error(`PSBT input ${i}: missing/invalid PSBT_IN_PREVIOUS_TXID.`);
    }
    if (!voutRec || voutRec.length !== 4) {
      throw new Error(`PSBT input ${i}: missing/invalid PSBT_IN_OUTPUT_INDEX.`);
    }
    const seqRec = readSingleKeyless(section, PSBT_IN_SEQUENCE);
    const sequence = seqRec ? readU32LE(seqRec) : 0xffffffff;

    const witnessUtxoRec = readSingleKeyless(section, PSBT_IN_WITNESS_UTXO);
    if (!witnessUtxoRec) {
      throw new Error(
        `PSBT input ${i}: BIP-375 signer requires PSBT_IN_WITNESS_UTXO (value + script).`,
      );
    }
    // PSBT_IN_WITNESS_UTXO value layout: 8 bytes amount LE | varint scriptLen | script
    if (witnessUtxoRec.length < 8 + 1) {
      throw new Error(`PSBT input ${i}: PSBT_IN_WITNESS_UTXO too short.`);
    }
    const amount = readU64LE(witnessUtxoRec.slice(0, 8));
    // Read script-length varint manually.
    let off = 8;
    let scriptLen: number;
    const tag = witnessUtxoRec[off++];
    if (tag < 0xfd) {
      scriptLen = tag;
    } else if (tag === 0xfd) {
      scriptLen = witnessUtxoRec[off] | (witnessUtxoRec[off + 1] << 8);
      off += 2;
    } else if (tag === 0xfe) {
      scriptLen =
        witnessUtxoRec[off] |
        (witnessUtxoRec[off + 1] << 8) |
        (witnessUtxoRec[off + 2] << 16) |
        (witnessUtxoRec[off + 3] << 24);
      off += 4;
    } else {
      throw new Error(`PSBT input ${i}: PSBT_IN_WITNESS_UTXO has 8-byte script length.`);
    }
    if (off + scriptLen !== witnessUtxoRec.length) {
      throw new Error(`PSBT input ${i}: PSBT_IN_WITNESS_UTXO length mismatch.`);
    }
    const script = witnessUtxoRec.slice(off);

    const tapInternalRec = readSingleKeyless(section, PSBT_IN_TAP_INTERNAL_KEY);
    if (!tapInternalRec || tapInternalRec.length !== 32) {
      throw new Error(
        `PSBT input ${i}: BIP-375 signer requires PSBT_IN_TAP_INTERNAL_KEY (32 bytes).`,
      );
    }

    // Sighash type: optional; if present, must be SIGHASH_ALL/SIGHASH_DEFAULT.
    const sighashRec = readSingleKeyless(section, PSBT_IN_SIGHASH_TYPE);
    if (sighashRec) {
      if (sighashRec.length !== 4) {
        throw new Error(`PSBT input ${i}: PSBT_IN_SIGHASH_TYPE must be 4 bytes.`);
      }
      const sh = readU32LE(sighashRec);
      if (sh !== SIGHASH_ALL && sh !== SIGHASH_DEFAULT) {
        throw new Error(
          `PSBT input ${i}: BIP-375 requires SIGHASH_ALL (got 0x${sh.toString(16)}).`,
        );
      }
    }

    // Validate scriptPubKey is P2TR: 0x51 0x20 <32 bytes>.
    if (script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) {
      throw new Error(
        `PSBT input ${i}: this extension only signs P2TR inputs (SegWit v1) for BIP-375.`,
      );
    }

    return {
      txid: txidRec,
      vout: readU32LE(voutRec),
      sequence,
      witnessUtxo: { value: amount, script },
      tapInternalKey: tapInternalRec,
    };
  });
}

function decodeOutputs(psbt: PsbtV2): DecodedOutput[] {
  return psbt.outputs.map((section, i) => {
    const amountRec = readSingleKeyless(section, PSBT_OUT_AMOUNT);
    if (!amountRec || amountRec.length !== 8) {
      throw new Error(`PSBT output ${i}: missing/invalid PSBT_OUT_AMOUNT.`);
    }
    const amount = readU64LE(amountRec);

    const scriptRec = readSingleKeyless(section, PSBT_OUT_SCRIPT);
    const spRec = readSingleKeyless(section, PSBT_OUT_SP_V0_INFO);

    if (!scriptRec && !spRec) {
      throw new Error(
        `PSBT output ${i}: neither PSBT_OUT_SCRIPT nor PSBT_OUT_SP_V0_INFO is set.`,
      );
    }

    return {
      amount,
      script: scriptRec ?? new Uint8Array(0),
      spInfo: spRec ? (() => {
        const parsed = parseSpV0Info(spRec);
        return { scanPubKey: parsed.scanPubKey, spendPubKey: parsed.spendPubKey };
      })() : undefined,
    };
  });
}

function readTxVersion(psbt: PsbtV2): number {
  const rec = findKeylessRecord(psbt.globals, PSBT_GLOBAL_TX_VERSION);
  if (!rec || rec.value.length !== 4) {
    throw new Error('PSBT: missing/invalid PSBT_GLOBAL_TX_VERSION.');
  }
  return readU32LE(rec.value);
}

function readFallbackLocktime(psbt: PsbtV2): number {
  const rec = findKeylessRecord(psbt.globals, PSBT_GLOBAL_FALLBACK_LOCKTIME);
  if (!rec) return 0;
  if (rec.value.length !== 4) {
    throw new Error('PSBT: invalid PSBT_GLOBAL_FALLBACK_LOCKTIME.');
  }
  return readU32LE(rec.value);
}

// ---------------------------------------------------------------------------
// BIP-341 key-path sighash (SIGHASH_DEFAULT)
// ---------------------------------------------------------------------------

interface Bip341Subhashes {
  shaPrevouts: Uint8Array;
  shaAmounts: Uint8Array;
  shaScriptpubkeys: Uint8Array;
  shaSequences: Uint8Array;
  shaOutputs: Uint8Array;
  inputs: DecodedInput[];
  outputs: DecodedOutput[];
}

function concat(...parts: Uint8Array[]): Uint8Array {
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

function computeBip341TxSubhashes(
  inputs: DecodedInput[],
  outputs: DecodedOutput[],
): Bip341Subhashes {
  // sha_prevouts: SHA256 of all outpoints concatenated (each = 32-byte txid LE || 4-byte vout LE).
  let buf: number[] = [];
  for (const inp of inputs) {
    for (const b of inp.txid) buf.push(b);
    for (const b of u32leBytes(inp.vout)) buf.push(b);
  }
  const shaPrevouts = sha256(Uint8Array.from(buf));

  // sha_amounts: SHA256 of all input amounts (8 LE each).
  buf = [];
  for (const inp of inputs) for (const b of bigintToU64LE(inp.witnessUtxo.value)) buf.push(b);
  const shaAmounts = sha256(Uint8Array.from(buf));

  // sha_scriptpubkeys: SHA256 of all scriptPubKeys, each prefixed by its compact-size length.
  buf = [];
  for (const inp of inputs) {
    for (const b of compactSize(inp.witnessUtxo.script.length)) buf.push(b);
    for (const b of inp.witnessUtxo.script) buf.push(b);
  }
  const shaScriptpubkeys = sha256(Uint8Array.from(buf));

  // sha_sequences: SHA256 of all sequences (4 LE each).
  buf = [];
  for (const inp of inputs) for (const b of u32leBytes(inp.sequence)) buf.push(b);
  const shaSequences = sha256(Uint8Array.from(buf));

  // sha_outputs: SHA256 of all outputs, each in CTxOut form (8-byte amount LE || varint script len || script).
  buf = [];
  for (const out of outputs) {
    for (const b of bigintToU64LE(out.amount)) buf.push(b);
    for (const b of compactSize(out.script.length)) buf.push(b);
    for (const b of out.script) buf.push(b);
  }
  const shaOutputs = sha256(Uint8Array.from(buf));

  return {
    shaPrevouts,
    shaAmounts,
    shaScriptpubkeys,
    shaSequences,
    shaOutputs,
    inputs,
    outputs,
  };
}

/**
 * Compute the BIP-341 key-path sighash for a specific input, with
 * SIGHASH_DEFAULT (commits to the entire transaction).
 *
 * Message body layout (see BIP-341 §"Common signature message"):
 *
 *   epoch (1)               = 0x00
 *   hash_type (1)           = 0x00 (SIGHASH_DEFAULT)
 *   nVersion (4)            = txVersion LE
 *   nLockTime (4)           = locktime LE
 *   sha_prevouts (32)
 *   sha_amounts (32)
 *   sha_scriptpubkeys (32)
 *   sha_sequences (32)
 *   sha_outputs (32)
 *   spend_type (1)          = 0x00 (no annex, no script extension)
 *   input_index (4 LE)
 *
 * The signed message is `taggedHash("TapSighash", body)`.
 */
function computeBip341KeyPathSighash(params: {
  txVersion: number;
  locktime: number;
  inputIndex: number;
  subhashes: Bip341Subhashes;
}): Uint8Array {
  const { txVersion, locktime, inputIndex, subhashes } = params;
  const body = concat(
    new Uint8Array([0x00]), // epoch
    new Uint8Array([0x00]), // hash_type = SIGHASH_DEFAULT
    u32leBytes(txVersion),
    u32leBytes(locktime),
    subhashes.shaPrevouts,
    subhashes.shaAmounts,
    subhashes.shaScriptpubkeys,
    subhashes.shaSequences,
    subhashes.shaOutputs,
    new Uint8Array([0x00]), // spend_type
    u32leBytes(inputIndex),
  );
  return tagSchnorr('TapSighash', body);
}

// ---------------------------------------------------------------------------
// Top-level signer
// ---------------------------------------------------------------------------

export interface SignBip375PsbtResult {
  /** Hex-encoded updated PSBTv2 with output scripts, ECDH shares, DLEQ proofs, and tap key sigs. */
  psbtHex: string;
  /** True if the PSBT carried any silent-payment outputs (always true on success here). */
  hadSilentPaymentOutputs: true;
}

/**
 * Sign a BIP-375 PSBTv2 with the user's nsec.
 *
 * Throws if:
 *   - the PSBT is not a valid BIP-375 PSBT,
 *   - any input is not P2TR with our `tapInternalKey`,
 *   - any input asks for a sighash other than ALL/DEFAULT,
 *   - the recipient's silent payment derivation produces something
 *     that doesn't match the recipient's intended scriptPubKey shape.
 *
 * @param psbtHex     Hex-encoded PSBTv2 carrying SP outputs.
 * @param privateKeyHex 32-byte hex nsec (the user's Taproot internal key).
 * @returns Updated PSBTv2 hex.
 */
export function signBip375Psbt(
  psbtHex: string,
  privateKeyHex: string,
): SignBip375PsbtResult {
  if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
    throw new Error('BIP-375 signer: invalid private key hex.');
  }

  const psbt = decodePsbt(psbtHex);
  if (!isBip375Psbt(psbt)) {
    throw new Error('BIP-375 signer: PSBT has no PSBT_OUT_SP_V0_INFO outputs.');
  }

  // Derive the user's x-only Taproot key from the private key.
  const privBytes = hexToBytes(privateKeyHex);
  const userXOnly = pubSchnorr(privBytes);
  // Tweaked (key-path, no script tree) private key — the one that actually
  // signs P2TR inputs. `taprootTweakPrivKey` applies the BIP-341 parity flip
  // and adds the TapTweak in one shot.
  const tweakedPriv = new Uint8Array(taprootTweakPrivKey(privBytes));

  const inputs = decodeInputs(psbt);
  const outputs = decodeOutputs(psbt);

  // Validate ownership: every input's tapInternalKey must be ours.
  for (let i = 0; i < inputs.length; i++) {
    if (
      inputs[i].tapInternalKey.length !== 32 ||
      !buffersEq(inputs[i].tapInternalKey, userXOnly)
    ) {
      throw new Error(
        `BIP-375 signer: input ${i} is not owned by the signer (tapInternalKey mismatch).`,
      );
    }
  }

  // ── 1. Build the SP input set for ECDH derivation.
  //
  // BIP-352 requires the sender to aggregate the private keys of *every*
  // eligible input (`a = Σ aᵢ`), because the recipient reconstructs the
  // matching `A = Σ Pᵢ` from the transaction's inputs when scanning. Every
  // input here is the same key (checked above), but "same key" is not "one
  // key": with n inputs the recipient derives from n·a₁, so deriving from
  // `inputs[0]` alone diverged on both `input_hash` and the ECDH secret the
  // moment the wallet held more than one UTXO. Nothing failed — the
  // transaction confirmed and change returned correctly, and the payment
  // simply landed on a key nobody was scanning for.
  //
  // We pass `allOutpoints` = every input, so input_hash uses the lex-smallest
  // across the full set.
  //
  // PSBTv2 stores PREVIOUS_TXID in **wire** (little-endian) order — that's
  // the form our codec hands us. `silentPayments`'s `serializeOutpoint`
  // expects the *display* hex (big-endian) by default, so we reverse the
  // bytes once before hex-encoding here.
  const txidDisplayHex = (txid: Uint8Array) => {
    const reversed = new Uint8Array(txid);
    reversed.reverse();
    return bytesToHex(reversed);
  };
  const spInputs: SilentPaymentInput[] = inputs.map((inp) => ({
    txid: txidDisplayHex(inp.txid),
    vout: inp.vout,
    privateKey: tweakedPriv,
    isTaproot: true,
  }));
  const allOutpoints = inputs.map((inp) => ({
    txid: txidDisplayHex(inp.txid),
    vout: inp.vout,
  }));

  const agg = aggregateSenderPrivateKey(spInputs, allOutpoints);

  // ── 2. Group SP outputs by scan key and compute global ECDH share + DLEQ proof per group.
  type ScanGroup = { scanKey: Uint8Array; outIndices: number[] };
  const groups = new Map<string, ScanGroup>();
  for (let i = 0; i < outputs.length; i++) {
    const out = outputs[i];
    if (!out.spInfo) continue;
    const hex = bytesToHex(out.spInfo.scanPubKey);
    const existing = groups.get(hex);
    if (existing) {
      existing.outIndices.push(i);
    } else {
      groups.set(hex, { scanKey: out.spInfo.scanPubKey, outIndices: [i] });
    }
  }

  // For each group: compute share C = a · B_scan, generate DLEQ proof.
  type GroupShare = {
    scanKey: Uint8Array;
    share: Uint8Array;
    proof: Uint8Array;
  };
  const shares: GroupShare[] = [];
  for (const group of groups.values()) {
    const share = computeBip375EcdhShare(agg.aggregateScalar, group.scanKey);
    const auxRand = new Uint8Array(32);
    crypto.getRandomValues(auxRand);
    const { proof } = generateDLEQProof({
      a: agg.aggregateScalar,
      B: group.scanKey,
      auxRand,
    });
    // Sanity self-check (also done inside generateDLEQProof).
    if (
      !verifyDLEQProof({
        A: agg.aggregatePubKey,
        B: group.scanKey,
        C: share,
        proof,
      })
    ) {
      throw new Error('BIP-375 signer: DLEQ self-verification failed.');
    }
    shares.push({ scanKey: group.scanKey, share, proof });
  }

  // ── 3. Derive output scripts for each SP output.
  // Sort each group's outputs by output index ascending (per BIP-375 spec).
  for (const group of groups.values()) {
    group.outIndices.sort((a, b) => a - b);
    let k = 0;
    for (const outIdx of group.outIndices) {
      const spInfo = outputs[outIdx].spInfo!;
      const xonly = deriveSPOutputScriptFromShare({
        ecdhShare: shares.find((s) => buffersEq(s.scanKey, group.scanKey))!.share,
        inputHash: agg.inputHash,
        spendPubKey: spInfo.spendPubKey,
        k,
      });
      const scriptPubKey = p2trScriptPubKey(xonly);
      outputs[outIdx].script = scriptPubKey;
      k++;
    }
  }

  // ── 4. Update the v2 PSBT in-memory: write the derived output scripts
  // and the global ECDH share / DLEQ proof records.
  for (let i = 0; i < outputs.length; i++) {
    if (outputs[i].spInfo && outputs[i].script.length > 0) {
      psbt.outputs[i] = upsertKeylessRecord(
        psbt.outputs[i],
        PSBT_OUT_SCRIPT,
        outputs[i].script,
      );
    }
  }
  for (const s of shares) {
    psbt.globals = upsertKeyedField(
      psbt.globals,
      PSBT_GLOBAL_SP_ECDH_SHARE,
      s.scanKey,
      s.share,
    );
    psbt.globals = upsertKeyedField(
      psbt.globals,
      PSBT_GLOBAL_SP_DLEQ,
      s.scanKey,
      s.proof,
    );
  }

  // ── 5. Sign the inputs directly via BIP-341 sighash + Schnorr.
  //
  // We sidestep `@scure/btc-signer`'s `Transaction.signIdx` here because
  // that path requires a full v0/v2 PSBT round-trip through its
  // `Transaction` model, which adds plumbing for no functional gain when
  // we already have the v2 records in hand.
  //
  // BIP-341 key-path sighash is straightforward when SIGHASH_DEFAULT is in
  // use (which we enforce for BIP-375): commit to the full set of inputs
  // and outputs, then sign with the BIP-340 tweaked private key.
  const txVersion = readTxVersion(psbt);
  const locktime = readFallbackLocktime(psbt);

  // Pre-compute the BIP-341 transaction-level sub-hashes once.
  const subhashes = computeBip341TxSubhashes(inputs, outputs);

  for (let i = 0; i < inputs.length; i++) {
    const sighash = computeBip341KeyPathSighash({
      txVersion,
      locktime,
      inputIndex: i,
      subhashes,
    });
    // BIP-340 Schnorr signature with fresh aux randomness per call.
    const auxRand = new Uint8Array(32);
    crypto.getRandomValues(auxRand);
    const sig = signSchnorr(sighash, tweakedPriv, auxRand);
    if (!sig || sig.length !== 64) {
      throw new Error(`BIP-375 signer: schnorr sig produced wrong length for input ${i}.`);
    }
    psbt.inputs[i] = upsertKeylessRecord(
      psbt.inputs[i],
      PSBT_IN_TAP_KEY_SIG,
      new Uint8Array(sig),
    );
  }

  // ── 6. Mark the PSBT as non-modifiable.
  psbt.globals = upsertKeylessRecord(
    psbt.globals,
    PSBT_GLOBAL_TX_MODIFIABLE,
    new Uint8Array([0]),
  );

  return { psbtHex: encodePsbtHex(psbt), hadSilentPaymentOutputs: true };
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function buffersEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Insert/replace a keyed record on a section by keytype + keydata. */
function upsertKeyedField(
  section: PsbtV2['globals'],
  keytype: number,
  keydata: Uint8Array,
  value: Uint8Array,
): PsbtV2['globals'] {
  const fullKey = new Uint8Array(1 + keydata.length);
  fullKey[0] = keytype;
  fullKey.set(keydata, 1);
  let found = false;
  const out = section.map((kv) => {
    if (kv.key.length === fullKey.length && buffersEq(kv.key, fullKey)) {
      found = true;
      return { key: fullKey, value };
    }
    return kv;
  });
  if (!found) out.push({ key: fullKey, value });
  return out;
}
