import { createRoot } from 'react-dom/client';

import './lib/polyfills.ts';
import './index.css';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { bootCachedProfileTheme } from '@/lib/themeBoot';
import { App } from './App';
import { HighlightComposer } from './pages/HighlightComposer';

bootCachedProfileTheme();

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App>
      <HighlightComposer />
    </App>
  </ErrorBoundary>,
);
