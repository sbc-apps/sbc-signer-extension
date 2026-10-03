import { describe, expect, it } from 'vitest';

import {
  encodeBase36Id,
  SNAPSHOT_B36_LENGTH,
  snapshotGatewayUrl,
  snapshotLabel,
} from './nsiteUrl';

/**
 * Each pair was confirmed end to end: the label was requested from a
 * live gateway, which returned the manifest's `/index.html` bytes.
 */
const VECTORS: Array<[hex: string, b36: string]> = [
  [
    'ad0ff8ba946e24c2f264d81b04fbf7b49c69f61c949f304a7a2ef68838429752',
    '4ba5orug4805jw18cpn08tz2dxxx7ni1d9hwbunnp5dw016maa',
  ],
  [
    'c6ab90a36b80ad86f969a96d874f8b79d46438f883ae632eba00bca11e2f2587',
    '4y9bps2b8ylwm8r1f5b2sh9urmildbsfb1q32nq6nrqozfwps7',
  ],
  [
    '68b4fdd565f4c231a415a919acf7411578ab25d6d2578ca1720263ecfe43d84b',
    '2ly6l4e5vg6hnod2k284o2slpvy6v79ittp272uw3ez2mq6csr',
  ],
];

describe('encodeBase36Id', () => {
  it.each(VECTORS)('encodes %s', (hex, expected) => {
    expect(encodeBase36Id(hex)).toBe(expected);
  });

  it('always produces exactly 50 characters', () => {
    for (const [hex] of VECTORS) {
      expect(encodeBase36Id(hex)).toHaveLength(SNAPSHOT_B36_LENGTH);
    }
  });

  it('left-pads small values', () => {
    expect(encodeBase36Id('0'.repeat(64))).toBe('0'.repeat(SNAPSHOT_B36_LENGTH));
    expect(encodeBase36Id(`${'0'.repeat(63)}1`)).toBe(`${'0'.repeat(49)}1`);
  });

  it('encodes the maximum 32-byte value without overflowing the label', () => {
    expect(encodeBase36Id('f'.repeat(64))).toHaveLength(SNAPSHOT_B36_LENGTH);
  });

  it('rejects malformed ids', () => {
    expect(() => encodeBase36Id('abc')).toThrow();
    expect(() => encodeBase36Id('A'.repeat(64))).toThrow();
    expect(() => encodeBase36Id('g'.repeat(64))).toThrow();
  });
});

describe('snapshotLabel', () => {
  it('prefixes the base36 id with v, staying inside the 63-char DNS limit', () => {
    const label = snapshotLabel(VECTORS[0][0]);
    expect(label).toBe(`v${VECTORS[0][1]}`);
    expect(label.length).toBeLessThanOrEqual(63);
  });
});

describe('snapshotGatewayUrl', () => {
  it('builds a browsable URL on the default gateway', () => {
    expect(snapshotGatewayUrl(VECTORS[2][0])).toBe(
      'https://v2ly6l4e5vg6hnod2k284o2slpvy6v79ittp272uw3ez2mq6csr.nsite.lol/',
    );
  });

  it('accepts an alternate gateway', () => {
    expect(snapshotGatewayUrl(VECTORS[2][0], 'nosto.re')).toBe(
      'https://v2ly6l4e5vg6hnod2k284o2slpvy6v79ittp272uw3ez2mq6csr.nosto.re/',
    );
  });
});
