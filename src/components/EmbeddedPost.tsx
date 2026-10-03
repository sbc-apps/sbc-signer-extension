/**
 * `EmbeddedPost` — compact preview of an *unsigned* Nostr event used by
 * the permission prompt to show the user exactly what a page is asking
 * them to sign.
 *
 * This is a port of Ditto's `EmbeddedPost` / `EmbeddedNote` layout
 * (see soapbox/ditto: `src/components/EmbeddedPost.tsx`,
 * `src/components/EmbeddedNote.tsx`, `src/components/EmbeddedCardShell.tsx`)
 * stripped down to what the extension actually needs:
 *
 *   - Pages call `window.nostr.signEvent({event})` with an *unsigned*
 *     event template — no `id`, no `sig`. Ditto's component fetches a
 *     finalized event from a relay by id, which doesn't apply here. We
 *     render the in-memory template directly instead.
 *   - The signing pubkey is implicit (the logged-in account) so the
 *     author row doesn't need to resolve a hex pubkey from the event.
 *   - There's no navigation target for an unsigned event, so the card
 *     is presentational rather than clickable.
 *   - Heavy linkification, custom emoji, blossom uploads, webxdc, BTC
 *     signers, HLS video etc. are all dropped — the prompt window is a
 *     400×600 popup and just needs enough context for an informed
 *     allow/deny decision.
 *
 * The kind label comes from `@/lib/eventKinds`, whose registry is
 * itself a port of Ditto's `KIND_LABELS`. The two surfaces stay in
 * sync that way. We deliberately don't surface the raw kind number
 * or its storage class ("Replaceable" / "Addressable" / "Ephemeral")
 * in user copy — those are protocol implementation details, and the
 * friendly label alone is enough for an allow/deny decision.
 */

import { type ReactNode } from 'react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { useLoggedInAccounts } from '@/hooks/useLoggedInAccounts';
import { kindLabel } from '@/lib/eventKinds';
import { genUserName } from '@/lib/genUserName';
import { cn } from '@/lib/utils';

/**
 * Shape of an unsigned event template as it arrives in
 * `signEvent` params. Every field is optional because we only see what
 * the page sent us — we display whatever's there and tolerate the rest.
 *
 * This intentionally does NOT depend on `@nostrify/nostrify`'s
 * `NostrEvent` type, which requires `id`/`pubkey`/`sig` (an unsigned
 * template doesn't have those yet).
 */
export interface UnsignedEventLike {
  kind?: number;
  content?: string;
  tags?: string[][];
  created_at?: number;
}

interface EmbeddedPostProps {
  /** The unsigned event to preview. */
  event: UnsignedEventLike;
  /** Extra classes applied to the outermost wrapper. */
  className?: string;
  /**
   * Override the author shown in the card header. Defaults to the
   * currently-logged-in account because that's whose key would sign
   * the event. Pass an explicit pubkey if some other context (e.g. a
   * NIP-46 bunker proxy) needs to surface a different author.
   */
  authorPubkey?: string;
}

/**
 * Compact embedded preview of an unsigned Nostr event.
 *
 * Renders an author row (the logged-in user), the kind label as a
 * header, an excerpt of the event content, and a small footer with
 * kind number + tag count. Falls back gracefully when fields are
 * missing — a malformed `signEvent` request still renders *something*
 * the user can look at before deciding.
 */
export function EmbeddedPost({ event, className, authorPubkey }: EmbeddedPostProps) {
  const { currentUser, isLoading } = useLoggedInAccounts();
  const pubkey = authorPubkey ?? currentUser?.pubkey;
  const metadata = currentUser?.metadata;
  const displayName =
    metadata?.name ?? metadata?.display_name ?? (pubkey ? genUserName(pubkey) : 'Unknown');
  // While the metadata query is in-flight, don't flash a generated
  // animal name — show a skeleton instead.
  const isPending = isLoading && !metadata?.name && !metadata?.display_name;

  const kind = typeof event.kind === 'number' ? event.kind : undefined;
  const kindName = kind !== undefined ? kindLabel(kind) : 'Event';
  const content = typeof event.content === 'string' ? event.content : '';
  const trimmed = content.trim();

  return (
    <CardShell className={className}>
      <div className="flex items-center gap-2 min-w-0">
        {isPending ? (
          <>
            <Skeleton className="size-5 rounded-full shrink-0" />
            <Skeleton className="h-3.5 w-24" />
          </>
        ) : (
          <>
            <Avatar className="size-5 shrink-0">
              <AvatarImage src={metadata?.picture} alt={displayName} />
              <AvatarFallback className="bg-primary/20 text-primary text-[10px]">
                {displayName.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="text-sm font-semibold truncate">{displayName}</span>
          </>
        )}
        <span className="text-xs text-muted-foreground shrink-0 truncate">
          · {kindName}
        </span>
      </div>

      {trimmed &&
        (isLikelyBase64(trimmed) ? (
          <p className="text-xs italic text-muted-foreground">encrypted content</p>
        ) : (
          <ContentPreview text={trimmed} />
        ))}
    </CardShell>
  );
}

/**
 * Heuristic: does this string look like it's *wholly* a base64 blob (e.g.
 * NIP-44 ciphertext, as carried by a giftwrap seal's `content`)? If so we
 * show "encrypted content" instead of dumping an unreadable base64 wall
 * into the preview.
 *
 * We require the whole (trimmed) string to be valid base64 / base64url
 * characters, a length divisible by 4 (standard base64 padding), and a
 * minimum length so short human strings that happen to be base64-shaped
 * (e.g. "Test") aren't misclassified.
 */
function isLikelyBase64(text: string): boolean {
  if (text.length < 24 || text.length % 4 !== 0) return false;
  // base64 / base64url alphabet, with optional trailing '=' padding.
  return /^[A-Za-z0-9+/_-]+={0,2}$/.test(text);
}

/**
 * Outer card shell — same border / radius / hover treatment as Ditto's
 * `EmbeddedCardShell`, minus the click-to-navigate behavior (an
 * unsigned event has no permalink to navigate to).
 */
function CardShell({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'group block rounded-2xl border border-border overflow-hidden bg-background',
        className,
      )}
    >
      <div className="px-3 py-2 space-y-1.5">{children}</div>
    </div>
  );
}

/** Content preview — pre-wrapped, line-clamped, scrollable when overflowing. */
function ContentPreview({ text }: { text: string }) {
  return (
    <p className="text-xs whitespace-pre-wrap break-words max-h-32 overflow-y-auto text-foreground">
      {text}
    </p>
  );
}
