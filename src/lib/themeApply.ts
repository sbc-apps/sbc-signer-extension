/**
 * Apply / clear a parsed Active Profile Theme (kind 16767) on the
 * extension's popup, prompt, and options pages.
 *
 * Three independent style sheets are managed:
 *   - #theme-vars   — :root color tokens derived from the 3 c-tags.
 *   - #theme-fonts  — global font-family override + --title-font-family
 *                     CSS variable + injected @font-face rules for any
 *                     remote https font URLs from the f-tags.
 *   - #theme-bg     — body background image (cover or tile) from the
 *                     bg-tag.
 *
 * All injected CSS values originate in untrusted Nostr event data and
 * MUST be sanitised before interpolation:
 *   - URLs go through sanitizeUrl() (https-only, percent-encoded).
 *   - font-family names go through sanitizeCssString() (Unicode letters,
 *     numbers, spaces, hyphens, underscores, apostrophes, periods).
 */

import { deriveTokensFromCore, type ThemeTokens } from '@/lib/colorUtils';
import { sanitizeUrl } from '@/lib/sanitizeUrl';
import { applyThemedIcon, applyThemedIconFromCurrentCss, clearThemedIcon } from '@/lib/themeIcon';
import type { CoreThemeColors, ThemeBackground, ThemeFont } from '@/lib/themeEvent';

// ─── Style element IDs ────────────────────────────────────────────────

const VARS_STYLE_ID = 'theme-vars';
const FONTS_STYLE_ID = 'theme-fonts';
const BG_STYLE_ID = 'theme-bg';

// ─── Sanitisation ─────────────────────────────────────────────────────

/**
 * Allowlist for non-URL strings interpolated into CSS (e.g. `font-family`).
 * Keeps Unicode letters/numbers, spaces, hyphens, underscores, apostrophes,
 * and periods. Everything else is stripped, blocking CSS-string breakout
 * via `"`, `)`, `}`, `;`, etc.
 */
