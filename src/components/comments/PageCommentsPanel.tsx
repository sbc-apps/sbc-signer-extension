/**
 * Popup pane that renders the NIP-22 (kind 1111) comments thread for
 * the URL of the user's currently active browser tab.
 *
 * The page URL is canonicalized (tracking params + #fragment stripped)
 * so comments on minor URL variations cluster together. After the
 * user posts a comment, we ping the background script so it drops its
 * cached count and refreshes the toolbar badge.
 */

import { useEffect, useMemo } from 'react';
import { Lock, Loader2 } from 'lucide-react';

import { CommentsSection } from '@/components/comments/CommentsSection';
import { useActiveTabUrl } from '@/hooks/useActiveTabUrl';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { canonicalizePageUrl } from '@/lib/canonicalUrl';
import { useQueryClient } from '@tanstack/react-query';

interface PageCommentsPanelProps {
  className?: string;
}

export function PageCommentsPanel({ className }: PageCommentsPanelProps) {
  const { url, loading } = useActiveTabUrl();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  const canonical = useMemo(() => canonicalizePageUrl(url), [url]);

  // After a comment is posted to this URL, tell the background script
  // to invalidate its cached comment count + refresh the badge. We
  // detect new posts by watching the comments query for updates.
  const canonicalKey = canonical?.toString();
  useEffect(() => {
    if (!canonicalKey) return;
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      // We only care about successful updates to *our* page's comments query.
      if (event.type !== 'updated') return;
      const key = event.query.queryKey;
      if (!Array.isArray(key) || key[0] !== 'nostr' || key[1] !== 'comments') return;
      if (key[2] !== canonicalKey) return;
      // Notify background — fire and forget.
      chrome.runtime
        .sendMessage({ kind: 'comment-posted', canonicalUrl: canonicalKey })
        .catch(() => {});
    });
    return unsubscribe;
  }, [canonicalKey, queryClient]);

  if (loading) {
    return (
      <div className={`flex items-center justify-center py-10 text-muted-foreground ${className ?? ''}`}>
        <Loader2 className="size-4 animate-spin mr-2" />
        <span className="text-sm">Loading…</span>
      </div>
    );
  }

  if (!canonical) {
    return (
      <div className={`flex flex-col items-center text-center px-6 py-10 gap-3 ${className ?? ''}`}>
        <div className="size-12 rounded-full bg-muted flex items-center justify-center">
          <Lock className="size-5 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">Extension not available here</p>
        <p className="text-xs text-muted-foreground max-w-[260px]">
          Open a regular web page (http or https) to read or post a NIP-22 comment about it.
        </p>
      </div>
    );
  }

  return (
    <div className={`flex flex-col min-h-0 ${className ?? ''}`}>
      {/*
       * Break out of the popup's px-4 gutter so each comment's bottom border
       * spans the full popup width — that's the Ditto thread look. The
       * comment rows themselves re-pad with their own px-4.
       */}
      <div className="flex-1 min-h-0 overflow-y-auto -mx-4">
        <CommentsSection
          root={canonical}
          emptyStateMessage={user ? 'No comments yet' : 'No comments yet'}
          emptyStateSubtitle={
            user ? 'Be the first to share your thoughts!' : 'Sign in above to start the discussion.'
          }
          limit={200}
        />
      </div>
    </div>
  );
}
