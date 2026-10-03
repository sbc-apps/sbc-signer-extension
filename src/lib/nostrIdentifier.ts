import { nip19 } from 'nostr-tools';
import { NIP05_REGEX } from 'nostr-tools/nip05';

/**
 * Structured result describing a Nostr identifier detected in user input.
 *
 * Scoped to the recipient picker's needs: only identifiers that resolve to a
 * payable Nostr account (npub / nprofile / NIP-05 / bare hex pubkey). Notes,
 * events, and addressable coordinates are intentionally not matched here.
 */
export type IdentifierMatch =
  | { type: 'npub'; pubkey: string; raw: string }
  | { type: 'nprofile'; pubkey: string; raw: string }
  | { type: 'nip05'; identifier: string }
  | { type: 'hex'; hex: string };

/** 32-byte hex pubkey, case-insensitive. */
function isHex64(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Detect whether a search query is a payable Nostr identifier. Strips a
 * leading `nostr:` URI prefix. Returns `null` for regular search text.
 */
export function detectIdentifier(query: string): IdentifierMatch | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const value = trimmed.startsWith('nostr:') ? trimmed.slice(6) : trimmed;

  if (value.startsWith('npub1') || value.startsWith('nprofile1')) {
    try {
      const decoded = nip19.decode(value);
      if (decoded.type === 'npub') {
        return { type: 'npub', pubkey: decoded.data, raw: value };
      }
      if (decoded.type === 'nprofile') {
        return { type: 'nprofile', pubkey: decoded.data.pubkey, raw: value };
      }
    } catch {
      // Not a valid NIP-19 identifier.
    }
    return null;
  }

  if (isHex64(value)) {
    return { type: 'hex', hex: value.toLowerCase() };
  }

  if (NIP05_REGEX.test(value)) {
    const cleaned = value.startsWith('@') ? value.slice(1) : value;
    return { type: 'nip05', identifier: cleaned };
  }

  return null;
}
