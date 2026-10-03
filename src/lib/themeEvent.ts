import type { NostrEvent } from '@nostrify/nostrify';

import { hexToHslString, isValidHex } from '@/lib/colorUtils';
import { sanitizeUrl } from '@/lib/sanitizeUrl';

// ─── Kind constants ───────────────────────────────────────────────────

/** Replaceable event: the user's currently active profile theme. One per user. */
export const ACTIVE_THEME_KIND = 16767;

// ─── Types ────────────────────────────────────────────────────────────

/** The 3 core HSL strings carried in c-tags. */
export interface CoreThemeColors {
  /** Background color, HSL string e.g. "228 20% 10%". */
  background: string;
  /** Text/foreground color. */
  text: string;
  /** Primary accent color (buttons, links, focus rings). */
  primary: string;
}

/** A font reference. URL is required on Nostr theme events; we only honor https URLs. */
export interface ThemeFont {
  /** CSS font-family name, e.g. "Playfair Display". */
  family: string;
  /** Direct https URL to a font file (.woff2, .ttf, .otf). */
  url?: string;
}

/** Background image/video configuration extracted from the imeta-style `bg` tag. */
export interface ThemeBackground {
  /** Sanitized https URL to an image or video file. */
  url: string;
  /** Display mode. */
  mode?: 'cover' | 'tile';
  /** MIME type, e.g. "image/jpeg". */
  mimeType?: string;
  /** Dimensions as "widthxheight". */
  dimensions?: string;
  /** Blurhash placeholder. */
  blurhash?: string;
}

/** A parsed kind 16767 active profile theme event. */
export interface ActiveProfileTheme {
  /** The 3 core theme colors. */
  colors: CoreThemeColors;
  /** Body font (applies globally to all text). */
  font?: ThemeFont;
  /** Title/header font (applies via the --title-font-family CSS variable). */
  titleFont?: ThemeFont;
  /** Optional background. */
  background?: ThemeBackground;
  /** Reference to the source theme definition for attribution, if any. */
  sourceRef?: string;
  /** The original Nostr event. */
  event: NostrEvent;
}

// ─── Tag parsers ──────────────────────────────────────────────────────

/** Parse `c` tags into CoreThemeColors. Returns null if any of the 3 required roles are missing. */
function parseColorTags(tags: string[][]): CoreThemeColors | null {
  const colorMap = new Map<string, string>();
  for (const tag of tags) {
    if (tag[0] === 'c' && tag[1] && tag[2]) {
      colorMap.set(tag[2], tag[1]);
    }
  }

  const bgHex = colorMap.get('background');
  const textHex = colorMap.get('text');
  const primaryHex = colorMap.get('primary');

  if (!bgHex || !textHex || !primaryHex) return null;
  if (!isValidHex(bgHex) || !isValidHex(textHex) || !isValidHex(primaryHex)) return null;

  return {
    background: hexToHslString(bgHex),
    text: hexToHslString(textHex),
    primary: hexToHslString(primaryHex),
  };
}

/**
 * Parse `f` tags into body and title fonts.
 * Per the Ditto spec the body font tag MUST appear before the title font tag,
 * so legacy tags without a role (only 3 elements) are treated as body.
 * URLs that aren't well-formed https URLs are stripped (to defeat
 * `javascript:` / `data:` injection via @font-face).
 */
function parseFontTags(tags: string[][]): { font?: ThemeFont; titleFont?: ThemeFont } {
  let font: ThemeFont | undefined;
  let titleFont: ThemeFont | undefined;

  for (const tag of tags) {
    if (tag[0] !== 'f' || !tag[1]) continue;
    const role = tag[3]; // 4th element: "body", "title", or absent (legacy = body)
    const parsed: ThemeFont = { family: tag[1] };
    const fontUrl = sanitizeUrl(tag[2]);
    if (fontUrl) parsed.url = fontUrl;

    if (role === 'title') {
      if (!titleFont) titleFont = parsed;
    } else {
      // "body" or absent → body font
      if (!font) font = parsed;
    }
  }

  return { font, titleFont };
}

/**
 * Parse the imeta-style `bg` tag into a ThemeBackground.
 * Returns undefined if no `bg` tag is present or its URL is not a valid https URL.
 */
function parseBackgroundTag(tags: string[][]): ThemeBackground | undefined {
  const bgTag = tags.find(([n]) => n === 'bg');
  if (!bgTag) return undefined;

  const kv = new Map<string, string>();
  for (let i = 1; i < bgTag.length; i++) {
    const entry = bgTag[i];
    const spaceIdx = entry.indexOf(' ');
    if (spaceIdx === -1) continue;
    kv.set(entry.slice(0, spaceIdx), entry.slice(spaceIdx + 1));
  }

  const url = sanitizeUrl(kv.get('url'));
  if (!url) return undefined;

  const bg: ThemeBackground = { url };
  const mode = kv.get('mode');
  if (mode === 'cover' || mode === 'tile') bg.mode = mode;
  const mimeType = kv.get('m');
  if (mimeType) bg.mimeType = mimeType;
  const dimensions = kv.get('dim');
  if (dimensions) bg.dimensions = dimensions;
  const blurhash = kv.get('blurhash');
  if (blurhash) bg.blurhash = blurhash;

  return bg;
}

/** Parse and validate a kind 16767 active profile theme event. Returns null if invalid. */
export function parseActiveProfileTheme(event: NostrEvent): ActiveProfileTheme | null {
  if (event.kind !== ACTIVE_THEME_KIND) return null;

  const colors = parseColorTags(event.tags);
  if (!colors) return null;

  const { font, titleFont } = parseFontTags(event.tags);
  const background = parseBackgroundTag(event.tags);
  const sourceRef = event.tags.find(([n]) => n === 'a')?.[1];

  return { colors, font, titleFont, background, sourceRef, event };
}
