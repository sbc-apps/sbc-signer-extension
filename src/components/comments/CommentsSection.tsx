import { useComments } from '@/hooks/useComments';
import { Skeleton } from '@/components/ui/skeleton';
import { MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { NostrEvent } from '@nostrify/nostrify';
import { CommentForm } from './CommentForm';
import { Comment } from './Comment';

interface CommentsSectionProps {
  root: NostrEvent | URL | `#${string}`;
  emptyStateMessage?: string;
  emptyStateSubtitle?: string;
  className?: string;
  limit?: number;
}

export function CommentsSection({
  root,
  emptyStateMessage = 'No comments yet',
  emptyStateSubtitle = 'Be the first to share your thoughts!',
  className,
  limit = 500,
}: CommentsSectionProps) {
  const { data: commentsData, isLoading, error } = useComments(root, limit);
  const comments = commentsData?.topLevelComments || [];

  if (error) {
    return (
      <div className={cn('text-center text-muted-foreground py-6', className)}>
        <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>Failed to load comments</p>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col', className)}>
      {/* Top composer — full-width, separated from the list with a border */}
      <div className="border-b border-border">
        <CommentForm root={root} />
      </div>

      {isLoading ? (
        <div className="divide-y divide-border">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="flex gap-3 px-4 py-3">
              <Skeleton className="size-9 rounded-full shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-12" />
                </div>
                <Skeleton className="h-12 w-full" />
              </div>
            </div>
          ))}
        </div>
      ) : comments.length === 0 ? (
        <div className="text-center px-4 py-10 text-muted-foreground">
          <MessageSquare className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm font-medium mb-1">{emptyStateMessage}</p>
          <p className="text-xs">{emptyStateSubtitle}</p>
        </div>
      ) : (
        <div>
          {comments.map((comment) => (
            <Comment
              key={comment.id}
              root={root}
              comment={comment}
              limit={limit}
            />
          ))}
        </div>
      )}
    </div>
  );
}
