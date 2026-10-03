import { createRoot } from 'react-dom/client';

import './lib/polyfills.ts';
import './index.css';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { bootCachedProfileTheme } from '@/lib/themeBoot';
import { App } from './App';
import { Prompt } from './pages/Prompt';

bootCachedProfileTheme();

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App>
      <Prompt />
    </App>
  </ErrorBoundary>,
);
