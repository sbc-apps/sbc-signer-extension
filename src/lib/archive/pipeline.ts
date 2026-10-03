/**
 * Turn captured HTML into the set of blobs a NIP-5A manifest describes.
 *
 * Runs in the archive window rather than the content script, for two
 * reasons that both matter:
 *
 *  - In MV3, content scripts are subject to the *page's* CORS rules, so
 *    most subresources are unreadable from there. Extension pages
 *    inherit `host_permissions`, so they can read anything.
 *  - The popup is destroyed when it loses focus and the service worker
 *    can be evicted mid-run. A window survives both.
 *
 * Assets are fetched without credentials. The captured HTML is whatever
 * the user was looking at — including logged-in views — but there's no
 * reason to also drag the user's cookies along to every CDN.
 */
import {
  absolutize,
  assetPath,
  collectDocumentAssets,
  extensionFor,
  extractCssUrls,
  isFetchableUrl,
  rewriteCssUrls,
  rewriteDocumentAssets,
  type ResolveAsset,
} from './rewrite';
import { annotateArchiveDocument, sanitizeArchiveDocument, serializeDocument } from './sanitize';
import { hashBytes, type ArchiveBlob } from './blossom';

/** Largest single asset we'll archive. Beyond this, servers tend to refuse anyway. */
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;

/** Ceiling on the whole archive, to keep uploads bounded. */
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/** Parallel asset fetches. Enough to be quick, few enough to be polite. */
const FETCH_CONCURRENCY = 6;

const ASSET_TIMEOUT_MS = 15_000;

/** How far to follow `@import` chains before giving up. */
const MAX_CSS_DEPTH = 3;

export type ArchivePhase = 'fetching' | 'building';

export interface ArchiveProgress {
  phase: ArchivePhase;
  completed: number;
  total: number;
}

/** An asset that didn't make it into the archive, and why. */
export interface SkippedAsset {
  url: string;
  reason: string;
}

export interface BuildArchiveInput {
  /** Serialized DOM from the content script. */
  html: string;
  /** URL the page was captured from; the base for relative references. */
  sourceUrl: string;
  /** Capture time in seconds since epoch. */
  capturedAt: number;
  signal?: AbortSignal;
  onProgress?: (progress: ArchiveProgress) => void;
}

export interface BuiltArchive {
  /** Every blob to upload, `/index.html` first. */
  blobs: ArchiveBlob[];
  /** Assets that were dropped, with reasons, for the review step. */
  skipped: SkippedAsset[];
  /** Total bytes across all blobs. */
  totalBytes: number;
}

interface FetchedAsset {
  url: string;
  bytes: Uint8Array;
  mimeType: string;
  /** `@import` nesting level; deeper stylesheets are rewritten first. */
  depth: number;
}

function isCss(mimeType: string, url: string): boolean {
  if (mimeType.startsWith('text/css')) return true;
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.css');
  } catch {
    return false;
  }
}

