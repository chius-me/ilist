import { ArrowDownAZ, Grid2X2, List, Plus, RefreshCw, Search, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { SessionStatus } from '../../hooks/useSession';
import { useI18n } from '../../i18n/I18nProvider';
import type { Breadcrumb } from '../../types/entries';
import { Breadcrumbs } from './Breadcrumbs';

export type ExplorerView = 'list' | 'grid';
export type ExplorerSortField = 'name' | 'size' | 'updated';
export type ExplorerSort = { field: ExplorerSortField; order: 'asc' | 'desc' };

interface ExplorerToolbarProps {
  breadcrumbs: Breadcrumb[];
  query: string;
  sort: ExplorerSort;
  view: ExplorerView;
  refreshing: boolean;
  sessionStatus: SessionStatus;
  selectionCount: number;
  canUpload: boolean;
  canCreateFolder: boolean;
  onQuery: (query: string) => void;
  onOpenPath: (path: string) => void;
  onRefresh: () => void;
  onSort: (sort: ExplorerSort) => void;
  onView: (view: ExplorerView) => void;
  onUpload: (files: File[]) => void;
  onCreateFolder: () => void;
}

export function ExplorerToolbar({
  breadcrumbs,
  query,
  sort,
  view,
  refreshing,
  sessionStatus,
  selectionCount,
  canUpload,
  canCreateFolder,
  onQuery,
  onOpenPath,
  onRefresh,
  onSort,
  onView,
  onUpload,
  onCreateFolder,
}: ExplorerToolbarProps) {
  const { t } = useI18n();
  const admin = sessionStatus === 'admin';
  const uploadInput = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const toolbar = useRef<HTMLElement>(null);
  const adminMenuButton = useRef<HTMLButtonElement>(null);
  const adminMenu = useRef<HTMLDivElement>(null);
  const restoreSearchFocus = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);

  useEffect(() => {
    if (searchOpen) {
      searchInput.current?.focus();
      return;
    }
    if (restoreSearchFocus.current) {
      searchButton.current?.focus();
      restoreSearchFocus.current = false;
    }
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (toolbar.current?.contains(event.target as Node)) return;
      restoreSearchFocus.current = true;
      setSearchOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [searchOpen]);

  useEffect(() => {
    if (!adminMenuOpen) return;
    const trigger = adminMenuButton.current;
    adminMenu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (adminMenu.current?.contains(target) || trigger?.contains(target)) return;
      setAdminMenuOpen(false);
    };
    const handleMenuKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setAdminMenuOpen(false);
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !adminMenu.current) return;
      event.preventDefault();
      const items = [...adminMenu.current.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? items.length - 1
          : event.key === 'ArrowDown' ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', handleMenuKey);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', handleMenuKey);
      trigger?.focus();
    };
  }, [adminMenuOpen]);

  function updateSort(event: ChangeEvent<HTMLSelectElement>) {
    onSort({ ...sort, field: event.target.value as ExplorerSortField });
  }

  function closeSearch() {
    restoreSearchFocus.current = true;
    setSearchOpen(false);
  }

  function openUpload() {
    setAdminMenuOpen(false);
    uploadInput.current?.click();
  }

  function createFolder() {
    setAdminMenuOpen(false);
    onCreateFolder();
  }

  return (
    <section ref={toolbar} className="explorerToolbar" aria-label={t('toolbar.controls')}>
      <div className="toolbarPath">
        {searchOpen ? <label className="searchControl searchOverlay">
          <Search aria-hidden="true" size={17} />
          <span className="srOnly">{t('toolbar.search')}</span>
          <input ref={searchInput} value={query} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeSearch();
            }
          }} placeholder={t('toolbar.search')} />
        </label> : <Breadcrumbs items={breadcrumbs} onOpen={onOpenPath} />}
      </div>
      <div className="toolbarActions">
        {!searchOpen ? <button ref={searchButton} className="iconButton" type="button" title={t('toolbar.search')} aria-label={t('toolbar.search')} onClick={() => setSearchOpen(true)}>
          <Search aria-hidden="true" size={17} />
        </button> : null}
        <label className="sortControl">
          <span className="srOnly">{t('toolbar.sort')}</span>
          <select value={sort.field} onChange={updateSort} aria-label={t('toolbar.sort')}>
            <option value="name">{t('toolbar.name')}</option>
            <option value="updated">{t('toolbar.modified')}</option>
            <option value="size">{t('toolbar.size')}</option>
          </select>
        </label>
        <button
          className="iconButton"
          type="button"
          title={sort.order === 'asc' ? t('toolbar.ascending') : t('toolbar.descending')}
          aria-label={sort.order === 'asc' ? t('toolbar.sortAscending') : t('toolbar.sortDescending')}
          onClick={() => onSort({ ...sort, order: sort.order === 'asc' ? 'desc' : 'asc' })}
        >
          <ArrowDownAZ aria-hidden="true" size={17} className={sort.order === 'desc' ? 'sortDescending' : undefined} />
        </button>
        <button className="iconButton" type="button" onClick={onRefresh} disabled={refreshing} aria-label={t('action.refresh')} title={t('action.refresh')}>
          <RefreshCw aria-hidden="true" size={16} className={refreshing ? 'isSpinning' : undefined} />
        </button>
        <div className="viewToggle desktopViewToggle" role="group" aria-label={t('toolbar.viewMode')}>
          <button
            className={view === 'list' ? 'active' : undefined}
            type="button"
            title={t('toolbar.list')}
            aria-label={t('toolbar.list')}
            aria-pressed={view === 'list'}
            onClick={() => onView('list')}
          >
            <List aria-hidden="true" size={17} />
          </button>
          <button
            className={view === 'grid' ? 'active' : undefined}
            type="button"
            title={t('toolbar.grid')}
            aria-label={t('toolbar.grid')}
            aria-pressed={view === 'grid'}
            onClick={() => onView('grid')}
          >
            <Grid2X2 aria-hidden="true" size={17} />
          </button>
        </div>
        <div className="mobileViewToggle">
          <button
            type="button"
            title={view === 'list' ? t('toolbar.switchToGrid') : t('toolbar.switchToList')}
            aria-label={view === 'list' ? t('toolbar.switchToGrid') : t('toolbar.switchToList')}
            onClick={() => onView(view === 'list' ? 'grid' : 'list')}
          >
            {view === 'list' ? <Grid2X2 aria-hidden="true" size={17} /> : <List aria-hidden="true" size={17} />}
          </button>
        </div>
        {admin ? (
          <>
            <input ref={uploadInput} className="srOnly" type="file" multiple tabIndex={-1} onChange={(event) => {
              onUpload(Array.from(event.target.files ?? []));
              event.target.value = '';
            }} />
            <div className="desktopAdminActions">
              {canUpload ? <button className="iconButton" type="button" title={t('toolbar.upload')} aria-label={t('toolbar.upload')} onClick={openUpload}>
                <Upload aria-hidden="true" size={17} />
              </button> : null}
              {canCreateFolder ? <button className="iconButton" type="button" title={t('toolbar.createFolder')} aria-label={t('toolbar.createFolder')} onClick={createFolder}>
                <Plus aria-hidden="true" size={17} />
              </button> : null}
            </div>
            {canUpload || canCreateFolder ? <div className="mobileAdminActions">
              <button ref={adminMenuButton} className="iconButton" type="button" title={t('toolbar.adminMenu')} aria-label={t('toolbar.adminMenu')} aria-haspopup="menu" aria-expanded={adminMenuOpen} onClick={() => setAdminMenuOpen((open) => !open)}>
                <Plus aria-hidden="true" size={17} />
              </button>
              {adminMenuOpen ? <div ref={adminMenu} className="mobileAdminMenu" role="menu" aria-label={t('toolbar.adminMenu')}>
                {canUpload ? <button type="button" role="menuitem" onClick={openUpload}><Upload aria-hidden="true" size={17} />{t('toolbar.upload')}</button> : null}
                {canCreateFolder ? <button type="button" role="menuitem" onClick={createFolder}><Plus aria-hidden="true" size={17} />{t('toolbar.createFolder')}</button> : null}
              </div> : null}
            </div> : null}
            {selectionCount > 0 ? <span className="selectionCount">{t('selection.count', { count: selectionCount })}</span> : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
