/**
 * Hooks for event interactions (reactions, reposts, and aggregate stats),
 * scoped to comment events (kind 1111). They use TanStack Query with
 * optimistic updates so the UI reacts immediately on click and rolls back
 * if the relay write fails.
 *
 * Caches:
 *   ['event-stats',    eventId]            — { reactions, reposts }
 *   ['user-reaction',  eventId, userPubkey] — kind 7 reaction event or null
 *   ['user-repost',    eventId, userPubkey] — kind 6 repost event or null
 *
 * The stats query queries reactions + reposts from the same relay set the
 * comments thread uses.
 */
import { useNostr } from '@nostrify/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NostrEvent } from '@nostrify/nostrify';

import { useCurrentUser } from './useCurrentUser';
import { useNostrPublish } from './useNostrPublish';

export interface EventStats {
  reactions: number;
  reposts: number;
}

const STATS_QUERY_TIMEOUT = 4000;

/** Aggregate reaction/repost counts for a single event id. */
export function useEventStats(eventId: string | undefined) {
  const { nostr } = useNostr();

  return useQuery<EventStats>({
    queryKey: ['event-stats', eventId],
    enabled: !!eventId,
    queryFn: async () => {
      const signal = AbortSignal.timeout(STATS_QUERY_TIMEOUT);
      const events = await nostr.query(
        [{ kinds: [6, 7], '#e': [eventId!] }],
        { signal },
      );
      let reactions = 0;
      let reposts = 0;
      for (const e of events) {
        if (e.kind === 7) reactions += 1;
        else if (e.kind === 6) reposts += 1;
      }
      return { reactions, reposts };
    },
  });
}

/** The current user's reaction event for `eventId`, or null. */
export function useUserReaction(eventId: string | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  return useQuery<NostrEvent | null>({
    queryKey: ['user-reaction', eventId, user?.pubkey],
    enabled: !!eventId && !!user?.pubkey,
    queryFn: async () => {
      const signal = AbortSignal.timeout(STATS_QUERY_TIMEOUT);
      const events = await nostr.query(
        [{
          kinds: [7],
          authors: [user!.pubkey],
          '#e': [eventId!],
          limit: 1,
        }],
        { signal },
      );
      return events[0] ?? null;
    },
  });
}

/** The current user's repost event for `eventId`, or null. */
export function useUserRepost(eventId: string | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  return useQuery<NostrEvent | null>({
    queryKey: ['user-repost', eventId, user?.pubkey],
    enabled: !!eventId && !!user?.pubkey,
    queryFn: async () => {
      const signal = AbortSignal.timeout(STATS_QUERY_TIMEOUT);
      const events = await nostr.query(
        [{
          kinds: [6],
          authors: [user!.pubkey],
          '#e': [eventId!],
          limit: 1,
        }],
        { signal },
      );
      return events[0] ?? null;
    },
  });
}

interface ToggleReactionArgs {
  event: NostrEvent;
  /** Existing reaction event to undo, or null to add a new one. */
  existing: NostrEvent | null;
  /** Reaction content; defaults to "+" (NIP-25 like). */
  content?: string;
}

/**
 * Toggle a kind 7 reaction. If `existing` is provided we publish a kind 5
 * deletion request for it; otherwise we publish a fresh kind 7.
 */