function sanitizeCssString(value: string): string {
  return value.replace(/[^\p{L}\p{N} _\-'.]/gu, '');
}

// ─── Color token application ──────────────────────────────────────────

/** Default fallback font stack used both before any custom font loads and as a fallback. */
const DEFAULT_FONT_STACK = 'system-ui, sans-serif';

/** camelCase → kebab-case for CSS custom property names. */
function toThemeVar(key: string): string {
  return `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * Apply the derived ThemeTokens as CSS custom properties on `:root`.
 * Each token is wrapped in `hsl(...)` so it composes with the
 * extension's existing `--background: hsl(...)` declarations.
 *
 * The injected rules use !important and target both `:root` and the
 * `(prefers-color-scheme: dark) :root` block in index.css, so the user's
 * theme wins regardless of the OS color-scheme preference.
 */
function applyTokens(tokens: ThemeTokens): void {
  const decls = (Object.entries(tokens) as [string, string][])
    .map(([k, v]) => `${toThemeVar(k)}: hsl(${v}) !important;`)
    .join(' ');

  // Repeat the rule under the dark media query so it overrides the
  // built-in dark block in index.css when the OS reports dark mode.
  const css = `:root { ${decls} } @media (prefers-color-scheme: dark) { :root { ${decls} } }`;

  let style = document.getElementById(VARS_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = VARS_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = css;
}

function clearTokens(): void {
  document.getElementById(VARS_STYLE_ID)?.remove();
}

// ─── Font application ─────────────────────────────────────────────────

/**
 * Build CSS rules for the body and title fonts:
 *   - `@font-face` declarations for any remote https font URLs.
 *   - `html { font-family: …; }` global override (when a body font exists).
 *   - `:root { --title-font-family: …; }` CSS variable (when a title font exists).
 *
 * Components rendering the user's display name (e.g. SiteHeader) can
 * read `var(--title-font-family)` via Tailwind arbitrary properties.
 */
function buildFontCss(font: ThemeFont | undefined, titleFont: ThemeFont | undefined): string {
  const blocks: string[] = [];
  const seenFaces = new Set<string>();

  function addFontFace(f: ThemeFont): string | undefined {
    const family = sanitizeCssString(f.family);
    if (!family) return undefined;
    const url = f.url ? sanitizeUrl(f.url) : undefined;
    const key = `${family}|${url ?? ''}`;
    if (url && !seenFaces.has(key)) {
      seenFaces.add(key);
      blocks.push(
        `@font-face { font-family: "${family}"; src: url("${url}"); font-display: swap; }`,
      );
    }
    return family;
  }

  const bodyFamily = font ? addFontFace(font) : undefined;
  const titleFamily = titleFont ? addFontFace(titleFont) : undefined;

  if (bodyFamily) {
    blocks.push(`html { font-family: "${bodyFamily}", ${DEFAULT_FONT_STACK} !important; }`);
  }
  if (titleFamily) {
    blocks.push(`:root { --title-font-family: "${titleFamily}", ${DEFAULT_FONT_STACK}; }`);
  }

  return blocks.join('\n');
}

function applyFonts(font: ThemeFont | undefined, titleFont: ThemeFont | undefined): void {
  const css = buildFontCss(font, titleFont);

  let style = document.getElementById(FONTS_STYLE_ID) as HTMLStyleElement | null;
  if (!css) {
    style?.remove();
    return;
  }

  if (!style) {
    style = document.createElement('style');
    style.id = FONTS_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = css;
}

function clearFonts(): void {
  document.getElementById(FONTS_STYLE_ID)?.remove();
}

// ─── Background application ───────────────────────────────────────────

/** Style element ID for the page-shell transparency override. */
const PAGE_BG_STYLE_ID = 'theme-page-bg';

function applyBackground(bg: ThemeBackground | undefined): void {
  // sanitizeUrl was already enforced at parse time, but re-check defensively.
  const url = bg ? sanitizeUrl(bg.url) : undefined;

  let style = document.getElementById(BG_STYLE_ID) as HTMLStyleElement | null;
  let pageStyle = document.getElementById(PAGE_BG_STYLE_ID) as HTMLStyleElement | null;
  if (!url) {
    style?.remove();
    pageStyle?.remove();
    return;
  }

  const mode = bg?.mode ?? 'cover';
  const css = mode === 'tile'
    ? `body { background-image: url("${url}"); background-repeat: repeat; background-size: auto; }`
    : `body { background-image: url("${url}"); background-size: cover; background-repeat: no-repeat; background-position: center; background-attachment: fixed; }`;

  if (!style) {
    style = document.createElement('style');
    style.id = BG_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = css;

  // While a bg image is active, drop the page shell's solid surface so
  // the image painted on <body> shows through. The `bg-page` utility on
  // the popup, prompt, and options page wrappers reads `--page-bg`,
  // which defaults to `--background`. Switching it to `transparent`
  // here makes the shells see-through without affecting modal /
  // popover / dropdown surfaces (those use `--background`, `--popover`,
  // `--card` directly so they remain opaque and stay readable).
  if (!pageStyle) {
    pageStyle = document.createElement('style');
    pageStyle.id = PAGE_BG_STYLE_ID;
    document.head.appendChild(pageStyle);
  }
  pageStyle.textContent = ':root { --page-bg: transparent !important; }';
}

function clearBackground(): void {
  document.getElementById(BG_STYLE_ID)?.remove();
  document.getElementById(PAGE_BG_STYLE_ID)?.remove();
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Subset of a parsed kind 16767 event that's needed to render.
 * Both the live `ActiveProfileTheme` from useActiveProfileTheme and the
 * `CachedThemePayload` from themeCache satisfy this shape, so the same
 * apply function works for both code paths (sync boot + async refresh).
 */
export interface ApplicableTheme {
  colors: CoreThemeColors;
  font?: ThemeFont;
  titleFont?: ThemeFont;
  background?: ThemeBackground;
}

/** Apply a parsed kind 16767 theme. Idempotent. */
export function applyActiveProfileTheme(theme: ApplicableTheme): void {
  const tokens = deriveTokensFromCore(
    theme.colors.background,
    theme.colors.text,
    theme.colors.primary,
  );
  applyTokens(tokens);
  applyFonts(theme.font, theme.titleFont);
  applyBackground(theme.background);
  // Recolor the page favicon and the browser toolbar action icon to
  // match the new primary. Fire-and-forget — the icon work is purely
  // cosmetic and shouldn't block the synchronous CSS apply.
  applyThemedIcon(theme.colors.primary).catch(() => {});
}

/** Remove all theme overrides previously applied by applyActiveProfileTheme. */
export function clearActiveProfileTheme(): void {
  clearTokens();
  clearFonts();
  clearBackground();
  // After removing the runtime overrides, the default --primary from
  // index.css (which itself follows prefers-color-scheme) is what's
  // active. Recolor the icon to match instead of bouncing it back to
  // the static manifest asset, so a logged-out user in dark mode
  // still sees the SBC primary on their toolbar.
  applyThemedIconFromCurrentCss().catch(() => {
    // If reading --primary failed for some reason, fall back to the
    // manifest icon so we don't leave the previous user's theme tint.
    clearThemedIcon().catch(() => {});
  });
}
