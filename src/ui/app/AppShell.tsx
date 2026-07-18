import type { PropsWithChildren } from 'react';
import { AppHeader } from '../components/AppHeader';
import { useI18n } from '../i18n/I18nProvider';

export interface AppShellProps extends PropsWithChildren {
  admin: boolean;
  username?: string;
  contentId: string;
  onHome(): void;
  onStorage(): void;
  onSignIn(): void;
  onSignOut(): void | Promise<void>;
  publicView?: boolean;
}

export function AppShell({
  admin,
  username,
  contentId,
  onHome,
  onStorage,
  onSignIn,
  onSignOut,
  publicView = false,
  children,
}: AppShellProps) {
  const { t } = useI18n();

  return (
    <div className="appShell">
      <a className="skipLink" href={`#${contentId}`}>{t('shell.skipToContent')}</a>
      <AppHeader
        admin={admin}
        username={username}
        onHome={onHome}
        onStorage={onStorage}
        onSignIn={onSignIn}
        onSignOut={onSignOut}
        showSessionActions={!publicView}
      />
      <div className="appOutlet">{children}</div>
    </div>
  );
}
