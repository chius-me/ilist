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
  const restoreSearchFocus = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);

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

  function updateSort(event: ChangeEvent<HTMLSelectElement>) {
    onSort({ ...sort, field: event.target.value as ExplorerSortField });
  }

  function closeSearch() {
    restoreSearchFocus.current = true;
    setSearchOpen(false);
  }

  return (
    <section ref={toolbar} className="explorerToolbar" aria-label={t('toolbar.controls')}>
      <Breadcrumbs items={breadcrumbs} onOpen={onOpenPath} />
      <div className="toolbarActions">
        {searchOpen ? <label className="searchControl">
          <Search aria-hidden="true" size={17} />
          <span className="srOnly">{t('toolbar.search')}</span>
          <input ref={searchInput} value={query} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeSearch();
            }
          }} placeholder={t('toolbar.search')} />
        </label> : <button ref={searchButton} className="iconButton" type="button" title={t('toolbar.search')} aria-label={t('toolbar.search')} onClick={() => setSearchOpen(true)}>
          <Search aria-hidden="true" size={17} />
        </button>}
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
        <div className="viewToggle" role="group" aria-label={t('toolbar.viewMode')}>
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
        {admin ? (
          <>
            {canUpload ? <>
              <input ref={uploadInput} className="srOnly" type="file" multiple tabIndex={-1} onChange={(event) => {
                onUpload(Array.from(event.target.files ?? []));
                event.target.value = '';
              }} />
              <button className="iconButton" type="button" title={t('toolbar.upload')} aria-label={t('toolbar.upload')} onClick={() => uploadInput.current?.click()}>
                <Upload aria-hidden="true" size={17} />
              </button>
            </> : null}
            {canCreateFolder ? <button className="iconButton" type="button" title={t('toolbar.createFolder')} aria-label={t('toolbar.createFolder')} onClick={onCreateFolder}>
              <Plus aria-hidden="true" size={17} />
            </button> : null}
            {selectionCount > 0 ? <span className="selectionCount">{t('selection.count', { count: selectionCount })}</span> : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
