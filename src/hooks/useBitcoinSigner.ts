import { useCallback } from 'react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrLogin } from '@nostrify/react/login';
import {
  buildUnsignedSilentPaymentPsbt,
  signPsbtLocal,
  type UTXO,
  type UnsignedSilentPaymentPsbt,
} from '@/lib/bitcoin';
import { nip19 } from 'nostr-tools';

/**
 * Hook that exposes Bitcoin PSBT signing for the extension's own UI
 * (popup / options / wallet page).
 *
 * Unlike a regular Nostr web app, the extension has direct access to
 * the active login (it's the one storing it), so the popup signs
 * locally without going through the `chrome.runtime` RPC path that
 * external pages take. The fast path mirrors the background's
 * `signPsbtForActiveLogin` for nsec logins; bunker logins reach the
 * remote signer via a chrome.runtime call into the background so we
 * don't have to maintain a duplicate NIP-46 connection from the popup.
 *
 * `extension` logins are rejected: the in-extension wallet UI does not
 * recursively call `window.nostr` on itself.
 */
export function useBitcoinSigner() {
  const { user } = useCurrentUser();
  const { logins } = useNostrLogin();
  const loginType = logins[0]?.type;

  const canSignPsbt = !!user && (loginType === 'nsec' || loginType === 'bunker');

  /**
   * BIP352 silent payments require the sender's *raw* private key on the
   * device that builds the transaction (to compute the BIP341-tweaked scalar
   * and run the ECDH that picks the recipient's output address). NIP-46
   * bunker signers do not expose this, so silent payment sends are only
   * available with nsec logins.
   */
  const canSendSilentPayment = !!user && loginType === 'nsec';

  const signPsbt = useCallback(
    async (psbtHex: string): Promise<string> => {
      const login = logins[0];
      if (!login) throw new Error('Not logged in.');

      if (login.type === 'nsec') {
        const decoded = nip19.decode(login.data.nsec);
        if (decoded.type !== 'nsec') {
          throw new Error('Stored nsec is invalid.');
        }
        const privateKeyHex = Buffer.from(decoded.data).toString('hex');
        return signPsbtLocal(psbtHex, privateKeyHex);
      }

      if (login.type === 'bunker') {
        // Delegate to the background, which already maintains the
        // NIP-46 relay connection. We talk to ourselves over
        // chrome.runtime — the background's `signer-rpc` handler
        // accepts a `signPsbt` method and calls
        // `signPsbtForActiveLogin` internally. We bypass the prompt
        // flow because this call is happening *inside* the extension
        // UI; the user already opted in by clicking Send in our own
        // wallet.
        if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
          throw new Error('Extension runtime unavailable.');
        }
        const result = (await chrome.runtime.sendMessage({
          kind: 'internal-sign-psbt',
          psbtHex,
        })) as { result?: string; error?: string } | undefined;
        if (!result) throw new Error('No response from background.');
        if (result.error) throw new Error(result.error);
        if (typeof result.result !== 'string') {
          throw new Error('Background returned an invalid response.');
        }
        return result.result;
      }

      throw new Error(
        "Your login can't sign Bitcoin transactions. Try logging in with your secret key.",
      );
    },
    [logins],
  );

  /**
   * Build an unsigned PSBT for a BIP352 silent payment send.
   *
   * The recipient's on-chain P2TR address depends on the input set's
   * tweaked private key, so this step needs the raw nsec. Bunker logins
   * are rejected. The returned PSBT is signed with the same `signPsbt`
   * function as a regular send.
   */
  const buildSilentPaymentPsbt = useCallback(
    (
      spAddress: string,
      amountSats: number,
      utxos: UTXO[],
      feeRate: number,
    ): UnsignedSilentPaymentPsbt => {
      const login = logins[0];
      if (!login) throw new Error('Not logged in.');
      if (login.type !== 'nsec') {
        throw new Error(
          'Silent payments require logging in with your secret key. Remote signers cannot build silent payment outputs.',
        );
      }
      const decoded = nip19.decode(login.data.nsec);
      if (decoded.type !== 'nsec') {
        throw new Error('Stored nsec is invalid.');
      }
      const privateKeyHex = Buffer.from(decoded.data).toString('hex');
      return buildUnsignedSilentPaymentPsbt(
        privateKeyHex,
        spAddress,
        amountSats,
        utxos,
        feeRate,
      );
    },
    [logins],
  );

  return {
    /**
     * True when the active login can sign PSBTs (nsec or bunker).
     * False for `extension` logins or when not logged in.
     */
    canSignPsbt,
    /**
     * True when the active login can build BIP352 silent payment outputs.
     * Stricter than `canSignPsbt` — only `nsec` qualifies, because the
     * sender's raw private key is needed before signing.
     */
    canSendSilentPayment,
    /** Sign a hex-encoded PSBT. Throws on failure. */
    signPsbt: canSignPsbt ? signPsbt : null,
    /**
     * Build a silent payment PSBT. Throws if the active login can't do it.
     * Returns the unsigned PSBT plus the resolved on-chain P2TR address.
     */
    buildSilentPaymentPsbt: canSendSilentPayment ? buildSilentPaymentPsbt : null,
  };
}
