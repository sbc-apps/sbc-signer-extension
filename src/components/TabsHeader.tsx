/**
 * Topnav shared by the long-lived extension tabs (settings + wallet).
 *
 * Layout (single row):
 *   [Logo]   [ Settings ][ Wallet ]   [LoginArea]
 *
 * The middle group is rendered with react-router <NavLink>s so clicks
 * stay inside the bundle (no new tabs / reloads). The active link gets
 * a filled pill background; inactive links are muted with a subtle
 * hover surface.
 *
 * Renders inside the HashRouter mounted by `src/options.tsx`, so it
 * MUST NOT be used from `popup.tsx` or `prompt.tsx`.
 */

import { NavLink } from 'react-router-dom';

import { LoginArea } from '@/components/auth/LoginArea';
import { Logo } from '@/components/Logo';
import { cn } from '@/lib/utils';

interface TabsHeaderProps {
  className?: string;
}

const TABS: Array<{ to: string; label: string }> = [
  { to: '/', label: 'Settings' },
  { to: '/wallet', label: 'Wallet' },
];

export function TabsHeader({ className }: TabsHeaderProps) {
  return (
    <header className={cn('bg-background border-b', className)}>
      <div className="max-w-3xl mx-auto px-6 h-16 flex items-center justify-between gap-4">
        <NavLink to="/" aria-label="SBC Signer Extension" className="shrink-0">
          <Logo className="size-8" alt="SBC Signer" />
        </NavLink>

        <nav
          aria-label="Primary"
          className="hidden sm:flex items-center gap-1 bg-muted/40 border rounded-full p-1"
        >
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.to === '/'}
              className={({ isActive }) =>
                cn(
                  'inline-flex items-center h-8 px-4 rounded-full text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-background/60',
                )
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>

        <LoginArea />
      </div>

      {/*
        Narrow viewports (e.g. extension tab opened in a side-by-side
        window) hide the centered tab pills above; show them as a
        secondary row underneath instead. Keeps the header readable
        without truncating the title or LoginArea.
      */}
      <nav
        aria-label="Primary (compact)"
        className="sm:hidden border-t flex items-center gap-1 px-4 h-11 overflow-x-auto"
      >
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.to === '/'}
            className={({ isActive }) =>
              cn(
                'inline-flex items-center h-8 px-3 rounded-full text-sm font-medium transition-colors whitespace-nowrap',
                isActive
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}

export default TabsHeader;