async function fetchAsset(
  url: string,
  depth: number,
  signal: AbortSignal | undefined,
): Promise<FetchedAsset | SkippedAsset> {
  const timeout = AbortSignal.timeout(ASSET_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });

    if (!response.ok) return { url, reason: `HTTP ${response.status}` };

    // Trust the advertised length when it's there, so an oversized file
    // is rejected before it's pulled over the wire.
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
      return { url, reason: `too large (${formatBytes(declared)})` };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      return { url, reason: `too large (${formatBytes(bytes.byteLength)})` };
    }

    const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
    return { url, bytes, mimeType, depth };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return { url, reason: 'timed out' };
    }
    return { url, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Run `worker` over `items` with bounded parallelism, preserving order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  onSettled?: () => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
      onSettled?.();
    }
  });

  await Promise.all(runners);
  return results;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function buildArchive(input: BuildArchiveInput): Promise<BuiltArchive> {
  const { html, sourceUrl, capturedAt, signal, onProgress } = input;

  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Second sanitization pass — the payload crossed a message boundary
  // and was reparsed since the content script cleaned it.
  sanitizeArchiveDocument(doc);

  const skipped: SkippedAsset[] = [];
  const fetched = new Map<string, FetchedAsset>();
  const seen = new Set<string>();

  let queue = collectDocumentAssets(doc, sourceUrl).filter((url) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });

  let completed = 0;
  let discovered = queue.length;

  // Breadth-first over `@import` / `url()` chains inside stylesheets.
  for (let depth = 0; depth <= MAX_CSS_DEPTH && queue.length > 0; depth++) {
    const results = await mapWithConcurrency(
      queue,
      FETCH_CONCURRENCY,
      (url) => fetchAsset(url, depth, signal),
      () => onProgress?.({ phase: 'fetching', completed: ++completed, total: discovered }),
    );

    const nextQueue: string[] = [];

    for (const result of results) {
      if ('reason' in result) {
        skipped.push(result);
        continue;
      }

      fetched.set(result.url, result);

      if (depth < MAX_CSS_DEPTH && isCss(result.mimeType, result.url)) {
        const css = new TextDecoder().decode(result.bytes);
        for (const nested of extractCssUrls(css, result.url)) {
          if (seen.has(nested)) continue;
          seen.add(nested);
          nextQueue.push(nested);
        }
      }
    }

    queue = nextQueue;
    discovered += nextQueue.length;
  }

  onProgress?.({ phase: 'building', completed: 0, total: fetched.size + 1 });

  // Hash plain assets first — nothing references them by content, so
  // their paths are final and stylesheets can be rewritten against them.
  const resolved = new Map<string, string>();
  const blobs: ArchiveBlob[] = [];
  const resolve: ResolveAsset = (url) => resolved.get(url);

  const stylesheets: FetchedAsset[] = [];

  for (const asset of fetched.values()) {
    if (isCss(asset.mimeType, asset.url)) {
      stylesheets.push(asset);
      continue;
    }

    const hash = hashBytes(asset.bytes);
    const path = assetPath(hash, extensionFor(asset.mimeType, asset.url));
    resolved.set(asset.url, path);
    blobs.push({ path, sha256: hash, bytes: asset.bytes, mimeType: asset.mimeType || 'application/octet-stream' });
  }

  // A stylesheet's bytes change when its references are rewritten, so
  // its hash depends on its dependencies being resolved first. Deeper
  // sheets were discovered later, so rewriting deepest-first resolves
  // `@import` chains bottom-up.
  stylesheets.sort((a, b) => b.depth - a.depth);

  for (const sheet of stylesheets) {
    const original = new TextDecoder().decode(sheet.bytes);
    const rewritten = rewriteCssUrls(original, sheet.url, resolve);
    const bytes = new TextEncoder().encode(rewritten);
    const hash = hashBytes(bytes);
    const path = assetPath(hash, 'css');

    resolved.set(sheet.url, path);
    blobs.push({ path, sha256: hash, bytes, mimeType: 'text/css' });
  }

  rewriteDocumentAssets(doc, sourceUrl, resolve);
  annotateArchiveDocument(doc, { sourceUrl, capturedAt });

  const indexBytes = new TextEncoder().encode(serializeDocument(doc));
  blobs.unshift({
    path: '/index.html',
    sha256: hashBytes(indexBytes),
    bytes: indexBytes,
    mimeType: 'text/html',
  });

  const trimmed = enforceTotalBudget(blobs, skipped);
  onProgress?.({ phase: 'building', completed: trimmed.length, total: trimmed.length });

  return {
    blobs: trimmed,
    skipped,
    totalBytes: trimmed.reduce((sum, blob) => sum + blob.bytes.byteLength, 0),
  };
}

/**
 * Drop assets, largest first, until the archive fits the total budget.
 *
 * `/index.html` is never dropped — without it there is no archive. Its
 * references to dropped assets stay absolute, so they fall back to the
 * live web rather than breaking.
 */
function enforceTotalBudget(blobs: ArchiveBlob[], skipped: SkippedAsset[]): ArchiveBlob[] {
  let total = blobs.reduce((sum, blob) => sum + blob.bytes.byteLength, 0);
  if (total <= MAX_TOTAL_BYTES) return blobs;

  const kept = [...blobs];
  const droppable = kept
    .map((blob, index) => ({ blob, index }))
    .filter(({ blob }) => blob.path !== '/index.html')
    .sort((a, b) => b.blob.bytes.byteLength - a.blob.bytes.byteLength);

  const dropped = new Set<number>();
  for (const { blob, index } of droppable) {
    if (total <= MAX_TOTAL_BYTES) break;
    total -= blob.bytes.byteLength;
    dropped.add(index);
    skipped.push({
      url: blob.path,
      reason: `dropped to stay under the ${formatBytes(MAX_TOTAL_BYTES)} archive limit`,
    });
  }

  return kept.filter((_, index) => !dropped.has(index));
}

/** Resolve the favicon URL for display, if the page declared one. */
export function faviconUrl(icon: string | undefined, sourceUrl: string): string | undefined {
  if (!icon) return undefined;
  const abs = absolutize(icon, sourceUrl);
  return abs && isFetchableUrl(abs) ? abs : undefined;
}
