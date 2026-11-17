# SBC Signer Extension

A Nostr signer browser extension. Log into any Nostr client, and comment on any webpage from your browser.

Log into Nostr once through the extension, and every Nostr app in your browser can ask it to sign on your behalf — with an Alby-style, per-method permission prompt the first time a site asks.

Built on [MKStack](https://soapbox.pub/mkstack): React 19, TailwindCSS 4, shadcn/ui, Nostrify, Vite, `@crxjs/vite-plugin` for Chromium packaging, and `web-ext` for Firefox validation/packaging.

## Features

- **Signer API** ([NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md)): `getPublicKey`, `getRelays`, `signEvent`, `nip04.encrypt/decrypt`, `nip44.encrypt/decrypt`
- **Multiple login methods**: `nsec`, NIP-46 `bunker://` URI, and QR-code-driven `nostrconnect://` — all inherited from `@nostrify/react`'s login UI.
- **Per-site, per-method permissions**: allow once, always allow, or reject. Managed from the popup or the full options page.
- **Shared state**: popup, options page, and background context all share login state via extension-local storage.

## Architecture

```
Page (main world)    ◀─ postMessage ─▶   Content script   ◀─ runtime messaging ─▶   Background
  `window.nostr`                         (isolated world)                          (router + signer)
                                                                                      │
                                                   ┌──────────────────────────────────┤
                                                   ▼                                  ▼
                                         Popup (toolbar)                     Prompt window
                                         login, site list                    approve / deny
```

- `src/extension/inpage.ts` — declared as a `"world": "MAIN"` content script; exposes `window.nostr`.
- `src/extension/content.ts` — bridge (page ↔ background).
- `src/extension/background.ts` — routes RPC calls, opens prompt windows, signs with `NSecSigner` or `NConnectSigner`.
- `src/extension/permissions.ts`, `storage.ts`, `signer.ts` — supporting modules.
- `src/pages/Popup.tsx`, `Prompt.tsx`, `Options.tsx` — React surfaces.

## Development

```bash
# install (also runs on every `dev`/`build` script)
npm install

# build a loadable Chromium extension into dist/chrome/
npm run build:chrome

# build a Firefox-ready extension into dist/firefox/
npm run build:firefox

# validate or package the Firefox build
npm run lint:firefox
npm run package:firefox

# run Chromium dev server with HMR for the React pages (content/inpage scripts
# require a rebuild; a reload from chrome://extensions is enough)
npm run dev:chrome
```

### Loading the Chromium extension

1. `npm run build:chrome`
2. Go to `chrome://extensions` (or the Chromium-family equivalent).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `dist/chrome/` folder.
5. Pin the extension, click its icon, and log in.

Visit any Nostr app (e.g. [jumble.social](https://jumble.social)) and click its "Log in with extension" button — SBC Signer Extension will prompt, then sign.

### Loading the Firefox extension

1. `npm run build:firefox`
2. Go to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on**.
4. Select `dist/firefox/manifest.json`.
5. Pin the extension, click its icon, and log in.

The Firefox build reuses the same bundled code as the Chromium build, but rewrites the Manifest V3 background entry from Chrome's service worker form to Firefox's background script form and adds AMO-required Gecko metadata.

### Testing and linting

```bash
npm test            # tsc + eslint + vitest + Chrome build + Firefox build/lint
```

### Versioning and releases

The version lives in `package.json` and is the single source of truth. Builds stamp it into the extension manifest, and the Settings page shows it in its footer. `src/manifest.json` keeps a copy that `scripts/sync-version.mjs` updates automatically.

To ship a new version:

```bash
npm version patch   # or minor / major — bumps package.json, package-lock.json and src/manifest.json, commits, and tags vX.Y.Z
git push --follow-tags
```

On every push to `main`, the [Release workflow](.github/workflows/release.yml) checks whether a GitHub Release exists for the current version. If not, it runs `npm test`, builds the Chrome and Firefox packages, and publishes a `vX.Y.Z` release with `sbc-signer-extension-chrome-X.Y.Z.zip` and `sbc-signer-extension-firefox-X.Y.Z.zip` attached. Pushes that don't change the version publish nothing.

Versions must be plain `MAJOR.MINOR.PATCH` integers. Browsers reject pre-release suffixes such as `-beta.1` in an extension version.

## Security notes

- Your `nsec` is stored in plaintext in extension-local storage. Any code running inside the extension can read it — keep the code tree small and audit new dependencies carefully.
- Pages only ever receive the signer's *outputs* (pubkey, signed events, ciphertexts) — never the raw key.
- Permissions are per-origin, per-method. Denial is one-shot by default; persistent denial lives in the popup/options list.

## License

GPL-3.0. See [LICENSE](./LICENSE).

## Rebranding compatibility

The package and UI are branded as SBC Signer Extension (`sbc-signer-extension`). Existing storage keys retain the `ditto-extension:` namespace so accounts, permissions, settings, and cached profile themes remain available when upgrading under the same browser extension identity. Firefox builds use the new ID `sbc-signer-extension@extensions.local`; Firefox treats this as a separate extension, so existing installations require account and settings setup again. Upstream references and external Ditto service URLs remain unchanged.
