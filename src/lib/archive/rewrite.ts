/**
 * Asset discovery and URL rewriting for page archives.
 *
 * The archive is a NIP-5A manifest, which maps absolute paths to blob
 * hashes. So a captured page becomes:
 *
 *   /index.html                 the serialized DOM
 *   /assets/<sha256>.<ext>      every image, stylesheet, font, media file
 *
 * Naming assets by content hash means identical bytes collapse to one
 * blob within a page and across archives, and the extension in the path
 * matters because gateways infer `Content-Type` from it when the
 * Blossom server doesn't supply one.
 *
 * Everything here operates on an *inert* `Document` from `DOMParser`,
 * never on a live one — the archive window must never attach hostile
 * captured markup to itself.
 */

/** Schemes that are already self-contained or impossible to refetch. */
const SKIP_SCHEME = /^(data|blob|about|javascript|mailto|tel):/i;

/** A same-document reference, e.g. `#section-2`. */
const FRAGMENT_ONLY = /^#/;

/**
 * Elements and attributes that reference a subresource the archive
 * needs its own copy of. Deliberately excludes `<a href>` — links out
 * of the page stay pointing at the live web.
 */
const URL_ATTRS: Array<[selector: string, attr: string]> = [
  ['img[src]', 'src'],
  ['img[srcset]', 'srcset'],
  ['source[src]', 'src'],
  ['source[srcset]', 'srcset'],
  ['video[src]', 'src'],
  ['video[poster]', 'poster'],
  ['audio[src]', 'src'],
  ['embed[src]', 'src'],
  ['object[data]', 'data'],
  ['track[src]', 'src'],
  ['input[type="image"][src]', 'src'],
  ['link[rel~="icon"][href]', 'href'],
  ['link[rel~="apple-touch-icon"][href]', 'href'],
  ['link[rel~="stylesheet"][href]', 'href'],
];

/** Attributes carrying a comma-separated candidate list rather than one URL. */
const SRCSET_ATTRS = new Set(['srcset']);

/** Resolves an absolute source URL to its archive path, if archived. */
export type ResolveAsset = (url: string) => string | undefined;

/** Whether a URL is worth fetching as a separate blob. */
export function isFetchableUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (SKIP_SCHEME.test(trimmed)) return false;
  return /^https?:/i.test(trimmed);
}

/** Resolve `url` against `base`, returning undefined if it can't be. */
export function absolutize(url: string, base: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// srcset
// ---------------------------------------------------------------------------

export interface SrcsetCandidate {
  url: string;
  /** Density or width descriptor, e.g. `2x` or `480w`. May be empty. */
  descriptor: string;
}

/**
 * Parse a `srcset` attribute.
 *
 * Follows the HTML spec's tokenizer closely enough to survive `data:`
 * URIs, which contain commas and would break a naive `split(',')`.
 */
export function parseSrcset(input: string): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  let i = 0;

  while (i < input.length) {
    while (i < input.length && /[\s,]/.test(input[i])) i++;
    if (i >= input.length) break;

    const start = i;
    while (i < input.length && !/\s/.test(input[i])) i++;
    let url = input.slice(start, i);

    // Trailing commas terminate the candidate; the descriptor is empty.
    let hadTrailingComma = false;
    while (url.endsWith(',')) {
      url = url.slice(0, -1);
      hadTrailingComma = true;
    }

    if (hadTrailingComma) {
      if (url) out.push({ url, descriptor: '' });
      continue;
    }

    while (i < input.length && /\s/.test(input[i])) i++;
    const descStart = i;
    while (i < input.length && input[i] !== ',') i++;
    const descriptor = input.slice(descStart, i).trim();
    if (i < input.length) i++; // consume the separator

    if (url) out.push({ url, descriptor });
  }

  return out;
}

export function serializeSrcset(candidates: SrcsetCandidate[]): string {
  return candidates
    .map(({ url, descriptor }) => (descriptor ? `${url} ${descriptor}` : url))
    .join(', ');
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/**
 * `url(...)` in any of its three quoting forms, plus bare `@import "…"`.
 * Capture groups are ordered so exactly one of 2/3/4 is set per match.
 */
const CSS_URL_RE =
  /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s][^)]*?))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi;

function cssMatchUrl(match: RegExpExecArray): string | undefined {
  return match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
}

/** Every fetchable absolute URL referenced by a stylesheet. */
export function extractCssUrls(css: string, baseUrl: string): string[] {
  const out = new Set<string>();
  CSS_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CSS_URL_RE.exec(css)) !== null) {
    const raw = cssMatchUrl(match);
    if (!raw) continue;
    const abs = absolutize(raw, baseUrl);
    if (abs && isFetchableUrl(abs)) out.add(abs);
  }

  return [...out];
}

