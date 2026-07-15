import type { PropsWithChildren } from 'react';
import { AppHeader } from '../components/AppHeader';

export interface AppShellProps extends PropsWithChildren {
  admin: boolean;
  username?: string;
  contentId: string;
  onHome(): void;
  onStorage(): void;
  onSignIn(): void;
  onSignOut(): void | Promise<void>;
}

export function AppShell({
  admin,
  username,
  contentId,
  onHome,
  onStorage,
  onSignIn,
  onSignOut,
  children,
}: AppShellProps) {
  return (
    <div className="appShell">
      <a className="skipLink" href={`#${contentId}`}>Skip to content</a>
      <AppHeader
        admin={admin}
        username={username}
        onHome={onHome}
        onStorage={onStorage}
        onSignIn={onSignIn}
        onSignOut={onSignOut}
      />
      <div className="appOutlet">{children}</div>
    </div>
  );
}
