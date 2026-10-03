/**
 * NIP-5A manifest construction for single-page archives.
 *
 * We publish kind 5128 ("manifest snapshot"), which is a *regular*
 * event. That choice is deliberate:
 *
 *  - Regular means every archive is its own permanent event. A
 *    replaceable root site (15128) would let each new archive clobber
 *    the last, and a named site (35128) would burn a `d` slot in the
 *    user's namespace per page.
 *  - Gateways address a snapshot by its own event id
 *    (`v<idB36>.nsite.lol`), so an archive is browsable the moment it's
 *    published, with no separate site record to point at.
 *
 * We deviate from the spec in one place: NIP-5A says a 5128 event MUST
 * carry exactly one `a` tag referencing the site it snapshots. An
 * archive of someone else's web page snapshots nothing on Nostr, so
 * there is no honest value for that tag and we omit it. This was
 * verified against live gateways before being relied upon — nsite.lol
 * and nosto.re both serve an `a`-less snapshot correctly, including
 * sub-paths.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { canonicalizePageUrl } from '@/lib/canonicalUrl';

/** NIP-5A manifest snapshot. Regular event, addressed by event id. */
export const NSITE_SNAPSHOT_KIND = 5128;

/** Longest `title` tag we'll emit, to keep the event small. */
const MAX_TITLE_LENGTH = 200;

export interface ArchiveFile {
  /** Absolute path within the site, e.g. `/index.html`. */
  path: string;
  /** Lowercase hex sha256 of the file's bytes. */
  sha256: string;
}

/**
 * The NIP-5A site aggregate hash.
 *
 * Derived from `path` tags alone, order-independent, ignoring every
 * other tag and event field, so that two manifests describing the same
 * bytes hash identically regardless of who published them.
 *
 * Format each entry as `<sha256> <path>\n`, sort the lines ascending,
 * concatenate, sha256 the UTF-8 bytes. Sorting with the trailing
 * newline included matches `sort(1)`'s line ordering here because every
 * line shares a fixed-width 64-character hash prefix.
 */
export function aggregateHash(files: ArchiveFile[]): string {
  const lines = files.map((file) => `${file.sha256} ${file.path}\n`).sort();
  return bytesToHex(sha256(new TextEncoder().encode(lines.join(''))));
}

/** Human-readable label for the archive, e.g. `Archive of Example Domain`. */
export function archiveTitle(pageTitle: string | undefined, sourceUrl: string): string {
  const subject = pageTitle?.trim() || hostnameOf(sourceUrl) || sourceUrl;
  return truncate(`Archive of ${subject}`, MAX_TITLE_LENGTH);
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}

/**
 * NIP-73 `i` tag identifying the archived web page.
 *
 * NIP-73 wants the URL "normalized, no fragment"; `canonicalizePageUrl`
 * is the project's existing answer to that (it drops the fragment and
 * known tracking params and lowercases the host) and is what NIP-22
 * comments already key on.
 *
 * No companion `k` tag: `k` exists so clients can query for a *class*
 * of external id, and there's nothing to disambiguate here — the value
 * is a URL, and the event kind already says this is a page archive.
 */
export function sourceIdTags(sourceUrl: string): string[][] {
  const canonical = canonicalizePageUrl(sourceUrl);
  return canonical ? [['i', canonical.toString()]] : [];
}

export interface ArchiveManifestInput {
  /** Every file in the archive, including `/index.html`. */
  files: ArchiveFile[];
  /**
   * Blossom servers that accepted *every* blob. Advertising a server
   * that only holds some of them produces an archive that renders with
   * pieces missing, so partial servers are filtered out upstream.
   */
  servers: string[];
  /** Title of the page that was archived. */
  pageTitle?: string;
  /** URL the archive was captured from. */
  sourceUrl: string;
  /** Capture time in seconds since epoch. Defaults to now. */
  capturedAt?: number;
}

/** Unsigned event template, matching `useNostrPublish`'s input shape. */
export interface ArchiveManifestTemplate {
  kind: number;
  content: string;
  created_at: number;
  tags: string[][];
}

export function buildArchiveManifest(input: ArchiveManifestInput): ArchiveManifestTemplate {
  const { files, servers, pageTitle, sourceUrl } = input;

  if (!files.some((file) => file.path === '/index.html')) {
    throw new Error('archive manifest requires an /index.html path');
  }

  const createdAt = input.capturedAt ?? Math.floor(Date.now() / 1000);
  const capturedOn = new Date(createdAt * 1000).toISOString().slice(0, 10);

  const tags: string[][] = [
    ...files.map((file) => ['path', file.path, file.sha256]),
    ['x', aggregateHash(files), 'aggregate'],
    ...servers.map((server) => ['server', server]),
    ['title', archiveTitle(pageTitle, sourceUrl)],
    ['description', truncate(`Archived from ${sourceUrl} on ${capturedOn}.`, MAX_TITLE_LENGTH)],
    // NIP-73 external content id for the archived page, so archives of
    // a given URL are discoverable and share an identifier with NIP-22
    // comments about that same page — both run the URL through
    // `canonicalizePageUrl`, so the tracking params and fragment that
    // vary between visits don't fork the identity.
    //
    // Omitted rather than guessed if the URL won't canonicalize. That
    // shouldn't happen (the background only archives http(s) pages),
    // and the `description` still records where this came from.
    ...sourceIdTags(sourceUrl),
  ];

  return {
    kind: NSITE_SNAPSHOT_KIND,
    content: '',
    created_at: createdAt,
    tags,
  };
}
