import { ArrowLeft, Database, Menu, Palette, Share2, X } from 'lucide-react';
import { type MouseEvent, type PropsWithChildren, useEffect, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';

export type AdminSection = 'storage' | 'shares' | 'appearance';

export interface AdminLayoutProps extends PropsWithChildren {
  active: AdminSection;
  onNavigate(section: AdminSection): void;
  onBack(): void;
}

export function AdminLayout({ active, onNavigate, onBack, children }: AdminLayoutProps) {
  const { t } = useI18n();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  function navigate(event: MouseEvent<HTMLAnchorElement>, section: AdminSection) {
    event.preventDefault();
    setDrawerOpen(false);
    onNavigate(section);
  }

  function back(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    setDrawerOpen(false);
    onBack();
  }

  return (
    <div className={`adminLayout${drawerOpen ? ' adminDrawerOpen' : ''}`}>
      <button className="adminMenuButton button" type="button" aria-expanded={drawerOpen} aria-controls="admin-navigation" onClick={() => setDrawerOpen((current) => !current)}>
        {drawerOpen ? <X aria-hidden="true" size={17} /> : <Menu aria-hidden="true" size={17} />}
        {t('admin.menu')}
      </button>
      <aside className="adminSidebar" id="admin-navigation" inert={narrow && !drawerOpen ? true : undefined} aria-hidden={narrow && !drawerOpen ? true : undefined}>
        <nav aria-label={t('admin.navigation')}>
          <a href="/" onClick={back}><ArrowLeft aria-hidden="true" size={17} />{t('nav.files')}</a>
          <span className="adminNavLabel">{t('shell.admin')}</span>
          <a className={active === 'storage' ? 'isActive' : ''} href="/admin/storages" aria-current={active === 'storage' ? 'page' : undefined} onClick={(event) => navigate(event, 'storage')}><Database aria-hidden="true" size={17} />{t('nav.storage')}</a>
          <a className={active === 'shares' ? 'isActive' : ''} href="/admin/shares" aria-current={active === 'shares' ? 'page' : undefined} onClick={(event) => navigate(event, 'shares')}><Share2 aria-hidden="true" size={17} />{t('nav.shares')}</a>
          <a className={active === 'appearance' ? 'isActive' : ''} href="/admin/appearance" aria-current={active === 'appearance' ? 'page' : undefined} onClick={(event) => navigate(event, 'appearance')}><Palette aria-hidden="true" size={17} />{t('nav.appearance')}</a>
        </nav>
      </aside>
      {drawerOpen ? <button className="adminDrawerScrim" type="button" aria-label={t('admin.closeMenu')} onClick={() => setDrawerOpen(false)} /> : null}
      <div className="adminContent">{children}</div>
    </div>
  );
}
