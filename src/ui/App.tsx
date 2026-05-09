import { ExplorerApp } from './app/ExplorerApp';
import { AppProviders } from './app/AppProviders';
import { SharePage } from './app/SharePage';

function CurrentRoute() {
  const match = /^\/s\/([^/]+)\/?$/.exec(window.location.pathname);
  if (match) {
    let token: string;
    try { token = decodeURIComponent(match[1]); } catch { token = match[1]; }
    return <SharePage token={token} />;
  }
  return <ExplorerApp />;
}

export function App() {
  return <AppProviders><CurrentRoute /></AppProviders>;
}
