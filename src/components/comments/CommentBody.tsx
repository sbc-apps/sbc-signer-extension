/**
 * Lightweight renderer for comment text. Linkifies http(s) URLs into
 * external anchors and preserves whitespace. Built with JSX nodes only —
 * NEVER `dangerouslySetInnerHTML` — because comment content is fully
 * untrusted user input.
 */

interface CommentBodyProps {
  content: string;
  className?: string;
}

// Match http(s) URLs. Trailing punctuation is intentionally excluded so
// "see https://example.com." doesn't capture the period.
const URL_REGEX = /(https?:\/\/[^\s<>"'`]+[^\s<>"'`,.!?:;)\]}])/gi;

function isSafeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function CommentBody({ content, className }: CommentBodyProps) {
  const parts: Array<string | { url: string }> = [];
  let lastIndex = 0;
  for (const match of content.matchAll(URL_REGEX)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) parts.push(content.slice(lastIndex, idx));
    parts.push({ url: match[0] });
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < content.length) parts.push(content.slice(lastIndex));

  return (
    <div className={`whitespace-pre-wrap break-words ${className ?? ''}`}>
      {parts.map((part, i) => {
        if (typeof part === 'string') return <span key={i}>{part}</span>;
        if (!isSafeUrl(part.url)) return <span key={i}>{part.url}</span>;
        return (
          <a
            key={i}
            href={part.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline break-all"
          >
            {part.url}
          </a>
        );
      })}
    </div>
  );
}
