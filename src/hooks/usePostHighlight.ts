/**
 * Post a single NIP-84 highlight (kind 9802).
 *
 * NIP-84's "Quote Highlights" section is explicit: when the user adds
 * commentary, it MUST travel as a `["comment", "<text>"]` tag on the
 * highlight itself — never as a separate kind 1 / kind 1111 event.
 * The spec calls that out specifically:
 *
 *   > This is to prevent the creation of multiple notes (highlight +
 *   > kind 1) for a single highlight action, which looks bad in
 *   > micro-blogging clients where these notes may appear in
 *   > succession.
 *
 * When a comment is present, the spec also requires marker hygiene so
 * a renderer can tell the highlighted material apart from anything
 * the user mentioned in their comment:
 *
 *   - The page URL's `r` tag MUST carry the `source` marker.
 *   - Any `r` tag scraped from the comment text MUST carry `mention`.
 *   - Any `p` tag scraped from the comment text MUST carry `mention`
 *     (to distinguish it from `author` / `editor` attributions).
 *
 * Author p-tags from `<link rel="me" href="nostr:…">` are kept
 * unmarked (the spec lets `author` be implicit), which also matches
 * what was previously published before the comment-fix.
 */
import { useMutation } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import type { NostrEvent } from '@nostrify/nostrify';

import { useNostrPublish } from './useNostrPublish';

interface PostHighlightParams {
  /** The highlighted excerpt — becomes the kind 9802 `event.content`. */
  selectionText: string;
  /**
   * Surrounding paragraph. Must satisfy `contextText.includes(selectionText)`
   * or it is dropped (Ditto's renderer rejects malformed context tags).
   */
  contextText: string | null;
  /** Source URL (already canonicalized). Becomes the `r` tag. */
  pageUrl: string;
  /** Hex pubkeys for `p` attribution tags. */
  pAuthors: string[];
  /**
   * Optional commentary. Attached as a `comment` tag on the highlight
   * — never published as a separate event.
   */
  comment?: string;
}

interface PostHighlightResult {
  highlight: NostrEvent;
}

/**
 * Pull `nostr:` URIs out of the comment text and decode npub /
 * nprofile entries into hex pubkeys. Silently drops everything else
 * (note / nevent / naddr / malformed bech32) — those would need q / e
 * / a tags which the spec doesn't address here.
 */
function extractCommentMentionPubkeys(comment: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // `nostr:` URI scheme is bech32 only — letters, digits, and `1`.
  const re = /nostr:([a-z0-9]+)/gi;
  for (const match of comment.matchAll(re)) {
    let hex: string | null = null;
    try {
      const decoded = nip19.decode(match[1]);
      if (decoded.type === 'npub') {
        hex = decoded.data;
      } else if (decoded.type === 'nprofile') {
        hex = decoded.data.pubkey;
      }
    } catch {
      // Malformed bech32 — skip.
    }
    if (!hex) continue;
    if (!/^[0-9a-f]{64}$/i.test(hex)) continue;
    const lower = hex.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

/**
 * Extract bare http(s) URLs from the comment text. Strips trailing
 * punctuation that is almost certainly sentence punctuation rather
 * than part of the URL, then dedupes.
 */
function extractCommentMentionUrls(comment: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\bhttps?:\/\/[^\s<>"'`]+/gi;
  for (const match of comment.matchAll(re)) {
    let url = match[0];
    // Strip trailing punctuation that's almost certainly sentence
    // punctuation rather than URL syntax.
    url = url.replace(/[),.;:!?\]]+$/, '');
    if (!url) continue;
    try {
      // Normalize (rejects garbage), but publish the original form.
      new URL(url);
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

export function usePostHighlight() {
  const { mutateAsync: publishEvent } = useNostrPublish();

  return useMutation<PostHighlightResult, Error, PostHighlightParams>({
    mutationFn: async ({
      selectionText,
      contextText,
      pageUrl,
      pAuthors,
      comment,
    }) => {
      const trimmedComment = comment?.trim() ?? '';
      const hasComment = trimmedComment.length > 0;

      const tags: string[][] = [];

      // Source URL. When there's a comment we MUST mark it `source`
      // so renderers can tell it apart from any `r` mentions parsed
      // out of the comment text.
      tags.push(hasComment ? ['r', pageUrl, 'source'] : ['r', pageUrl]);

      if (
        typeof contextText === 'string' &&
        contextText.length > 0 &&
        contextText.includes(selectionText)
      ) {
        tags.push(['context', contextText]);
      }

      // Author p-tags from <link rel="me" href="nostr:…">. Unmarked —
      // `author` is implicit per NIP-84, and this matches what we
      // already published before the comment-tag fix.
      const authorSet = new Set<string>();
      for (const hex of pAuthors) {
        const lower = hex.toLowerCase();
        if (authorSet.has(lower)) continue;
        authorSet.add(lower);
        tags.push(['p', lower]);
      }

      if (hasComment) {
        // Mentions parsed out of the comment text — must carry the
        // `mention` marker to distinguish from author p-tags and the
        // source r-tag.
        for (const hex of extractCommentMentionPubkeys(trimmedComment)) {
          if (authorSet.has(hex)) continue; // already a (stronger) author tag
          tags.push(['p', hex, '', 'mention']);
        }
        for (const url of extractCommentMentionUrls(trimmedComment)) {
          if (url === pageUrl) continue; // already the source r-tag
          tags.push(['r', url, 'mention']);
        }

        tags.push(['comment', trimmedComment]);
      }

      const highlight = await publishEvent({
        kind: 9802,
        content: selectionText,
        tags,
      });

      return { highlight };
    },
  });
}
