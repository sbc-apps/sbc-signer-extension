# Privacy Policy

_Last updated: 2026-05-12_

This privacy policy describes how the **SBC Signer Extension** (the
"extension") handles your data. The extension is open source — anything
described here can be verified by reading the source code in this
repository.

## Summary

- **The extension has no servers and no backend.** Nothing about you,
  your keys, your activity, or the sites you visit is sent to the
  developers or to any third party operated by the developers.
- **Your private key never leaves your device** through the extension.
  It is stored locally in the browser's extension storage and is used only to
  fulfill cryptographic operations that you explicitly approve.
- **The extension does not include any analytics, telemetry, tracking,
  advertising, or remote logging.**

## What the extension is

The extension is a [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md)
Nostr signer. It injects a `window.nostr` API into web pages so that
Nostr applications can ask your browser — rather than asking you for
your private key directly — to:

- read your Nostr public key (`getPublicKey`);
- read your relay list (`getRelays`);
- sign Nostr events (`signEvent`);
- encrypt or decrypt messages with NIP-04 or NIP-44.

It also supports signing Bitcoin PSBTs with the same key, when a page
explicitly requests it.

Each request from a page is gated by per-site, per-method permissions
that you control.

## Data the extension stores locally

All of the following is stored on **your device only**, in the browser's
extension-local storage (`chrome.storage.local` / `browser.storage.local`). None
of it is transmitted to the developers.

1. **Your login material.** This is one of:
   - a Nostr private key (`nsec`) you imported, or
   - a [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md)
     "bunker" connection (a remote-signer URL plus an ephemeral client
     key that the extension generates locally to talk to that remote
     signer).

    This material is read by the extension's background context when a page
    requests a signature, encryption, or decryption.

2. **Your connected-sites list.** For each site you have connected to
   the extension, the extension stores:
   - the site's origin (e.g. `https://example.com`),
   - the site's title and favicon (captured from the active tab so the
     popup can show a recognizable entry),
   - the per-method permissions you have granted or denied,
   - per-event-kind `signEvent` rules you have granted or denied,
   - the timestamp of the last interaction.

3. **Extension preferences**, such as the active theme color.

You can erase all of this at any time by removing the extension or by
clearing the extension's storage from `chrome://extensions`.

## Data the extension processes but does not store

When a page calls `window.nostr`, the extension's background context briefly
handles request payloads in memory in order to fulfill the call:

- **Events to sign.** The page provides an unsigned Nostr event. The
  extension signs it with your key and returns the signed event to the
  page. The unsigned event, the signed event, and your private key are
  not written to disk by the extension and are not transmitted anywhere
  by the extension.
- **NIP-04 / NIP-44 plaintext and ciphertext.** The page provides a
  counterparty pubkey and either plaintext to encrypt or ciphertext to
  decrypt. The extension performs the cryptographic operation locally
  and returns the result to the page. The plaintext, ciphertext, and
  your private key are not written to disk by the extension and are not
  transmitted anywhere by the extension.
- **Bitcoin PSBTs.** The page provides a hex-encoded PSBT. The
  extension signs the matching inputs locally and returns the signed
  PSBT. The PSBT and your private key are not written to disk by the
  extension and are not transmitted anywhere by the extension.

## Network connections the extension makes

The extension makes network connections **only** when needed to
fulfill a call you have authorized:

- **Bunker logins (NIP-46).** If you log in with a bunker URL, the
  extension connects to the relay you specified in that URL in order
  to forward signing requests to your remote signer. No data is sent
  to the developers; the relay is one you (or your bunker provider)
  chose.

The extension does not make network connections for analytics,
telemetry, update pings, crash reporting, advertising, or any other
purpose unrelated to signing.

## Permissions the extension requests, and why

- **`storage`** — to keep your login, your connected-sites list, and
  your preferences in extension-local storage.
- **Host access (`<all_urls>`)** — required by Manifest V3 in order to
  inject the `window.nostr` API into pages so that Nostr web apps can
  call it. The content script does not read page contents; it only
  relays NIP-07 messages between the page and the extension's
  background context.

## What the extension does **not** do

- It does not collect, transmit, or sell any personal information.
- It does not include analytics, telemetry, tracking, advertising,
  fingerprinting, A/B testing, remote configuration, or remote
  logging.
- It does not read or modify the contents of pages you visit beyond
  injecting the `window.nostr` API.
- It does not share your data with third parties.
- It does not use your data for creditworthiness or lending purposes.
- It does not use your data for any purpose unrelated to its single
  purpose of being a Nostr signer.

## Third parties

The extension does not communicate with any servers operated by the
developers. It does communicate, on your behalf and at your direction,
with:

- **Your bunker / remote signer**, if you choose to log in with a
  bunker URL. The relay and remote signer are operated by whoever you
  chose; their privacy practices are governed by them, not by this
  extension.
- **Nostr relays and Nostr web apps you visit.** When you authorize a
  page to call `window.nostr`, the result of that call (your public
  key, a signed event, ciphertext, etc.) is returned to that page,
  which may then transmit it onward over the Nostr network. This is
  the same data flow that would occur if you used any other NIP-07
  signer, and it happens because you authorized it.

## Children

The extension is not directed at children and does not knowingly
collect data from anyone, of any age.

## Changes to this policy

If the extension's data handling ever changes, this document will be
updated in the same repository so the change is visible in the
project's git history.

## Contact

For questions about this policy, please open an issue in the
repository where this file is hosted.
