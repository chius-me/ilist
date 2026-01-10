import { useEffect, useRef, useState } from 'react';
import { LoginDialog } from '../features/explorer/LoginDialog';
import { MountManager } from '../features/mounts/MountManager';
import { useExplorerLocation } from '../hooks/useExplorerLocation';
import { useSession } from '../hooks/useSession';
import { AppShell } from './AppShell';
import { AdminLayout, type AdminSection } from './AdminLayout';
import { ExplorerPage } from './ExplorerPage';
import { PreferencesPage } from './PreferencesPage';
import { useI18n } from '../i18n/I18nProvider';
import { localizedApiError } from '../i18n/apiErrors';

export function ExplorerApp() {
  const { t } = useI18n();
  const { path, previewId, openPath, openPreview, closePreview } = useExplorerLocation();
  const session = useSession();
  const lastNonAdminPath = useRef('/');
  const storageRoute = path === '/admin/storages';
  const appearanceRoute = path === '/admin/appearance';
  const adminSection: AdminSection | null = storageRoute ? 'storage' : appearanceRoute ? 'appearance' : null;
  const adminRoute = path === '/admin' || adminSection !== null;
  const explorerPath = adminRoute ? lastNonAdminPath.current : path;
  const admin = session.status === 'admin';
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    if (!path.startsWith('/admin')) lastNonAdminPath.current = path;
  }, [path]);

  async function submitLogin(username: string, password: string) {
    setLoginBusy(true);
    setLoginError(null);
    try {
      await session.signIn(username, password);
      if (!adminSection) openPath(lastNonAdminPath.current);
    } catch (error) {
      setLoginError(localizedApiError(error, t, 'login.unableSignIn'));
    } finally {
      setLoginBusy(false);
    }
  }

  function closeLogin() {
    setLoginError(null);
    openPath(lastNonAdminPath.current);
  }

  async function signOut() {
    await session.signOut();
    if (path.startsWith('/admin')) openPath(lastNonAdminPath.current);
  }

  return (
    <AppShell
      admin={admin}
      username={session.user?.username}
      contentId={adminSection === 'storage' && admin ? 'storage-manager' : adminSection === 'appearance' && admin ? 'appearance-preferences' : 'file-list'}
      onHome={() => openPath('/')}
      onStorage={() => openPath('/admin/storages')}
      onSignIn={() => openPath('/admin')}
      onSignOut={signOut}
    >
      {adminSection && admin
        ? <AdminLayout active={adminSection} onNavigate={(section) => openPath(`/admin/${section === 'storage' ? 'storages' : 'appearance'}`)} onBack={() => openPath(lastNonAdminPath.current)}>
            {adminSection === 'storage' ? <MountManager onBack={() => openPath(lastNonAdminPath.current)} /> : <PreferencesPage />}
          </AdminLayout>
        : <ExplorerPage
            path={explorerPath}
            previewId={previewId}
            session={session}
            onOpenPath={openPath}
            onOpenPreview={openPreview}
            onClosePreview={closePreview}
            onRequestLogin={() => openPath('/admin')}
          />}
      <LoginDialog open={adminRoute && session.status !== 'admin'} busy={loginBusy} error={loginError} onClose={closeLogin} onSubmit={submitLogin} />
    </AppShell>
  );
}
