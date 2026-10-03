// App shell shared by the popup, prompt, and options surfaces. Each
// surface has its own entry point that mounts <App> with a child page.
//
// Providers configured here:
//  - QueryClientProvider — TanStack Query
//  - NostrProvider       — shared NPool, used for bunker handshakes and
//                          fetching profile metadata to display account names
//  - NostrLoginProvider  — login state persisted to `chrome.storage.local`
//                          via `extensionLoginStorage` so popup + background
//                          share state
//  - AppProvider         — theme + relay config (persisted to localStorage
//                          of the extension pages; not shared with content
//                          scripts by design)

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense } from 'react';
import { NostrLoginProvider } from '@nostrify/react/login';
import NostrProvider from '@/components/NostrProvider';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppProvider } from '@/components/AppProvider';
import { AppConfig } from '@/contexts/AppContext';
import { APP_RELAYS } from '@/lib/appRelays';
import { DEFAULT_ESPLORA_APIS } from '@/lib/esplora';
import { extensionLoginStorage, STORAGE_KEYS } from '@/extension/storage';
import { useApplyProfileTheme } from '@/hooks/useApplyProfileTheme';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 60_000,
      gcTime: Infinity,
    },
  },
});

const defaultConfig: AppConfig = {
  theme: 'light',
  relayMetadata: APP_RELAYS,
  blossomServerMetadata: {
    servers: [
      'https://blossom.ditto.pub/',
      'https://blossom.dreamith.to/',
    ],
    updatedAt: 0,
  },
  useAppBlossomServers: true,
  esploraApis: [...DEFAULT_ESPLORA_APIS],
};

interface AppProps {
  children: React.ReactNode;
}

export function App({ children }: AppProps) {
  return (
    <AppProvider storageKey="ditto-extension:app-config" defaultConfig={defaultConfig}>
      <QueryClientProvider client={queryClient}>
        <NostrLoginProvider storageKey={STORAGE_KEYS.login} storage={extensionLoginStorage}>
          <NostrProvider>
            <ProfileThemeApplier />
            <TooltipProvider>
              <Toaster />
              <Suspense>{children}</Suspense>
            </TooltipProvider>
          </NostrProvider>
        </NostrLoginProvider>
      </QueryClientProvider>
    </AppProvider>
  );
}

/**
 * Side-effect-only component: fetches the logged-in user's kind 16767
 * active profile theme and applies it to the document. Mounted inside
 * NostrProvider + NostrLoginProvider so the hooks have a relay pool and
 * login state.
 */
function ProfileThemeApplier() {
  useApplyProfileTheme();
  return null;
}

export default App;
