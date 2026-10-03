/**
 * Blossom uploads for page archives.
 *
 * Nostrify ships a `BlossomUploader`, but it's the wrong shape for this
 * job in three ways:
 *
 *  - It races every server with `Promise.any` and resolves on the first
 *    success, discarding which servers actually accepted the blob. A
 *    NIP-5A manifest's `server` tags are how a gateway finds the bytes,
 *    so advertising a server that only holds some files produces an
 *    archive that renders with pieces missing.
 *  - It doesn't reliably expose the sha256 (when a server returns BUD-08
 *    `nip94` tags, it passes those through verbatim), and the hash *is*
 *    the manifest.
 *  - It has no way to skip a blob a server already has, which matters
 *    when re-archiving a page whose assets haven't changed.
 *
 * So: hash locally first, ask each server whether it already has the
 * blob, upload where it doesn't, and report per-server outcomes.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { N64 } from '@nostrify/nostrify/utils';

import type { NostrSigner } from '@nostrify/nostrify';

/** Blossom authorization events are short-lived by design (BUD-02). */
const AUTH_EXPIRY_MS = 5 * 60 * 1000;

/** Per-request ceiling. Large media on a slow server needs headroom. */
const REQUEST_TIMEOUT_MS = 60_000;

/** A file destined for the archive, already hashed. */
export interface ArchiveBlob {
  /** Absolute path within the archive, e.g. `/assets/<sha>.png`. */
  path: string;
  /** Lowercase hex sha256 of `bytes`. */
  sha256: string;
  bytes: Uint8Array;
  mimeType: string;
}

export interface ServerOutcome {
  server: string;
  ok: boolean;
  /** The server already had these bytes; no upload was performed. */
  deduplicated: boolean;
  error?: string;
}

export interface BlobUploadResult {
  sha256: string;
  path: string;
  outcomes: ServerOutcome[];
}

/** Lowercase hex sha256 of a byte array. */
export function hashBytes(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/** Normalize a server URL into an origin we can build paths on. */
function serverUrl(server: string, path: string): string {
  return new URL(path, server.endsWith('/') ? server : `${server}/`).href;
}

/**
 * Build a BUD-02 `Authorization` header value.
 *
 * One event is signed per blob and reused across servers. Scoping it
 * per server (BUD-11) would multiply signature count by the number of
 * servers, which is painful over a NIP-46 bunker for no benefit here.
 */
/**
 * Both encodings of a BUD-11 authorization token, in preference order.
 *
 * BUD-11 requires Base64url without padding, and that's what we send
 * first. But a good part of the deployed fleet only decodes *standard*
 * base64 and rejects the spec-compliant form outright — measured:
 * `nostr.download` answers `400 Invalid auth string` and
 * `blossom.primal.net` `400 invalid base64 for auth event`, while
 * `blossom.ditto.pub` and `blossom.dreamith.to` accept either.
 *
 * Both variants encode the *same signed event*, so falling back costs
 * one HTTP round trip and no extra signature — which matters, because
 * over a NIP-46 bunker a signature is a network round trip of its own.
 */
async function uploadAuth(signer: NostrSigner, blob: ArchiveBlob): Promise<string[]> {
  const event = await signer.signEvent({
    kind: 24242,
    content: `Upload ${blob.path}`,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['t', 'upload'],
      ['expiration', Math.floor((Date.now() + AUTH_EXPIRY_MS) / 1000).toString()],
      ['x', blob.sha256],
    ],
  });

  return [`Nostr ${N64.encodeEventUrl(event)}`, `Nostr ${N64.encodeEvent(event)}`];
}

