import { useState } from 'react';
import { NostrEvent } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';
import { useAuthor } from '@/hooks/useAuthor';
import { useComments } from '@/hooks/useComments';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useToast } from '@/hooks/useToast';
import { useQueryClient } from '@tanstack/react-query';
import {
  useEventStats,
  useToggleReaction,
  useToggleRepost,
  useUserReaction,
  useUserRepost,
} from '@/hooks/useEventInteractions';
import { CommentForm } from './CommentForm';
import { CommentBody } from './CommentBody';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { RepostIcon } from '@/components/icons/RepostIcon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  MessageCircle,
  MoreHorizontal,
  ExternalLink,
  Trash2,
  Heart,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { genUserName } from '@/lib/genUserName';
import { formatNumber } from '@/lib/formatNumber';
import { cn } from '@/lib/utils';

interface CommentProps {
  root: NostrEvent | URL | `#${string}`;
  comment: NostrEvent;
  depth?: number;
  /** When true, draws a vertical connector line under the avatar that joins this comment to a child below. */
  threaded?: boolean;
  limit?: number;
}

export function Comment({ root, comment, depth = 0, threaded = false, limit }: CommentProps) {
  const [showReplyForm, setShowReplyForm] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const author = useAuthor(comment.pubkey);
  const { data: commentsData } = useComments(root, limit);
  const { user } = useCurrentUser();
  const { mutate: publishEvent, isPending: isDeleting } = useNostrPublish();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Engagement hooks (kind 6 reposts, kind 7 reactions on this comment).
  const { data: stats } = useEventStats(comment.id);
  const { data: userReaction } = useUserReaction(comment.id);
  const { data: userRepost } = useUserRepost(comment.id);
  const { mutate: toggleReaction } = useToggleReaction();
  const { mutate: toggleRepost } = useToggleRepost();

  const metadata = author.data?.metadata;
  const displayName = metadata?.name ?? genUserName(comment.pubkey);
  const timeAgo = formatDistanceToNow(new Date(comment.created_at * 1000), { addSuffix: true });
  const nevent = nip19.neventEncode({ id: comment.id, author: comment.pubkey, kind: comment.kind });
  const npub = nip19.npubEncode(comment.pubkey);
  const profileUrl = `https://ditto.pub/${npub}`;
  const isOwnComment = user?.pubkey === comment.pubkey;

  // Direct replies — replies are rendered flat (no horizontal indent), each
  // with its own connector line if it has children of its own. This matches
  // Ditto's threaded layout: depth is communicated by the avatar-column line,
  // not by margin.
  const replies = commentsData?.getDirectReplies(comment.id) ?? [];
  const hasReplies = replies.length > 0;

  const hasReacted = !!userReaction;
  const hasReposted = !!userRepost;

  const handleReact = () => {
    if (!user) {
      toast({ title: 'Sign in to react', variant: 'destructive' });
      return;
    }
    toggleReaction({ event: comment, existing: userReaction ?? null });
  };

  const handleRepost = () => {
    if (!user) {
      toast({ title: 'Sign in to repost', variant: 'destructive' });
      return;
    }
    toggleRepost({ event: comment, existing: userRepost ?? null });
  };

  const handleDelete = () => {
    publishEvent(
      {
        kind: 5,
        content: '',
        tags: [
          ['e', comment.id],
          ['k', comment.kind.toString()],
        ],
      },
      {
        onSuccess: () => {
          toast({ title: 'Comment deleted' });
          setShowDeleteDialog(false);
          // Optimistically remove the deleted comment from every cached useComments
          // result. Relays may honor the kind 5 deletion request on refetch, but
          // that's not guaranteed — this keeps the UI consistent immediately.
          queryClient.setQueriesData<ReturnType<typeof useComments>['data']>(
            { queryKey: ['nostr', 'comments'] },
            (oldData) => {
              if (!oldData) return oldData;
              const allComments = oldData.allComments.filter((c) => c.id !== comment.id);
              const topLevelComments = oldData.topLevelComments.filter(
                (c) => c.id !== comment.id,
              );
              return {
                ...oldData,
                allComments,
                topLevelComments,
                getDescendants: (id: string) =>
                  oldData.getDescendants(id).filter((c) => c.id !== comment.id),
                getDirectReplies: (id: string) =>
                  oldData.getDirectReplies(id).filter((c) => c.id !== comment.id),
              };
            },
          );
        },
        onError: (error) => {
          toast({
            title: 'Failed to delete comment',
            description: error.message,
            variant: 'destructive',
          });
        },
      },
    );
  };

  // The reply form sits below this comment, also edge-to-edge with the same
  // border-b separator. Replies follow as siblings (no left indent).
  const showConnector = threaded || hasReplies || showReplyForm;

  return (
    <>
      <article
        className={cn(
          'flex gap-3 px-4 pt-3 transition-colors hover:bg-secondary/30',
          showConnector ? 'pb-0' : 'pb-3 border-b border-border',
        )}
      >
        {/* Avatar column + connector line */}
        <div className="flex flex-col items-center shrink-0">
          <a
            href={profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0"
          >
            <Avatar className="size-9 hover:ring-2 hover:ring-primary/30 transition-all">
              <AvatarImage src={metadata?.picture} />
              <AvatarFallback className="text-xs">
                {displayName.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          </a>
          {showConnector && (
            <div className="w-0.5 flex-1 mt-2 rounded-full bg-foreground/20" />
          )}
        </div>

        {/* Body column */}
        <div className={cn('flex-1 min-w-0', showConnector ? 'pb-3' : '')}>
          {/* Header: name · time */}
          <div className="flex items-center gap-1.5 min-w-0">
            <a
              href={profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-sm hover:underline truncate"
            >
              {displayName}
            </a>
            <span className="shrink-0 text-muted-foreground text-xs">·</span>
            <span className="shrink-0 text-muted-foreground text-xs whitespace-nowrap">
              {timeAgo}
            </span>
          </div>

          {/* Content */}
          <div className="text-sm mt-0.5">
            <CommentBody content={comment.content} />
          </div>

          {/* Actions row — Reply / Repost / React / More */}
          <div className="flex items-center mt-1 -ml-2 gap-1">
            <button
              type="button"
              onClick={() => setShowReplyForm((v) => !v)}
              title="Reply"
              className="flex items-center gap-1.5 p-2 rounded-full text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
            >
              <MessageCircle className="size-4" />
              {replies.length > 0 && (
                <span className="text-xs tabular-nums">{formatNumber(replies.length)}</span>
              )}
            </button>

            <button
              type="button"
              onClick={handleRepost}
              title={hasReposted ? 'Undo repost' : 'Repost'}
              className={cn(
                'flex items-center gap-1.5 p-2 rounded-full transition-colors',
                hasReposted
                  ? 'text-emerald-500 hover:text-emerald-500/80 hover:bg-emerald-500/10'
                  : 'text-muted-foreground hover:text-emerald-500 hover:bg-emerald-500/10',
              )}
            >
              <RepostIcon className="size-4" />
              {stats && stats.reposts > 0 && (
                <span className="text-xs tabular-nums">{formatNumber(stats.reposts)}</span>
              )}
            </button>

            <button
              type="button"
              onClick={handleReact}
              title={hasReacted ? 'Remove reaction' : 'React'}
              className={cn(
                'flex items-center gap-1.5 p-2 rounded-full transition-colors',
                hasReacted
                  ? 'text-pink-500 hover:text-pink-500/80 hover:bg-pink-500/10'
                  : 'text-muted-foreground hover:text-pink-500 hover:bg-pink-500/10',
              )}
            >
              <Heart className="size-4" fill={hasReacted ? 'currentColor' : 'none'} />
              {stats && stats.reactions > 0 && (
                <span className="text-xs tabular-nums">{formatNumber(stats.reactions)}</span>
              )}
            </button>

            <div className="flex-1" />

            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="p-2 rounded-full text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                  aria-label="Comment options"
                >
                  <MoreHorizontal className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <a
                    href={`https://ditto.pub/${nevent}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open in Ditto
                  </a>
                </DropdownMenuItem>
                {isOwnComment && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={(e) => {
                        e.preventDefault();
                        setShowDeleteDialog(true);
                      }}
                      className="font-medium"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </article>

      {/* Inline reply form, edge-to-edge */}
      {showReplyForm && (
        <div className="border-b border-border">
          <CommentForm
            root={root}
            reply={comment}
            onSuccess={() => setShowReplyForm(false)}
            placeholder="Write a reply…"
            compact
            autoFocus
          />
        </div>
      )}

      {/* Replies — flat sibling list (matches Ditto's threaded layout) */}
      {hasReplies &&
        replies.map((reply, i) => (
          <Comment
            key={reply.id}
            root={root}
            comment={reply}
            depth={depth + 1}
            // Draw the connector line under each reply that isn't the very last
            // visible item in the thread, so the line doesn't dangle.
            threaded={i < replies.length - 1}
            limit={limit}
          />
        ))}

      {/* Delete confirmation */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete comment?</AlertDialogTitle>
            <AlertDialogDescription>
              This publishes a NIP-09 deletion request (kind 5). Relays and clients that
              honor deletion requests will hide this comment, but deletion is not
              guaranteed across the network.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDelete();
              }}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
