/**
 * PSBTv2 (BIP-370) + BIP-375 codec — a thin typed layer over
 * `@scure/btc-signer`'s raw PSBT coder.
 *
 * We use `_RawPSBTV2` (the library's raw coder, which skips BIP-370's
 * over-strict "PSBT_OUT_SCRIPT required" validation) so SP-only outputs
 * round-trip cleanly. The library handles:
 *
 *   - magic + framing,
 *   - varint / compact-size encoding,
 *   - per-field typed parsing for well-known PSBT keytypes,
 *   - on-curve validation for embedded pubkeys (witness UTXO scripts,
 *     tap internal keys, etc. — surface as decoder errors),
 *   - preservation of unknown keytypes (which is what carries BIP-375
 *     fields not built into the library yet).
 *
 * We layer on:
 *
 *   - a convenience surface that returns a single `Psbt` object whose
 *     `globals` / `inputs[i]` / `outputs[i]` look like flat record arrays
 *     keyed by raw bytes — matching how BIP-375 reasons about its data,
 *   - read/write helpers for the BIP-375 keytypes (`PSBT_OUT_SP_V0_INFO`,
 *     etc.) and for the small set of base fields our signer flow touches,
 *   - `isBip375Psbt` detection.
 *
 * Numeric primitives (`u32leBytes` / `readU32LE` / `readU64LE` / etc.) live
 * here because the BIP-341 sighash code in `bip375.ts` also needs them.
 */
import { _RawPSBTV2 } from '@scure/btc-signer/psbt.js';
import { Buffer } from 'buffer';

// ---------------------------------------------------------------------------
// Key type constants (kept for callers that want explicit codes)
// ---------------------------------------------------------------------------

// Global key types we care about.
export const PSBT_GLOBAL_UNSIGNED_TX = 0x00;
export const PSBT_GLOBAL_TX_VERSION = 0x02;
export const PSBT_GLOBAL_FALLBACK_LOCKTIME = 0x03;
export const PSBT_GLOBAL_INPUT_COUNT = 0x04;
export const PSBT_GLOBAL_OUTPUT_COUNT = 0x05;
export const PSBT_GLOBAL_TX_MODIFIABLE = 0x06;
export const PSBT_GLOBAL_SP_ECDH_SHARE = 0x07;
export const PSBT_GLOBAL_SP_DLEQ = 0x08;
export const PSBT_GLOBAL_VERSION = 0xfb;

// Input key types.
export const PSBT_IN_NON_WITNESS_UTXO = 0x00;
export const PSBT_IN_WITNESS_UTXO = 0x01;
export const PSBT_IN_PARTIAL_SIG = 0x02;
export const PSBT_IN_SIGHASH_TYPE = 0x03;
export const PSBT_IN_BIP32_DERIVATION = 0x06;
export const PSBT_IN_FINAL_SCRIPTSIG = 0x07;
export const PSBT_IN_FINAL_SCRIPTWITNESS = 0x08;
export const PSBT_IN_PREVIOUS_TXID = 0x0e;
export const PSBT_IN_OUTPUT_INDEX = 0x0f;
export const PSBT_IN_SEQUENCE = 0x10;
export const PSBT_IN_TAP_KEY_SIG = 0x13;
export const PSBT_IN_TAP_INTERNAL_KEY = 0x17;
export const PSBT_IN_SP_ECDH_SHARE = 0x1d;
export const PSBT_IN_SP_DLEQ = 0x1e;

// Output key types.
export const PSBT_OUT_REDEEM_SCRIPT = 0x00;
export const PSBT_OUT_WITNESS_SCRIPT = 0x01;
export const PSBT_OUT_BIP32_DERIVATION = 0x02;
export const PSBT_OUT_AMOUNT = 0x03;
export const PSBT_OUT_SCRIPT = 0x04;
export const PSBT_OUT_SP_V0_INFO = 0x09;
export const PSBT_OUT_SP_V0_LABEL = 0x0a;

// ---------------------------------------------------------------------------
// Public Psbt structure
// ---------------------------------------------------------------------------

/**
 * One PSBT record, normalised into the `key bytes -> value bytes` shape we
 * use across our codebase. `key` is the full key (keytype byte || keydata).
 */
export interface KeyValue {
  key: Uint8Array;
  value: Uint8Array;
}

export interface Psbt {
  /** Always 2 for PSBTv2. */
  version: number;
  globals: KeyValue[];
  inputs: KeyValue[][];
  outputs: KeyValue[][];
}

