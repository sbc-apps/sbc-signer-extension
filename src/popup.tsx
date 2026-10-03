import { createRoot } from 'react-dom/client';

import './lib/polyfills.ts';
import './index.css';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { bootCachedProfileTheme } from '@/lib/themeBoot';
import { App } from './App';
import { Popup } from './pages/Popup';

// Apply the cached profile theme synchronously, before React mounts,
// so the popup paints the user's colors / background on first frame
// instead of flashing the default Tailwind tokens while the relay
// fetch finishes.
bootCachedProfileTheme();

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App>
      <Popup />
    </App>
  </ErrorBoundary>,
);
