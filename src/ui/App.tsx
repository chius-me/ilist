import { lazy, Suspense, useSyncExternalStore } from 'react';
import { AppProviders } from './app/AppProviders';
import { ExplorerApp } from './app/ExplorerApp';
import { ErrorBoundary, LocalizedErrorBoundary } from './components/ErrorBoundary';

const SharePage = lazy(() => import('./app/SharePage').then((module) => ({ default: module.SharePage })));

function subscribePathname(callback: () => void): () => void {
  window.addEventListener('popstate', callback);
  return () => window.removeEventListener('popstate', callback);
}

function pathnameSnapshot(): string {
  return window.location.pathname;
}

function CurrentRoute() {
  const pathname = useSyncExternalStore(subscribePathname, pathnameSnapshot, pathnameSnapshot);
  const match = /^\/s\/([^/]+)\/?$/.exec(pathname);
  if (match) {
    let token: string;
    try { token = decodeURIComponent(match[1]); } catch { token = match[1]; }
    return (
      <Suspense fallback={null}>
        <SharePage token={token} />
      </Suspense>
    );
  }
  return <ExplorerApp />;
}

export function App() {
  return (
    <ErrorBoundary>
      <AppProviders>
        <LocalizedErrorBoundary>
          <CurrentRoute />
        </LocalizedErrorBoundary>
      </AppProviders>
    </ErrorBoundary>
  );
}
