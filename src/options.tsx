import { createRoot } from 'react-dom/client';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';

import './lib/polyfills.ts';
import './index.css';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { bootCachedProfileTheme } from '@/lib/themeBoot';
import { App } from './App';
import { Options } from './pages/Options';
import { Accounts } from './pages/Accounts';
import { Wallet } from './pages/Wallet';

bootCachedProfileTheme();

// The options page is a single SPA shared by every long-lived extension
// tab. We route between the settings view (/) and the wallet view
// (/#/wallet) with HashRouter so the URL works under
// `chrome-extension://.../src/options.html#/wallet` without needing the
// browser to map paths to the bundle.
//
// `popup.html` and `prompt.html` stay separate because they are
// genuinely different surfaces (different sizes, lifecycles, and
// one-shot RPC flow for the prompt).
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App>
      <HashRouter>
        <Routes>
          <Route path="/" element={<Options />} />
          <Route path="/wallet" element={<Wallet />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/accounts/:pubkey" element={<Accounts />} />
          {/* Unknown hash → fall back to the settings view. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </App>
  </ErrorBoundary>,
);
