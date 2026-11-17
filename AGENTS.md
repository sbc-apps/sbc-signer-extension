# Project Overview

**sbc-signer-extension** is a Chrome/Chromium and Firefox browser extension (Manifest V3) that injects a NIP-07 Nostr signer (`window.nostr`) into every page. Users log in once through the extension popup, then approve per-site, per-method permissions when Nostr apps ask to read their public key, sign events, or encrypt/decrypt with NIP-04 / NIP-44.

The extension is built on top of the [MKStack](https://soapbox.pub/mkstack) React framework. Most of the popup/options UI is the same stack as a regular Nostr web app (React 19 + TailwindCSS 4 + shadcn/ui + Nostrify + TanStack Query), so anything documented below about MKStack still applies to the popup/options/prompt surfaces. The extension-specific glue (manifest, content script, inpage provider, background context) lives under `src/extension/`.

## Technology Stack

- **React 19.x** for popup, options, and prompt UIs
- **TailwindCSS 4.x**
- **Vite + `@crxjs/vite-plugin` + `web-ext`** — builds Chromium output into `dist/chrome/`, transforms Firefox output into `dist/firefox/`, and writes Firefox ZIP artifacts into `dist/artifacts/`
- **shadcn/ui** primitives in `src/components/ui/`
- **Nostrify** (`@nostrify/nostrify`, `@nostrify/react`) for login and signing
- **TypeScript** — **never use `any`**

## Extension Architecture

```
┌─────────────────────────┐   postMessage   ┌──────────────────────┐   chrome.runtime   ┌───────────────────────────────┐
│ Page's main world       │ ◀────────────▶  │ Content script       │ ◀───────────────▶  │ Background service worker     │
│  `window.nostr` (inpage)│                 │  (isolated world)    │                    │  - permissions store          │
│                         │                 │  relays messages,    │                    │  - signer (nsec/bunker)       │
│                         │                 │  injects inpage.ts   │                    │  - opens prompt window        │
└─────────────────────────┘                 └──────────────────────┘                    └───────────────────────────────┘
                                                                                                 ▲
                                                                                                 │ chrome.runtime
                                                                                                 │
                                          ┌────────────────────┐                     ┌──────────────────────────┐
                                          │ Popup (React)      │                     │ Prompt window (React)    │
                                          │ login / logout /   │                     │ approve or deny a        │
                                          │ site permissions   │                     │ specific RPC call        │
                                          └────────────────────┘                     └──────────────────────────┘
```

Key directories:

- `src/extension/` — extension-only code
  - `manifest.json` *(outside extension/ for the vite plugin, but part of the extension)*
  - `background.ts` — service worker, RPC router, permission prompts
  - `content.ts` — content script bridge
  - `inpage.ts` — `window.nostr` implementation injected into pages
  - `messages.ts` — shared message types
  - `permissions.ts` — per-origin permission store (`chrome.storage.local`)
  - `signer.ts` — builds a `NostrSigner` from the stored login
  - `storage.ts` — `chrome.storage.local`-backed `NLoginStorage` adapter
- `src/pages/` — React pages: `Popup.tsx`, `Prompt.tsx`, `Options.tsx`
- `src/popup.html`, `src/prompt.html`, `src/options.html` — HTML entry points
- `src/components/auth/` — reused from MKStack for login UX
- `src/components/ui/` — shadcn primitives (unchanged from MKStack)

## Authentication

Login state is managed by `@nostrify/react`'s `NostrLoginProvider`, same as a regular MKStack app, but the storage backend is swapped to `extensionLoginStorage` (from `src/extension/storage.ts`) so the popup, options page, and background service worker all read the same `ditto-extension:login` key from `chrome.storage.local`.

The background worker reads that key directly (outside React) via `getActiveSigner()` in `src/extension/signer.ts`, which constructs:
  - `NSecSigner` for `nsec` logins
  - `NConnectSigner` over a cached `NRelay1` for `bunker` logins
  - Rejects `extension` logins (we can't proxy to another NIP-07 from inside a NIP-07 extension)

## Permissions Model

Permissions are keyed by `{ origin, method }` (see `src/extension/permissions.ts`). When a page calls `window.nostr.*`:

1. If the user has recorded `allow` for that origin + method, the call proceeds silently.
2. If the user has recorded `deny`, the call rejects immediately.
3. Otherwise, the background script opens a small prompt window. The user can pick:
   - **Allow once** — resolve this call; no persistence.
   - **Always allow** — persist `allow` and resolve.
   - **Reject** — reject this call; no persistence (so next call prompts again).

Persistent denials are set from the popup ("block this site").

## Design Standards (inherited from MKStack)

Responsive, WCAG 2.1 AA, 8px grid, soft depth (`rounded-lg`/`rounded-xl`, subtle shadows), skeletons for structured loading, spinners for buttons, `border-dashed` cards for empty states. Use `cn()` and `class-variance-authority` patterns already present under `src/components/ui/`.

## `window.nostr` API

The inpage provider exposes standard NIP-07:

```ts
window.nostr.getPublicKey(): Promise<string>
window.nostr.getRelays(): Promise<Record<string, { read: boolean; write: boolean }>>
window.nostr.signEvent(event): Promise<SignedEvent>
window.nostr.nip04.encrypt(pubkey, plaintext): Promise<string>
window.nostr.nip04.decrypt(pubkey, ciphertext): Promise<string>
window.nostr.nip44.encrypt(pubkey, plaintext): Promise<string>
window.nostr.nip44.decrypt(pubkey, ciphertext): Promise<string>
```

`signPsbt(psbtHex)` also accepts BIP-375 PSBTv2s carrying silent-payment
outputs (`PSBT_OUT_SP_V0_INFO`). For those the local signer computes the
global ECDH share + BIP-374 DLEQ proof per scan key, derives the
per-recipient `PSBT_OUT_SCRIPT`s, and signs. The prompt displays the
`sp1…` recipient address — not just the on-chain derived P2TR — so the
user is approving the original intent. BIP-375 over a bunker login
forwards via NIP-46's `sign_psbt` and assumes the remote signer
implements BIP-375; if it doesn't, the call surfaces a remote-signer
error.

## Validating Your Changes

**Your task is not finished until the code type-checks and builds without errors.** In priority order:

1. **Type check** (required): `npx tsc --noEmit`
2. **Build/compile** (required): `npm run build:chrome`
3. **Firefox build/lint** (required for cross-browser changes): `npm run build:firefox && npm run lint:firefox`
4. **Lint** (recommended; fix anything critical)
5. **Run tests** (if available): `npm test`
6. **Git commit** (required)

### Versioning and releases

`package.json` `version` is the single source of truth. Vite stamps it into the built manifest and exposes it to the UI as `__APP_VERSION__`. Bump it with `npm version patch|minor|major`; the `version` lifecycle script runs `scripts/sync-version.mjs` to update `src/manifest.json` in the same commit. Never edit the manifest version by hand. Pushing a new version to `main` makes `.github/workflows/release.yml` publish a GitHub Release with the Chrome and Firefox ZIPs. Versions must be plain `MAJOR.MINOR.PATCH` integers, because browsers reject pre-release suffixes. Only bump the version when the user asks for a release.

### Using Git

Use `git status` / `git diff` to review changes and `git log` to learn project conventions. If you make a mistake, `git checkout` restores files.

**Always commit when you are finished.** Non-negotiable — every completed task ends with a commit.

---

The section below is inherited from MKStack. It still applies to React code under `src/pages/`, `src/components/`, and `src/hooks/`.

## MKStack Conventions

### UI Components

Components in `@/components/ui` are unstyled, accessible primitives styled with Tailwind. They follow a consistent pattern using `React.forwardRef` and the `cn()` class-merge utility, and many are built on Radix UI primitives.

### Nostr Security Model

**CRITICAL:** Nostr private keys (`nsec`) are stored **in plaintext in `chrome.storage.local`**. Any JavaScript running in the extension can read them. Treat XSS mitigation as the top-priority security concern.

- **Never** use `dangerouslySetInnerHTML`, `innerHTML`, or `document.write` with event data, URL params, or other untrusted strings.
- Never relax CSP with `'unsafe-eval'`, `'unsafe-inline'` on `script-src`, or wildcard sources.
- Sanitize every event-sourced URL before using it as `href`, `src`, iframe `src`, or CSS `url()`.
- The extension MUST NOT expose the private key to any page — pages only ever get the signer's outputs (pubkey, signed events, ciphertexts).
