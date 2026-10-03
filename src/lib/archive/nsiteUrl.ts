/**
 * NIP-5A gateway address construction.
 *
 * A manifest snapshot (kind 5128) is addressed by its own event id:
 * gateways parse the left-most DNS label as `v<snapshotIdB36>`, decode
 * the base36 back to the 32-byte id, and resolve the snapshot event.
 *
 * Base36 is used rather than hex or bech32 because a DNS label is
 * capped at 63 characters and the encoding has to be case-insensitive.
 * A 32-byte value always lands in exactly 50 base36 characters (the
 * maximum, 2^256-1, is 50 digits; smaller values are left-padded with
 * '0'), which leaves room for the `v` prefix.
 */

const BASE36_DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Base36 length of a 32-byte value, fixed by NIP-5A. */
export const SNAPSHOT_B36_LENGTH = 50;

/**
 * Gateways verified to implement snapshot (`v<id>`) routing.
 *
 * Not every NIP-5A gateway does — `nsite.cloud` serves named sites but
 * 404s on snapshot labels — so this list is deliberately narrower than
 * the set of known gateways. First entry is the default.
 */
export const SNAPSHOT_GATEWAYS = ['nsite.lol', 'nosto.re'] as const;

const HEX32 = /^[0-9a-f]{64}$/;

/**
 * Encode a 32-byte lowercase hex string as a zero-padded 50-character
 * base36 label.
 */
export function encodeBase36Id(hex: string): string {
  if (!HEX32.test(hex)) {
    throw new Error('expected 64 lowercase hex characters');
  }

  let n = BigInt(`0x${hex}`);
  let out = '';
  while (n > 0n) {
    const rem = Number(n % 36n);
    out = BASE36_DIGITS[rem] + out;
    n /= 36n;
  }

  return out.padStart(SNAPSHOT_B36_LENGTH, '0');
}

/** The `v<snapshotIdB36>` DNS label for a manifest snapshot event id. */
export function snapshotLabel(eventId: string): string {
  return `v${encodeBase36Id(eventId)}`;
}

/**
 * Canonical browsable URL for a manifest snapshot on a gateway.
 *
 * @param eventId Hex id of the kind 5128 event.
 * @param gateway Gateway host; defaults to the first verified gateway.
 */
export function snapshotGatewayUrl(
  eventId: string,
  gateway: string = SNAPSHOT_GATEWAYS[0],
): string {
  return `https://${snapshotLabel(eventId)}.${gateway}/`;
}