export function useToggleReaction() {
  const queryClient = useQueryClient();
  const { mutateAsync: publish } = useNostrPublish();
  const { user } = useCurrentUser();

  return useMutation({
    mutationFn: async ({ event, existing, content = '+' }: ToggleReactionArgs) => {
      if (!user) throw new Error('Not logged in');

      if (existing) {
        await publish({
          kind: 5,
          content: '',
          tags: [['e', existing.id], ['k', '7']],
        });
        return { type: 'removed' as const };
      }

      const signed = await publish({
        kind: 7,
        content,
        tags: [
          ['e', event.id],
          ['p', event.pubkey],
          ['k', String(event.kind)],
        ],
      });
      return { type: 'added' as const, event: signed };
    },
    onMutate: async ({ event, existing }) => {
      if (!user) return;
      const statsKey = ['event-stats', event.id];
      const reactionKey = ['user-reaction', event.id, user.pubkey];

      await queryClient.cancelQueries({ queryKey: statsKey });
      await queryClient.cancelQueries({ queryKey: reactionKey });

      const prevStats = queryClient.getQueryData<EventStats>(statsKey);
      const prevReaction = queryClient.getQueryData<NostrEvent | null>(reactionKey);

      if (prevStats) {
        queryClient.setQueryData<EventStats>(statsKey, {
          ...prevStats,
          reactions: Math.max(0, prevStats.reactions + (existing ? -1 : 1)),
        });
      }
      // Optimistic placeholder reaction (real id is filled in onSuccess).
      queryClient.setQueryData<NostrEvent | null>(
        reactionKey,
        existing ? null : ({ ...event, id: 'optimistic', kind: 7, content: '+', tags: [] } as NostrEvent),
      );

      return { prevStats, prevReaction, statsKey, reactionKey };
    },
    onError: (_err, _vars, ctx) => {
      if (!ctx) return;
      if (ctx.prevStats !== undefined) queryClient.setQueryData(ctx.statsKey, ctx.prevStats);
      queryClient.setQueryData(ctx.reactionKey, ctx.prevReaction ?? null);
    },
    onSettled: (_data, _err, { event }) => {
      // Re-sync against the relay so optimistic ids get replaced by real ones.
      // Delay so relays have time to index.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['event-stats', event.id] });
        queryClient.invalidateQueries({ queryKey: ['user-reaction', event.id] });
      }, 1500);
    },
  });
}

interface ToggleRepostArgs {
  event: NostrEvent;
  existing: NostrEvent | null;
}

/**
 * Toggle a kind 6 repost (NIP-18). If `existing` is provided we publish a
 * kind 5 deletion request for it; otherwise we publish a fresh kind 6.
 */
export function useToggleRepost() {
  const queryClient = useQueryClient();
  const { mutateAsync: publish } = useNostrPublish();
  const { user } = useCurrentUser();

  return useMutation({
    mutationFn: async ({ event, existing }: ToggleRepostArgs) => {
      if (!user) throw new Error('Not logged in');

      if (existing) {
        await publish({
          kind: 5,
          content: '',
          tags: [['e', existing.id], ['k', '6']],
        });
        return { type: 'removed' as const };
      }

      const signed = await publish({
        kind: 6,
        content: '',
        tags: [
          ['e', event.id],
          ['p', event.pubkey],
        ],
      });
      return { type: 'added' as const, event: signed };
    },
    onMutate: async ({ event, existing }) => {
      if (!user) return;
      const statsKey = ['event-stats', event.id];
      const repostKey = ['user-repost', event.id, user.pubkey];

      await queryClient.cancelQueries({ queryKey: statsKey });
      await queryClient.cancelQueries({ queryKey: repostKey });

      const prevStats = queryClient.getQueryData<EventStats>(statsKey);
      const prevRepost = queryClient.getQueryData<NostrEvent | null>(repostKey);

      if (prevStats) {
        queryClient.setQueryData<EventStats>(statsKey, {
          ...prevStats,
          reposts: Math.max(0, prevStats.reposts + (existing ? -1 : 1)),
        });
      }
      queryClient.setQueryData<NostrEvent | null>(
        repostKey,
        existing ? null : ({ ...event, id: 'optimistic', kind: 6, content: '', tags: [] } as NostrEvent),
      );

      return { prevStats, prevRepost, statsKey, repostKey };
    },
    onError: (_err, _vars, ctx) => {
      if (!ctx) return;
      if (ctx.prevStats !== undefined) queryClient.setQueryData(ctx.statsKey, ctx.prevStats);
      queryClient.setQueryData(ctx.repostKey, ctx.prevRepost ?? null);
    },
    onSettled: (_data, _err, { event }) => {
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['event-stats', event.id] });
        queryClient.invalidateQueries({ queryKey: ['user-repost', event.id] });
      }, 1500);
    },
  });
}