/**
 * Rewrite a stylesheet's references to archive paths.
 *
 * URLs that weren't archived (fetch failed, over the size cap, or a
 * scheme we skip) are absolutized instead, so the archived page still
 * points at something real rather than a path that resolves to nothing.
 */
export function rewriteCssUrls(css: string, baseUrl: string, resolve: ResolveAsset): string {
  CSS_URL_RE.lastIndex = 0;
  return css.replace(CSS_URL_RE, (whole, ...groups: unknown[]) => {
    const raw = (groups.slice(0, 5).find((g) => typeof g === 'string') ?? '') as string;
    if (!raw) return whole;

    const abs = absolutize(raw, baseUrl);
    if (!abs) return whole;

    const replacement = resolve(abs) ?? abs;
    return whole.startsWith('@') ? `@import "${replacement}"` : `url("${replacement}")`;
  });
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** Every fetchable absolute subresource URL referenced by the document. */
export function collectDocumentAssets(doc: Document, baseUrl: string): string[] {
  const out = new Set<string>();

  const add = (raw: string | null): void => {
    if (!raw) return;
    const abs = absolutize(raw, baseUrl);
    if (abs && isFetchableUrl(abs)) out.add(abs);
  };

  for (const [selector, attr] of URL_ATTRS) {
    for (const element of Array.from(doc.querySelectorAll(selector))) {
      const value = element.getAttribute(attr);
      if (!value) continue;
      if (SRCSET_ATTRS.has(attr)) {
        for (const candidate of parseSrcset(value)) add(candidate.url);
      } else {
        add(value);
      }
    }
  }

  for (const element of Array.from(doc.querySelectorAll('[style]'))) {
    const style = element.getAttribute('style');
    if (style) for (const url of extractCssUrls(style, baseUrl)) out.add(url);
  }

  for (const style of Array.from(doc.querySelectorAll('style'))) {
    for (const url of extractCssUrls(style.textContent ?? '', baseUrl)) out.add(url);
  }

  return [...out];
}

/** Point every subresource reference at its archive path, in place. */
export function rewriteDocumentAssets(
  doc: Document,
  baseUrl: string,
  resolve: ResolveAsset,
): void {
  const map = (raw: string): string => {
    const abs = absolutize(raw, baseUrl);
    if (!abs) return raw;
    return resolve(abs) ?? abs;
  };

  for (const [selector, attr] of URL_ATTRS) {
    for (const element of Array.from(doc.querySelectorAll(selector))) {
      const value = element.getAttribute(attr);
      if (!value) continue;

      if (SRCSET_ATTRS.has(attr)) {
        const rewritten = parseSrcset(value).map((candidate) => ({
          ...candidate,
          url: map(candidate.url),
        }));
        element.setAttribute(attr, serializeSrcset(rewritten));
      } else {
        element.setAttribute(attr, map(value));
      }
    }
  }

  for (const element of Array.from(doc.querySelectorAll('[style]'))) {
    const style = element.getAttribute('style');
    if (style) element.setAttribute('style', rewriteCssUrls(style, baseUrl, resolve));
  }

  for (const style of Array.from(doc.querySelectorAll('style'))) {
    style.textContent = rewriteCssUrls(style.textContent ?? '', baseUrl, resolve);
  }

  // Links out of the archive must keep working, so absolutize them
  // rather than leaving relative hrefs to resolve against the gateway.
  // Fragment-only hrefs are the exception: absolutizing `#section-2`
  // would turn an in-page jump into a navigation back to the live site.
  for (const anchor of Array.from(doc.querySelectorAll('a[href], area[href]'))) {
    const href = anchor.getAttribute('href')?.trim();
    if (!href || SKIP_SCHEME.test(href) || FRAGMENT_ONLY.test(href)) continue;
    const abs = absolutize(href, baseUrl);
    if (abs) anchor.setAttribute('href', abs);
  }
}

// ---------------------------------------------------------------------------
// MIME types
// ---------------------------------------------------------------------------

const MIME_EXTENSIONS: Record<string, string> = {
  'text/css': 'css',
  'text/html': 'html',
  'text/plain': 'txt',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'application/font-woff': 'woff',
  'application/font-woff2': 'woff2',
  'application/vnd.ms-fontobject': 'eot',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'application/json': 'json',
};

/** File extension for an archive path, from the response type or URL. */
export function extensionFor(mimeType: string | null, url: string): string {
  const base = (mimeType ?? '').split(';')[0].trim().toLowerCase();
  const fromMime = MIME_EXTENSIONS[base];
  if (fromMime) return fromMime;

  try {
    const { pathname } = new URL(url);
    const match = /\.([a-z0-9]{1,8})$/i.exec(pathname);
    if (match) return match[1].toLowerCase();
  } catch {
    // fall through
  }

  return 'bin';
}

/** Archive path for a blob, e.g. `/assets/<sha256>.png`. */
export function assetPath(sha256: string, extension: string): string {
  return `/assets/${sha256}.${extension}`;
}
