import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NostrLoginProvider } from '@nostrify/react/login';
import NostrProvider from '@/components/NostrProvider';
import { AppProvider } from '@/components/AppProvider';
import { AppConfig } from '@/contexts/AppContext';

interface TestAppProps {
  children: React.ReactNode;
}

export function TestApp({ children }: TestAppProps) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const defaultConfig: AppConfig = {
    theme: 'light',
    relayMetadata: {
      relays: [{ url: 'wss://relay.primal.net', read: true, write: true }],
      updatedAt: 0,
    },
    blossomServerMetadata: {
      servers: ['https://blossom.primal.net/'],
      updatedAt: 0,
    },
    useAppBlossomServers: true,
    esploraApis: ['https://mempool.space/api'],
  };

  return (
    <AppProvider storageKey="test-app-config" defaultConfig={defaultConfig}>
      <QueryClientProvider client={queryClient}>
        <NostrLoginProvider storageKey="test-login">
          <NostrProvider>{children}</NostrProvider>
        </NostrLoginProvider>
      </QueryClientProvider>
    </AppProvider>
  );
}

export default TestApp;
