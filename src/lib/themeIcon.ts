/**
 * Render the SBC logo in brand blue for browser favicons and the toolbar.
 * Profile themes may change the UI, but browser icons retain the brand color.
 * Mirror blue into extension storage so the background repaints tab overrides.
 */

import logoUrl from '@/assets/logo.svg';
import { extStorage, STORAGE_KEYS } from '@/extension/storage';

/** Sizes Chrome can ask for via `default_icon`. */
const TOOLBAR_ICON_SIZES = [16, 32, 48, 128] as const;

/** Single high-DPI size used for the page favicon. */
const FAVICON_SIZE = 128;

// Cache the loaded SVG as a blob URL across renders so we only fetch
// the bundled asset once per page load.
let svgBlobUrl: string | null = null;
let svgBlobPromise: Promise<string> | null = null;

async function getSvgBlobUrl(): Promise<string> {
  if (svgBlobUrl) return svgBlobUrl;
  if (!svgBlobPromise) {
    svgBlobPromise = (async () => {
      const resp = await fetch(logoUrl);
      const text = await resp.text();
      const blob = new Blob([text], { type: 'image/svg+xml' });
      svgBlobUrl = URL.createObjectURL(blob);
      return svgBlobUrl;
    })();
  }
  return svgBlobPromise;
}

/** Load the logo SVG as an Image, ready to draw on a canvas. */
function loadLogoImage(): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    getSvgBlobUrl()
      .then((url) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to load logo'));
        img.src = url;
      })
      .catch(reject);
  });
}

/** Draw the logo silhouette filled with `colorHex` into a fresh canvas. */
function drawTintedIcon(img: HTMLImageElement, size: number, colorHex: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2d context unavailable');

  ctx.fillStyle = colorHex;
  ctx.fillRect(0, 0, size, size);

  // Keep only the pixels where the SVG silhouette is opaque.
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(img, 0, 0, size, size);

  return canvas;
}

/** Update the document's `<link rel="icon">` to a tinted PNG of the logo. */
function applyFavicon(canvas: HTMLCanvasElement): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/png';
  link.href = canvas.toDataURL('image/png');
}

/**
 * Build the multi-size `imageData` map `chrome.action.setIcon` expects
 * for the toolbar action icon.
 */
async function buildToolbarImageData(
  img: HTMLImageElement,
  colorHex: string,
): Promise<Record<number, ImageData>> {
  const out: Record<number, ImageData> = {};
  for (const size of TOOLBAR_ICON_SIZES) {
    const canvas = drawTintedIcon(img, size, colorHex);
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    out[size] = ctx.getImageData(0, 0, size, size);
  }
  return out;
}

/** Apply the blue browser icons when the active profile theme is refreshed. */
export async function applyThemedIcon(_primaryHsl: string): Promise<void> {
  // Browser icons retain the SBC brand color regardless of the profile theme.
  const colorHex = '#0098ea';

  // Persist first so even if the canvas work fails (e.g. pre-rendering
  // bug), the SW still has the right color to render with on its own.
  await extStorage.set(STORAGE_KEYS.themePrimary, colorHex);

  let img: HTMLImageElement;
  try {
    img = await loadLogoImage();
  } catch {
    return; // SVG fetch failed; leave existing icon in place.
  }

  // Page favicon.
  try {
    const canvas = drawTintedIcon(img, FAVICON_SIZE, colorHex);
    applyFavicon(canvas);
  } catch {
    // Non-fatal — favicon stays at whatever the HTML default was.
  }

  // Toolbar action icon. Available in extension pages too, not just
  // the background worker.
  if (typeof chrome !== 'undefined' && chrome.action?.setIcon) {
    try {
      const imageData = await buildToolbarImageData(img, colorHex);
      await chrome.action.setIcon({ imageData });
    } catch {
      // Tab/context might be gone; SW will retry on next storage event.
    }
  }
}

/**
 * Drop the persisted primary color and revert the toolbar action icon
 * to the manifest's `default_icon`. The page favicon is left as-is —
 * the next page load will re-render based on whatever theme is active.
 */
export async function clearThemedIcon(): Promise<void> {
  await extStorage.remove(STORAGE_KEYS.themePrimary);

  if (typeof chrome !== 'undefined' && chrome.action?.setIcon) {
    try {
      // Passing `path` reverts to the manifest's static icons.
      await chrome.action.setIcon({
        path: {
          16: 'public/icons/icon-16.png',
          32: 'public/icons/icon-32.png',
          48: 'public/icons/icon-48.png',
          128: 'public/icons/icon-128.png',
        },
      });
    } catch {
      // Non-fatal.
    }
  }
}

// ─── Live --primary resolution ────────────────────────────────────────

const HSL_RE = /^\s*hsla?\(\s*(\d+(?:\.\d+)?)(?:deg)?\s*[, ]\s*(\d+(?:\.\d+)?)%\s*[, ]\s*(\d+(?:\.\d+)?)%/i;

/**
 * Read the live `--primary` CSS custom property from `:root` and
 * return it as a Ditto-style HSL string (e.g. "270 65% 55%"). Returns
 * undefined if `--primary` isn't an `hsl(...)` value (shouldn't
 * happen with our index.css + themeApply combo, but defensive).
 *
 * Used to recolor the page favicon and toolbar action icon to match
 * the *current* default primary (which may itself depend on the OS
 * `prefers-color-scheme`) when the user has no profile theme applied.
 */
function readCurrentPrimaryHsl(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--primary');
  const m = raw.match(HSL_RE);
  if (!m) return undefined;
  return `${m[1]} ${m[2]}% ${m[3]}%`;
}

/**
 * Recolor the favicon + toolbar action icon to match the live
 * `--primary` CSS variable. Useful at app startup and whenever the
 * theme is cleared, so the icon tracks SBC's default light/dark
 * default that follows the OS `prefers-color-scheme`.
 */
export async function applyThemedIconFromCurrentCss(): Promise<void> {
  const hsl = readCurrentPrimaryHsl();
  if (!hsl) return;
  await applyThemedIcon(hsl);
}
