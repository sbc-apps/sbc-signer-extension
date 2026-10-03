/**
 * Signer factory for the background service worker.
 *
 * Reads the current `NLogin` from `chrome.storage.local` (same key as the
 * React `NostrLoginProvider` uses, so popup/options and background share
 * state) and returns a `NostrSigner`:
 *
 *  - `nsec` logins: construct an `NSecSigner` directly.
 *  - `bunker` logins: construct an `NConnectSigner` over a relay from the
 *    stored bunker params.
 *  - `extension` logins would be infinite recursion (we ARE the
 *    extension), so they're rejected.
 *
 * Bitcoin PSBT signing (`signPsbt`) lives alongside the regular signer
 * factory in {@link signPsbtForActiveLogin}: nsec logins sign locally
 * via the BIP-341 TapTweak, bunker logins delegate to the remote signer
 * via the NIP-46 `sign_psbt` RPC.
 */
import { NSecSigner, NRelay1, NConnectSigner } from '@nostrify/nostrify';
import type { NostrSigner } from '@nostrify/nostrify';
import type { NLoginType } from '@nostrify/react/login';
import { nip19 } from 'nostr-tools';

import { extStorage, STORAGE_KEYS } from './storage';
import { signPsbtLocal } from '@/lib/bitcoin';

/** Cached active relays/signers so repeat calls don't reconnect. */
const bunkerRelays = new Map<string, NRelay1>();
const bunkerSigners = new WeakMap<NLoginType, NostrSigner>();

/** Fetch the currently active login, if any. */
async function getActiveLogin(): Promise<NLoginType | null> {
  const logins = await extStorage.get<NLoginType[]>(STORAGE_KEYS.login, []);
  return logins[0] ?? null;
}

/** Return the pubkey of the active login (hex), if logged in. */
export async function getActivePubkey(): Promise<string | null> {
  const login = await getActiveLogin();
  return login?.pubkey ?? null;
}

function buildBunkerSigner(login: Extract<NLoginType, { type: 'bunker' }>): NostrSigner {
  const cached = bunkerSigners.get(login);
  if (cached) return cached;

  const relayUrl = login.data.relays[0];
  if (!relayUrl) {
    throw new Error('bunker login has no relay configured');
  }
  let relay = bunkerRelays.get(relayUrl);
  if (!relay) {
    relay = new NRelay1(relayUrl);
    bunkerRelays.set(relayUrl, relay);
  }

  const decoded = nip19.decode(login.data.clientNsec);
  if (decoded.type !== 'nsec') {
    throw new Error('bunker login has an invalid clientNsec');
  }
  const clientSigner = new NSecSigner(decoded.data);

  const signer = new NConnectSigner({
    relay,
    pubkey: login.data.bunkerPubkey,
    signer: clientSigner,
    encryption: 'nip44',
    timeout: 30_000,
  });
  bunkerSigners.set(login, signer);
  return signer;
}

/**
 * Build a `NostrSigner` for the current logged-in user, or throw a
 * user-friendly error if not logged in.
 */
export async function getActiveSigner(): Promise<NostrSigner> {
  const login = await getActiveLogin();
  if (!login) {
    throw new Error('Not logged in. Open the SBC Signer Extension to log in.');
  }
  if (login.type === 'nsec') {
    const decoded = nip19.decode(login.data.nsec);
    if (decoded.type !== 'nsec') {
      throw new Error('Stored nsec is invalid.');
    }
    return new NSecSigner(decoded.data);
  }
  if (login.type === 'bunker') {
    return buildBunkerSigner(login);
  }
  if (login.type === 'extension') {
    throw new Error('Extension login cannot be used from inside an extension signer.');
  }
  throw new Error(`Unsupported login type: ${String(login.type)}`);
}

/**
 * Sign a Bitcoin PSBT with the active login's key.
 *
 * - **nsec**: locally tweak the private key per BIP-341 and sign every
 *   matching Taproot input. If the PSBT is a BIP-375 PSBTv2 carrying
 *   silent-payment outputs, the local signer additionally computes ECDH
 *   shares, generates BIP-374 DLEQ proofs, derives the per-recipient
 *   `PSBT_OUT_SCRIPT`s, and signs.
 * - **bunker**: forward to the remote signer via the NIP-46 `sign_psbt`
 *   RPC. The remote signer handles the TapTweak and Schnorr signing.
 *   Bunkers that do not implement BIP-375 will return an error (or an
 *   incomplete PSBT) when handed a silent-payment PSBT; we surface that
 *   transparently rather than blocking the call locally.
 * - **extension**: rejected (we are the extension).
 *
 * Returns the hex-encoded signed (but not finalized) PSBT.
 */
export async function signPsbtForActiveLogin(psbtHex: string): Promise<string> {
  const login = await getActiveLogin();
  if (!login) {
    throw new Error('Not logged in. Open the SBC Signer Extension to log in.');
  }
  if (login.type === 'nsec') {
    const decoded = nip19.decode(login.data.nsec);
    if (decoded.type !== 'nsec') {
      throw new Error('Stored nsec is invalid.');
    }
    const privateKeyHex = Buffer.from(decoded.data).toString('hex');
    return signPsbtLocal(psbtHex, privateKeyHex);
  }
  if (login.type === 'bunker') {
    const signer = buildBunkerSigner(login);
    // NConnectSigner exposes `cmd` as a JS-public method even though it's
    // typed as private. Use it to send a `sign_psbt` RPC over NIP-46.
    type CmdFn = (method: string, params: string[]) => Promise<string>;
    const cmd = (signer as unknown as { cmd: CmdFn }).cmd;
    if (typeof cmd !== 'function') {
      throw new Error('Bunker signer does not support PSBT signing.');
    }
    try {
      return await cmd.call(signer, 'sign_psbt', [psbtHex]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Your remote signer doesn't support sending Bitcoin (sign_psbt). ${msg}`,
        { cause: err },
      );
    }
  }
  if (login.type === 'extension') {
    throw new Error('Extension login cannot be used from inside an extension signer.');
  }
  throw new Error(`Unsupported login type: ${String(login.type)}`);
}
