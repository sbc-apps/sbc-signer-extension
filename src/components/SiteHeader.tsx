/**
 * Compact "this site" header — favicon (or globe fallback), display
 * title, and host. Used at the top of the popup to show the active tab,
 * and at the top of permission prompts to show the requesting origin.
 *
 * Intentionally container-less and action-less: just the identity of
 * the site. Wrap it in whatever layout the surrounding view needs.
 */
import { Globe } from 'lucide-react';

import { cn } from '@/lib/utils';

interface SiteHeaderProps {
  /** Full origin URL (e.g. `https://example.com`). Used for the host fallback. */
  origin: string;
  /** Optional favicon URL. Falls back to a globe icon if missing or fails to load. */
  icon?: string;
  /** Optional human-readable site title. Falls back to the host. */
  title?: string;
  className?: string;
}

export function SiteHeader({ origin, icon, title, className }: SiteHeaderProps) {
  const host = safeHost(origin);
  return (
    <div className={cn('flex items-start gap-3 min-w-0', className)}>
      <SiteAvatar origin={origin} icon={icon} />
      <div className="min-w-0 flex-1">
        <p className="text-base font-semibold truncate">{title ?? host}</p>
        <p className="text-xs text-muted-foreground font-mono truncate">{host}</p>
      </div>
    </div>
  );
}

function SiteAvatar({ origin, icon }: { origin: string; icon?: string }) {
  return (
    <div className="size-10 rounded-lg bg-muted flex items-center justify-center overflow-hidden shrink-0">
      {icon ? (
        <img
          src={icon}
          alt=""
          className="size-full object-cover"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : (
        <Globe className="size-5 text-muted-foreground" aria-label={origin} />
      )}
    </div>
  );
}

function safeHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