function combineSignals(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Whether a server already holds these bytes (BUD-01 `HEAD /<sha256>`). */
export async function hasBlob(
  server: string,
  hash: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetch(serverUrl(server, hash), {
      method: 'HEAD',
      // Blossom blobs are public; sending the extension's cookies to
      // arbitrary hosts would be a needless privacy leak.
      credentials: 'omit',
      signal: combineSignals(signal),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timed out';
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Upload one blob to one server, returning a per-server outcome.
 *
 * `authorizations` are equivalent encodings of the same token, tried in
 * order; see {@link uploadAuth}. Only an auth-shaped rejection (400 /
 * 401) is retried — anything else is the server's real answer.
 */
async function uploadToServer(
  server: string,
  blob: ArchiveBlob,
  authorizations: string[],
  signal?: AbortSignal,
): Promise<ServerOutcome> {
  try {
    if (await hasBlob(server, blob.sha256, signal)) {
      return { server, ok: true, deduplicated: true };
    }

    let attempt: (ServerOutcome & { status?: number }) | null = null;

    for (const [index, authorization] of authorizations.entries()) {
      attempt = await putBlob(server, blob, authorization, signal);
      const retryable = attempt.status === 400 || attempt.status === 401;
      if (attempt.ok || !retryable || index === authorizations.length - 1) break;
    }

    if (!attempt) {
      return { server, ok: false, deduplicated: false, error: 'no authorization' };
    }

    // `status` is an internal retry hint, not part of the reported shape.
    const { status: _status, ...outcome } = attempt;
    return outcome;
  } catch (error) {
    return { server, ok: false, deduplicated: false, error: describeError(error) };
  }
}

/** One `PUT /upload` attempt with a specific authorization encoding. */
async function putBlob(
  server: string,
  blob: ArchiveBlob,
  authorization: string,
  signal?: AbortSignal,
): Promise<ServerOutcome & { status?: number }> {
  try {
    const response = await fetch(serverUrl(server, 'upload'), {
      method: 'PUT',
      // Send the bytes directly rather than wrapping them in a `Blob`.
      // Both are valid `BodyInit`, but a `Blob` has to round-trip
      // through the environment's own implementation, and under
      // jsdom + undici that silently corrupted the body — the server
      // hashed something other than what we sent and rejected the
      // upload with `X-SHA-256 hash mismatch`.
      body: blob.bytes as unknown as BodyInit,
      headers: {
        authorization,
        'content-type': blob.mimeType,
        'x-sha-256': blob.sha256,
      },
      credentials: 'omit',
      signal: combineSignals(signal),
    });

    if (!response.ok) {
      // Per BUD-02, `409` specifically means the body didn't match the
      // `X-SHA-256` we sent — a real corruption, never "already have
      // it" (that's a `200` with a descriptor, so `response.ok`).
      const reason = response.headers.get('x-reason') ?? (await response.text().catch(() => ''));
      return {
        server,
        ok: false,
        deduplicated: false,
        status: response.status,
        error: `HTTP ${response.status}${reason ? `: ${reason.slice(0, 200)}` : ''}`,
      };
    }

    // Some servers transcode what they're given (re-encoding images,
    // say). The manifest addresses blobs by *our* hash, so if theirs
    // differs the bytes we're about to advertise aren't there.
    const descriptor: unknown = await response.json().catch(() => null);
    const returned =
      descriptor && typeof descriptor === 'object' && 'sha256' in descriptor
        ? String((descriptor as { sha256: unknown }).sha256)
        : undefined;

    if (returned && returned !== blob.sha256) {
      return {
        server,
        ok: false,
        deduplicated: false,
        error: `server stored a different hash (${returned.slice(0, 12)}…)`,
      };
    }

    return { server, ok: true, deduplicated: false };
  } catch (error) {
    return { server, ok: false, deduplicated: false, error: describeError(error) };
  }
}

/**
 * Upload one blob to every server.
 *
 * Never rejects: a server failing is data the caller needs, not an
 * exception. Whether the archive as a whole is publishable is decided
 * by {@link serversHoldingEveryBlob}.
 */
export async function uploadBlob(
  blob: ArchiveBlob,
  servers: string[],
  signer: NostrSigner,
  signal?: AbortSignal,
): Promise<BlobUploadResult> {
  const authorizations = await uploadAuth(signer, blob);
  const outcomes = await Promise.all(
    servers.map((server) => uploadToServer(server, blob, authorizations, signal)),
  );

  return { sha256: blob.sha256, path: blob.path, outcomes };
}

/**
 * The servers that accepted *every* blob — the only ones honest to
 * advertise in the manifest's `server` tags.
 */
export function serversHoldingEveryBlob(results: BlobUploadResult[]): string[] {
  if (results.length === 0) return [];

  const candidates = results[0].outcomes.map(({ server }) => server);
  return candidates.filter((server) =>
    results.every((result) => result.outcomes.some((o) => o.server === server && o.ok)),
  );
}

/** Human-readable summary of why a server was dropped, for the UI. */
export function serverFailures(results: BlobUploadResult[]): Map<string, string> {
  const failures = new Map<string, string>();

  for (const result of results) {
    for (const outcome of result.outcomes) {
      if (!outcome.ok && !failures.has(outcome.server)) {
        failures.set(outcome.server, outcome.error ?? 'upload failed');
      }
    }
  }

  return failures;
}
