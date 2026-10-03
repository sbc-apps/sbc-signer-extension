/**
 * Drives the "Save as nsite" pipeline: analyze → review → publish.
 *
 * The review pause between the two async phases is deliberate and not
 * just cosmetic. A captured page is the user's *rendered* view, so on a
 * logged-in site it can contain private content, and Blossom uploads
 * are public and effectively permanent. Nothing leaves the machine
 * until the user has seen what they're about to publish.
 *
 * Everything runs in the archive window rather than the popup or the
 * service worker — see `pipeline.ts` for why.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useNostr } from '@nostrify/react';

import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { getEffectiveBlossomServers } from '@/lib/appBlossom';
import {
  serverFailures,
  serversHoldingEveryBlob,
  uploadBlob,
  type BlobUploadResult,
} from '@/lib/archive/blossom';
import { buildArchive, type ArchiveProgress, type BuiltArchive } from '@/lib/archive/pipeline';
import { buildArchiveManifest } from '@/lib/archive/manifest';
import { snapshotGatewayUrl } from '@/lib/archive/nsiteUrl';

import type { ArchiveDraft } from '@/extension/messages';
import type { NostrEvent } from '@nostrify/nostrify';

/** Blobs uploaded at once. Each costs one signature, so keep it modest. */
const UPLOAD_CONCURRENCY = 3;

/** Per-relay read-back budget when verifying the published manifest. */
const VERIFY_TIMEOUT_MS = 6000;

export interface RelayCheck {
  relay: string;
  /** The manifest was readable back from this relay. */
  ok: boolean;
}

export interface ArchiveResult {
  event: NostrEvent;
  /** Browsable gateway URL for the snapshot. */
  url: string;
  /** Servers advertised in the manifest (they hold every blob). */
  servers: string[];
  /** Servers dropped from the manifest, with the reason. */
  droppedServers: Array<{ server: string; error: string }>;
  /** Per-relay read-back results. */
  relays: RelayCheck[];
}

export type ArchiveStatus =
  | { phase: 'analyzing'; progress: ArchiveProgress | null }
  | { phase: 'review'; archive: BuiltArchive }
  | { phase: 'uploading'; completed: number; total: number }
  | { phase: 'publishing' }
  | { phase: 'verifying' }
  | { phase: 'done'; result: ArchiveResult }
  | { phase: 'error'; message: string };

export function useArchivePublisher(draft: ArchiveDraft | null | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();

  const [status, setStatus] = useState<ArchiveStatus>({ phase: 'analyzing', progress: null });
  const abortRef = useRef<AbortController | null>(null);

  const blossomServers = useMemo(
    () => getEffectiveBlossomServers(config.blossomServerMetadata, config.useAppBlossomServers),
    [config.blossomServerMetadata, config.useAppBlossomServers],
  );

  const writeRelays = useMemo(
    () => config.relayMetadata.relays.filter((relay) => relay.write).map((relay) => relay.url),
    [config.relayMetadata],
  );

  /** Fetch and rewrite every subresource. Stops at the review step. */
  const analyze = useCallback(async () => {
    if (!draft) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setStatus({ phase: 'analyzing', progress: null });

    try {
      const archive = await buildArchive({
        html: draft.html,
        sourceUrl: draft.pageUrl,
        capturedAt: draft.capturedAt,
        signal: controller.signal,
        onProgress: (progress) => setStatus({ phase: 'analyzing', progress }),
      });
      setStatus({ phase: 'review', archive });
    } catch (error) {
      setStatus({ phase: 'error', message: describe(error) });
    }
  }, [draft]);

  /** Upload every blob, publish the manifest, then verify both. */
  const publish = useCallback(
    async (archive: BuiltArchive) => {
      if (!draft || !user) return;

      if (blossomServers.length === 0) {
        setStatus({
          phase: 'error',
          message: 'No Blossom servers configured. Add one in the extension settings.',
        });
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        setStatus({ phase: 'uploading', completed: 0, total: archive.blobs.length });

        let completed = 0;
        const results: BlobUploadResult[] = new Array(archive.blobs.length);
        let next = 0;

        await Promise.all(
          Array.from({ length: Math.min(UPLOAD_CONCURRENCY, archive.blobs.length) }, async () => {
            while (next < archive.blobs.length) {
              const index = next++;
              results[index] = await uploadBlob(
                archive.blobs[index],
                blossomServers,
                user.signer,
                controller.signal,
              );
              setStatus({
                phase: 'uploading',
                completed: ++completed,
                total: archive.blobs.length,
              });
            }
          }),
        );

        // Only servers holding *every* blob go in the manifest — a
        // partial server yields an archive that renders with pieces
        // missing, which is worse than one server fewer.
        const servers = serversHoldingEveryBlob(results);
        if (servers.length === 0) {
          const reasons = [...serverFailures(results)]
            .map(([server, error]) => `${hostOf(server)}: ${error}`)
            .join('; ');
          throw new Error(
            `No Blossom server accepted the whole archive.${reasons ? ` (${reasons})` : ''}`,
          );
        }

        setStatus({ phase: 'publishing' });

        const template = buildArchiveManifest({
          files: archive.blobs.map(({ path, sha256 }) => ({ path, sha256 })),
          servers,
          pageTitle: draft.pageTitle,
          sourceUrl: draft.pageUrl,
          capturedAt: draft.capturedAt,
        });

        const event = await user.signer.signEvent(template);
        await nostr.event(event, { signal: AbortSignal.timeout(10_000) });

        setStatus({ phase: 'verifying' });

        const failures = serverFailures(results);
        setStatus({
          phase: 'done',
          result: {
            event,
            url: snapshotGatewayUrl(event.id),
            servers,
            droppedServers: [...failures]
              .filter(([server]) => !servers.includes(server))
              .map(([server, error]) => ({ server, error })),
            relays: await verifyOnRelays(nostr, writeRelays, event.id),
          },
        });
      } catch (error) {
        setStatus({ phase: 'error', message: describe(error) });
      }
    },
    [blossomServers, draft, nostr, user, writeRelays],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { status, analyze, publish, cancel, blossomServers, writeRelays };
}

/**
 * Read the manifest back from each relay individually.
 *
 * "Published successfully" only means the pool didn't throw. A relay
 * can accept the connection and still reject the event — a PoW
 * requirement, a kind allow-list — and the archive is then invisible to
 * anyone reading from it.
 */
async function verifyOnRelays(
  nostr: ReturnType<typeof useNostr>['nostr'],
  relays: string[],
  eventId: string,
): Promise<RelayCheck[]> {
  return Promise.all(
    relays.map(async (relay) => {
      try {
        const events = await nostr
          .relay(relay)
          .query([{ ids: [eventId] }], { signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
        return { relay, ok: events.length > 0 };
      } catch {
        return { relay, ok: false };
      }
    }),
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function describe(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Cancelled.';
  return error instanceof Error ? error.message : String(error);
}
