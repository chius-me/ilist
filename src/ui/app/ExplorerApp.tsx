import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useUploadQueue, type EnqueueUploadOptions } from '../features/uploads/useUploadQueue';
import { useExplorerLocation } from '../hooks/useExplorerLocation';
import { useSession } from '../hooks/useSession';
import { localizedApiError } from '../i18n/apiErrors';
import { useI18n } from '../i18n/I18nProvider';
import { AdminLayout, type AdminSection } from './AdminLayout';
import { AppShell } from './AppShell';
import { ExplorerPage } from './ExplorerPage';

const LoginDialog = lazy(() => import('../features/explorer/LoginDialog').then((module) => ({ default: module.LoginDialog })));
const MountManager = lazy(() => import('../features/mounts/MountManager').then((module) => ({ default: module.MountManager })));
const ShareManager = lazy(() => import('../features/shares/ShareManager').then((module) => ({ default: module.ShareManager })));
const UploadPanel = lazy(() => import('../features/uploads/UploadPanel').then((module) => ({ default: module.UploadPanel })));
const PreferencesPage = lazy(() => import('./PreferencesPage').then((module) => ({ default: module.PreferencesPage })));

export function ExplorerApp() {
  const { t } = useI18n();
  const { path, previewId, openPath, openPreview, closePreview } = useExplorerLocation();
  const session = useSession();
  const lastNonAdminPath = useRef('/');
  const uploadCompletedListeners = useRef(new Set<(parentId: string) => void>());
  const storageRoute = path === '/admin/storages';
  const appearanceRoute = path === '/admin/appearance';
  const sharesRoute = path === '/admin/shares';
  const adminSection: AdminSection | null = storageRoute ? 'storage' : sharesRoute ? 'shares' : appearanceRoute ? 'appearance' : null;
  const adminRoute = path === '/admin' || adminSection !== null;
  const explorerPath = adminRoute ? lastNonAdminPath.current : path;
  const admin = session.status === 'admin';
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const onUploadCompleted = useCallback((parentId: string) => {
    uploadCompletedListeners.current.forEach((listener) => { listener(parentId); });
  }, []);

  const subscribeUploadCompleted = useCallback((listener: (parentId: string) => void) => {
    uploadCompletedListeners.current.add(listener);
    return () => { uploadCompletedListeners.current.delete(listener); };
  }, []);

  const uploads = useUploadQueue({
    enabled: admin,
    onCompleted: onUploadCompleted,
  });

  const enqueueUpload = useCallback(
    (parentId: string, files: File[], options?: EnqueueUploadOptions) => {
      uploads.enqueue(parentId, files, options);
    },
    [uploads],
  );

  useEffect(() => {
    if (!path.startsWith('/admin')) lastNonAdminPath.current = path;
  }, [path]);

  useEffect(() => {
    if (adminSection && admin) {
      const titleKey = adminSection === 'storage'
        ? 'admin.storageTitle'
        : adminSection === 'shares'
          ? 'admin.sharesTitle'
          : 'admin.appearanceTitle';
      document.title = `${t(titleKey)} · iList`;
      return;
    }
    if (adminRoute && session.status === 'guest') {
      document.title = `${t('nav.signIn')} · iList`;
    }
  }, [admin, adminRoute, adminSection, session.status, t]);

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
    session.clearError();
    openPath(lastNonAdminPath.current);
  }

  async function signOut() {
    await session.signOut();
    if (path.startsWith('/admin')) openPath(lastNonAdminPath.current);
  }

  const loginOpen = adminRoute && session.status === 'guest';

  return (
    <AppShell
      admin={admin}
      username={session.user?.username}
      contentId={adminSection === 'storage' && admin ? 'storage-manager' : adminSection === 'shares' && admin ? 'share-manager' : adminSection === 'appearance' && admin ? 'appearance-preferences' : 'file-list'}
      onHome={() => openPath('/')}
      onStorage={() => openPath('/admin/storages')}
      onSignIn={() => openPath('/admin')}
      onSignOut={signOut}
    >
      {adminSection && admin
        ? <AdminLayout active={adminSection} onNavigate={(section) => openPath(`/admin/${section === 'storage' ? 'storages' : section}`)} onBack={() => openPath(lastNonAdminPath.current)}>
            <Suspense fallback={null}>
              {adminSection === 'storage'
                ? <MountManager onBack={() => openPath(lastNonAdminPath.current)} />
                : adminSection === 'shares'
                  ? <ShareManager />
                  : <PreferencesPage />}
            </Suspense>
          </AdminLayout>
        : <ExplorerPage
            path={explorerPath}
            previewId={previewId}
            session={session}
            suppressSessionError={loginOpen}
            onEnqueueUpload={enqueueUpload}
            onSubscribeUploadCompleted={subscribeUploadCompleted}
            onOpenPath={openPath}
            onOpenPreview={openPreview}
            onClosePreview={closePreview}
            onRequestLogin={() => openPath('/admin')}
          />}
      {uploads.tasks.length > 0 ? (
        <Suspense fallback={null}>
          <UploadPanel
            tasks={uploads.tasks}
            onPause={uploads.pause}
            onResume={uploads.resume}
            onCancel={uploads.cancel}
            onRetry={uploads.retry}
            onRebind={uploads.rebind}
            onRemove={uploads.remove}
            onClearCompleted={uploads.clearCompleted}
          />
        </Suspense>
      ) : null}
      {loginOpen ? (
        <Suspense fallback={null}>
          <LoginDialog open busy={loginBusy} error={loginError} onClose={closeLogin} onSubmit={submitLogin} />
        </Suspense>
      ) : null}
    </AppShell>
  );
}