// ---------------------------------------------------------------------------
// Internal helpers — bridge library shape <-> our flat KeyValue records
// ---------------------------------------------------------------------------

type LibPsbt = ReturnType<typeof _RawPSBTV2.decode>;
type LibMap = LibPsbt['global']; // shape is identical (modulo allowed fields) for globals/inputs/outputs
type LibUnknown = NonNullable<LibMap['unknown']>;

/**
 * Mapping from a library field name (e.g. `txVersion`) to its PSBT keytype.
 * Library fields not in this table are passed through using the typed
 * structure as-is; we only flatten the ones our consumers iterate by
 * keytype.
 *
 * The table is intentionally narrow: the library already does the
 * canonical encoding for typed fields when it serialises, so we don't have
 * to round-trip everything through `KeyValue`.
 *
 * We expose globals/inputs/outputs in a uniform `KeyValue[]` shape because
 * BIP-375 reasons about its proprietary-style keys by raw keytype, and
 * existing callers (`bip375.ts`, `bitcoin.ts:summarizePsbt`) already use
 * `findKeylessRecord` / `upsertKeylessRecord`. The bridge below converts
 * once per encode/decode.
 */

interface NamedField {
  /** PSBT keytype byte. */
  keytype: number;
  /** Library field name. */
  name: string;
  /** How to serialise the library value to a PSBT value blob. */
  toBytes: (v: unknown) => Uint8Array;
  /** How to parse a PSBT value blob back into the shape the library wants. */
  fromBytes: (b: Uint8Array) => unknown;
}

