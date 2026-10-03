import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { usePostComment } from '@/hooks/usePostComment';
import { LoginArea } from '@/components/auth/LoginArea';
import { NostrEvent } from '@nostrify/nostrify';
import { MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CommentFormProps {
  root: NostrEvent | URL | `#${string}`;
  reply?: NostrEvent | URL | `#${string}`;
  onSuccess?: () => void;
  placeholder?: string;
  compact?: boolean;
  autoFocus?: boolean;
}

const MAX_HEIGHT = 220;

export function CommentForm({
  root,
  reply,
  onSuccess,
  placeholder = 'Write a comment…',
  compact = false,
  autoFocus = false,
}: CommentFormProps) {
  const [content, setContent] = useState('');
  const { user } = useCurrentUser();
  const { mutate: postComment, isPending } = usePostComment();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea so the composer feels like a single fluid box
  // — same pattern Ditto uses in ComposeBox.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [content]);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!content.trim() || !user) return;

    postComment(
      { content: content.trim(), root, reply },
      {
        onSuccess: () => {
          setContent('');
          onSuccess?.();
        },
      },
    );
  };

  if (!user) {
    return (
      <div className={cn('flex flex-col items-center text-center gap-3 px-4', compact ? 'py-4' : 'py-6')}>
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <MessageSquare className="size-4" />
          <span>Sign in to {reply ? 'reply' : 'comment'}</span>
        </div>
        <LoginArea />
      </div>
    );
  }

  // The whole composer is one bordered box (`border-b` only when used in a
  // flush list, but we draw a top border for the inline reply variant via
  // its parent). The submit button sits in the same box, bottom-right —
  // it visually feels like part of the textarea container.
  return (
    <form onSubmit={handleSubmit} className={cn('px-4', compact ? 'pt-2 pb-2' : 'pt-3 pb-3')}>
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={placeholder}
        disabled={isPending}
        rows={1}
        dir="auto"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            handleSubmit();
          }
        }}
        className={cn(
          'w-full bg-transparent outline-none resize-none',
          'text-foreground placeholder:text-muted-foreground',
          'text-base break-words overflow-hidden',
          compact ? 'min-h-[36px]' : 'min-h-[44px]',
        )}
      />
      <div className="flex items-center justify-end mt-1">
        <Button
          type="submit"
          disabled={!content.trim() || isPending}
          size="sm"
          className="rounded-full px-5 font-semibold"
        >
          {isPending ? 'Posting…' : 'Post'}
        </Button>
      </div>
    </form>
  );
}