function u32leToBytes(n: number): Uint8Array {
  return new Uint8Array([
    n & 0xff,
    (n >>> 8) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 24) & 0xff,
  ]);
}
function readU32LEInternal(b: Uint8Array): number {
  if (b.length !== 4) throw new Error(`readU32LE: expected 4 bytes, got ${b.length}`);
  return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
}
function u64leToBytes(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
function readU64LEInternal(b: Uint8Array): bigint {
  if (b.length !== 8) throw new Error(`readU64LE: expected 8 bytes, got ${b.length}`);
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v;
}
function varint(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) throw new Error(`varint: invalid ${n}`);
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, (n >>> 8) & 0xff]);
  if (n <= 0xffffffff) {
    return new Uint8Array([
      0xfe,
      n & 0xff,
      (n >>> 8) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 24) & 0xff,
    ]);
  }
  throw new Error('varint > 2^32 not supported');
}
function concatBytes(...parts: Uint8Array[]): Uint8Array {
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

// Witness-UTXO codec (library exposes it as { amount: bigint, script: Bytes };
// on the wire it's amount(8 LE) || varint(scriptLen) || script).
function witnessUtxoToBytes(v: { amount: bigint; script: Uint8Array }): Uint8Array {
  return concatBytes(u64leToBytes(v.amount), varint(v.script.length), v.script);
}
function witnessUtxoFromBytes(b: Uint8Array): { amount: bigint; script: Uint8Array } {
  const amount = readU64LEInternal(b.slice(0, 8));
  let off = 8;
  const tag = b[off++];
  let scriptLen: number;
  if (tag < 0xfd) {
    scriptLen = tag;
  } else if (tag === 0xfd) {
    scriptLen = b[off] | (b[off + 1] << 8);
    off += 2;
  } else if (tag === 0xfe) {
    scriptLen =
      b[off] |
      (b[off + 1] << 8) |
      (b[off + 2] << 16) |
      (b[off + 3] << 24);
    off += 4;
  } else {
    throw new Error('witnessUtxo: 8-byte script length not supported');
  }
  return { amount, script: b.slice(off, off + scriptLen) };
}

const GLOBAL_FIELDS: NamedField[] = [
  { keytype: PSBT_GLOBAL_TX_VERSION, name: 'txVersion', toBytes: (v) => u32leToBytes(v as number), fromBytes: readU32LEInternal },
  { keytype: PSBT_GLOBAL_FALLBACK_LOCKTIME, name: 'fallbackLocktime', toBytes: (v) => u32leToBytes(v as number), fromBytes: readU32LEInternal },
  { keytype: PSBT_GLOBAL_INPUT_COUNT, name: 'inputCount', toBytes: (v) => varint(v as number), fromBytes: (b) => readVarintAll(b) },
  { keytype: PSBT_GLOBAL_OUTPUT_COUNT, name: 'outputCount', toBytes: (v) => varint(v as number), fromBytes: (b) => readVarintAll(b) },
  { keytype: PSBT_GLOBAL_TX_MODIFIABLE, name: 'txModifiable', toBytes: (v) => new Uint8Array([v as number]), fromBytes: (b) => b[0] },
  { keytype: PSBT_GLOBAL_VERSION, name: 'version', toBytes: (v) => u32leToBytes(v as number), fromBytes: readU32LEInternal },
];

const INPUT_FIELDS: NamedField[] = [
  { keytype: PSBT_IN_WITNESS_UTXO, name: 'witnessUtxo', toBytes: (v) => witnessUtxoToBytes(v as { amount: bigint; script: Uint8Array }), fromBytes: witnessUtxoFromBytes },
  { keytype: PSBT_IN_SIGHASH_TYPE, name: 'sighashType', toBytes: (v) => u32leToBytes(v as number), fromBytes: readU32LEInternal },
  // NOTE: `@scure/btc-signer` stores `txid` in **display** byte order on
  // decode (it reverses to match `Transaction.id` semantics). Our internal
  // contract — followed by every consumer in `bip375.ts` / `silentPayments.ts`
  // — is that the `txid` bytes we emit and accept are in *wire* order (the
  // 32 little-endian bytes used in raw transactions and BIP-352
  // `outpoint_L` serialisation). Reverse at the boundary in both directions.
  { keytype: PSBT_IN_PREVIOUS_TXID, name: 'txid', toBytes: (v) => new Uint8Array(v as Uint8Array).reverse(), fromBytes: (b) => new Uint8Array(b).reverse() },
  { keytype: PSBT_IN_OUTPUT_INDEX, name: 'index', toBytes: (v) => u32leToBytes(v as number), fromBytes: readU32LEInternal },
  { keytype: PSBT_IN_SEQUENCE, name: 'sequence', toBytes: (v) => u32leToBytes(v as number), fromBytes: readU32LEInternal },
  { keytype: PSBT_IN_TAP_KEY_SIG, name: 'tapKeySig', toBytes: (v) => v as Uint8Array, fromBytes: (b) => b },
  { keytype: PSBT_IN_TAP_INTERNAL_KEY, name: 'tapInternalKey', toBytes: (v) => v as Uint8Array, fromBytes: (b) => b },
];

const OUTPUT_FIELDS: NamedField[] = [
  { keytype: PSBT_OUT_AMOUNT, name: 'amount', toBytes: (v) => u64leToBytes(v as bigint), fromBytes: readU64LEInternal },
  { keytype: PSBT_OUT_SCRIPT, name: 'script', toBytes: (v) => v as Uint8Array, fromBytes: (b) => b },
];

function readVarintAll(b: Uint8Array): number {
  const tag = b[0];
  if (tag < 0xfd) return tag;
  if (tag === 0xfd) return b[1] | (b[2] << 8);
  if (tag === 0xfe) return (b[1] | (b[2] << 8) | (b[3] << 16) | (b[4] << 24)) >>> 0;
  throw new Error('PSBT: varint > 2^32');
}

function libMapToRecords(
  map: Record<string, unknown>,
  fields: NamedField[],
): KeyValue[] {
  const out: KeyValue[] = [];
  for (const f of fields) {
    const v = map[f.name];
    if (v === undefined) continue;
    out.push({ key: new Uint8Array([f.keytype]), value: f.toBytes(v) });
  }
  const unknown = map.unknown as LibUnknown | undefined;
  if (unknown) {
    for (const [k, v] of unknown) {
      const keyBytes = new Uint8Array(1 + k.key.length);
      keyBytes[0] = k.type;
      keyBytes.set(k.key, 1);
      out.push({ key: keyBytes, value: new Uint8Array(v) });
    }
  }
  return out;
}

function recordsToLibMap(
  records: KeyValue[],
  fields: NamedField[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const unknown: LibUnknown = [];
  for (const { key, value } of records) {
    const keytype = key[0];
    const field = fields.find((f) => f.keytype === keytype);
    if (field && key.length === 1) {
      out[field.name] = field.fromBytes(value);
    } else {
      // Unknown to the library — preserve as `unknown`.
      unknown.push([
        { type: keytype, key: key.slice(1) },
        new Uint8Array(value),
      ]);
    }
  }
  if (unknown.length > 0) out.unknown = unknown;
  return out;
}

// ---------------------------------------------------------------------------
// Top-level decode / encode
// ---------------------------------------------------------------------------

export function decodePsbt(input: Uint8Array | string): Psbt {
  const buf = typeof input === 'string'
    ? Uint8Array.from(Buffer.from(input, 'hex'))
    : input;

  let lib: LibPsbt;
  try {
    lib = _RawPSBTV2.decode(buf);
  } catch (err) {
    throw new Error(
      `PSBT decode failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // Verify it's actually PSBTv2; _RawPSBTV2 itself doesn't check the version field.
  const version = (lib.global as { version?: number }).version ?? 0;
  if (version !== 2) {
    throw new Error(`PSBT: this decoder only handles PSBTv2 (got version ${version}).`);
  }
  // BIP-370: PSBT_GLOBAL_UNSIGNED_TX must NOT appear in PSBTv2.
  if ((lib.global as { unsignedTx?: unknown }).unsignedTx !== undefined) {
    throw new Error('PSBT: PSBT_GLOBAL_UNSIGNED_TX is not allowed in PSBTv2.');
  }
  // Required v2 globals.
  const inputCount = (lib.global as { inputCount?: number }).inputCount;
  const outputCount = (lib.global as { outputCount?: number }).outputCount;
  if (typeof inputCount !== 'number') {
    throw new Error('PSBT: missing required field PSBT_GLOBAL_INPUT_COUNT.');
  }
  if (typeof outputCount !== 'number') {
    throw new Error('PSBT: missing required field PSBT_GLOBAL_OUTPUT_COUNT.');
  }
  if (lib.inputs.length !== inputCount) {
    throw new Error(
      `PSBT: input count mismatch (header says ${inputCount}, got ${lib.inputs.length}).`,
    );
  }
  if (lib.outputs.length !== outputCount) {
    throw new Error(
      `PSBT: output count mismatch (header says ${outputCount}, got ${lib.outputs.length}).`,
    );
  }

  return {
    version,
    globals: libMapToRecords(lib.global as Record<string, unknown>, GLOBAL_FIELDS),
    inputs: lib.inputs.map((i) => libMapToRecords(i as Record<string, unknown>, INPUT_FIELDS)),
    outputs: lib.outputs.map((o) => libMapToRecords(o as Record<string, unknown>, OUTPUT_FIELDS)),
  };
}

export function encodePsbt(psbt: Psbt): Uint8Array {
  if (psbt.version !== 2) {
    throw new Error(`PSBT encode: only PSBTv2 supported (got ${psbt.version}).`);
  }
  // Sanity: keep the count fields in sync with the actual arrays.
  const countMismatchInput =
    findKeylessRecord(psbt.globals, PSBT_GLOBAL_INPUT_COUNT)?.value;
  const countMismatchOutput =
    findKeylessRecord(psbt.globals, PSBT_GLOBAL_OUTPUT_COUNT)?.value;
  if (!countMismatchInput || readVarintAll(countMismatchInput) !== psbt.inputs.length) {
    throw new Error('PSBT encode: PSBT_GLOBAL_INPUT_COUNT must match inputs.length.');
  }
  if (!countMismatchOutput || readVarintAll(countMismatchOutput) !== psbt.outputs.length) {
    throw new Error('PSBT encode: PSBT_GLOBAL_OUTPUT_COUNT must match outputs.length.');
  }

  // Disallow PSBT_GLOBAL_UNSIGNED_TX (defence in depth — _RawPSBTV2 would
  // happily encode it).
  if (findKeylessRecord(psbt.globals, PSBT_GLOBAL_UNSIGNED_TX)) {
    throw new Error('PSBT encode: PSBT_GLOBAL_UNSIGNED_TX must not appear in PSBTv2.');
  }

  // The library types globals/inputs/outputs as { ... } & PSBTUnknownFields,
  // but at runtime they're plain records with optional named fields plus
  // `unknown`. We construct them as `Record<string, unknown>` and assert
  // back into the library's shape — it tolerates any subset of the typed
  // fields and ignores extras, so this is safe.
  const lib = {
    magic: undefined,
    global: recordsToLibMap(psbt.globals, GLOBAL_FIELDS),
    inputs: psbt.inputs.map((sec) => recordsToLibMap(sec, INPUT_FIELDS)),
    outputs: psbt.outputs.map((sec) => recordsToLibMap(sec, OUTPUT_FIELDS)),
  };

  // _RawPSBTV2.encode does no field-level validation; produces canonical
  // wire format.
  try {
    // The library's encoder is happy with our generic Record shape.
    return _RawPSBTV2.encode(lib as unknown as LibPsbt);
  } catch (err) {
    throw new Error(
      `PSBT encode failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

export function encodePsbtHex(psbt: Psbt): string {
  return Buffer.from(encodePsbt(psbt)).toString('hex');
}

// ---------------------------------------------------------------------------
// Record helpers (unchanged surface — used everywhere downstream)
// ---------------------------------------------------------------------------

export function findRecords(section: KeyValue[], keytype: number): KeyValue[] {
  return section.filter((kv) => kv.key.length >= 1 && kv.key[0] === keytype);
}

export function findKeylessRecord(section: KeyValue[], keytype: number): KeyValue | undefined {
  return section.find((kv) => kv.key.length === 1 && kv.key[0] === keytype);
}

export function removeRecords(
  section: KeyValue[],
  pred: (kv: KeyValue) => boolean,
): KeyValue[] {
  return section.filter((kv) => !pred(kv));
}

export function upsertKeylessRecord(
  section: KeyValue[],
  keytype: number,
  value: Uint8Array,
): KeyValue[] {
  const key = Uint8Array.from([keytype]);
  let found = false;
  const out = section.map((kv) => {
    if (kv.key.length === 1 && kv.key[0] === keytype) {
      found = true;
      return { key, value };
    }
    return kv;
  });
  if (!found) out.push({ key, value });
  return out;
}

export function upsertKeyedRecord(
  section: KeyValue[],
  keytype: number,
  keydata: Uint8Array,
  value: Uint8Array,
): KeyValue[] {
  const fullKey = new Uint8Array(keydata.length + 1);
  fullKey[0] = keytype;
  fullKey.set(keydata, 1);
  let found = false;
  const out = section.map((kv) => {
    if (kv.key.length === fullKey.length) {
      let same = true;
      for (let i = 0; i < fullKey.length; i++) {
        if (kv.key[i] !== fullKey[i]) {
          same = false;
          break;
        }
      }
      if (same) {
        found = true;
        return { key: fullKey, value };
      }
    }
    return kv;
  });
  if (!found) out.push({ key: fullKey, value });
  return out;
}

// ---------------------------------------------------------------------------
// Re-exported numeric primitives
// ---------------------------------------------------------------------------

export const u32leBytes = u32leToBytes;
export const readU32LE = readU32LEInternal;
export const u64leBytes = u64leToBytes;
export const readU64LE = readU64LEInternal;

// ---------------------------------------------------------------------------
// BIP-375 detection + SP info codec
// ---------------------------------------------------------------------------

export function isBip375Psbt(psbt: Psbt): boolean {
  for (const out of psbt.outputs) {
    for (const kv of out) {
      if (kv.key.length === 1 && kv.key[0] === PSBT_OUT_SP_V0_INFO) {
        return true;
      }
    }
  }
  return false;
}

export interface SilentPaymentOutputInfo {
  version: 0;
  scanPubKey: Uint8Array;
  spendPubKey: Uint8Array;
}

/**
 * Parse a `PSBT_OUT_SP_V0_INFO` value.
 *
 * Per BIP-375 §"Unique Identification" the value is serialized as a single
 * version byte followed by the 33-byte scan key and 33-byte spend key — 67
 * bytes total. The leading version byte is what disambiguates future
 * silent-payment formats; this parser only accepts version 0.
 */
export function parseSpV0Info(value: Uint8Array): SilentPaymentOutputInfo {
  if (value.length !== 67) {
    throw new Error(
      `PSBT_OUT_SP_V0_INFO: expected 67 bytes (got ${value.length}).`,
    );
  }
  if (value[0] !== 0) {
    throw new Error(
      `PSBT_OUT_SP_V0_INFO: unsupported silent-payment version ${value[0]} (only v0 is defined).`,
    );
  }
  return {
    version: 0,
    scanPubKey: value.slice(1, 34),
    spendPubKey: value.slice(34, 67),
  };
}

export function serializeSpV0Info(info: SilentPaymentOutputInfo): Uint8Array {
  if (info.scanPubKey.length !== 33 || info.spendPubKey.length !== 33) {
    throw new Error('serializeSpV0Info: pubkeys must be 33 bytes each.');
  }
  const out = new Uint8Array(67);
  out[0] = 0; // BIP-375 silent-payment version 0
  out.set(info.scanPubKey, 1);
  out.set(info.spendPubKey, 34);
  return out;
}
