import { ArrowDownAZ, Grid2X2, List, LogIn, Plus, Search, Upload } from 'lucide-react';
import { useRef, type ChangeEvent } from 'react';
import type { SessionStatus } from '../../hooks/useSession';

export type ExplorerView = 'list' | 'grid';
export type ExplorerSortField = 'name' | 'size' | 'updated';
export type ExplorerSort = { field: ExplorerSortField; order: 'asc' | 'desc' };

interface ExplorerToolbarProps {
  query: string;
  sort: ExplorerSort;
  view: ExplorerView;
  sessionStatus: SessionStatus;
  selectionCount: number;
  onQuery: (query: string) => void;
  onSort: (sort: ExplorerSort) => void;
  onView: (view: ExplorerView) => void;
  onLogin: () => void;
  onUpload: (files: File[]) => void;
  onCreateFolder: () => void;
}

export function ExplorerToolbar({
  query,
  sort,
  view,
  sessionStatus,
  selectionCount,
  onQuery,
  onSort,
  onView,
  onLogin,
  onUpload,
  onCreateFolder,
}: ExplorerToolbarProps) {
  const admin = sessionStatus === 'admin';
  const uploadInput = useRef<HTMLInputElement>(null);

  function updateSort(event: ChangeEvent<HTMLSelectElement>) {
    onSort({ ...sort, field: event.target.value as ExplorerSortField });
  }

  return (
    <section className="explorerToolbar" aria-label="File controls">
      <label className="searchControl">
        <Search aria-hidden="true" size={17} />
        <span className="srOnly">Search this folder</span>
        <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search this folder" />
      </label>
      <div className="toolbarActions">
        <label className="sortControl">
          <span className="srOnly">Sort files</span>
          <select value={sort.field} onChange={updateSort} aria-label="Sort files">
            <option value="name">Name</option>
            <option value="updated">Modified</option>
            <option value="size">Size</option>
          </select>
        </label>
        <button
          className="iconButton"
          type="button"
          title={sort.order === 'asc' ? 'Ascending' : 'Descending'}
          aria-label={sort.order === 'asc' ? 'Sort ascending' : 'Sort descending'}
          onClick={() => onSort({ ...sort, order: sort.order === 'asc' ? 'desc' : 'asc' })}
        >
          <ArrowDownAZ aria-hidden="true" size={17} className={sort.order === 'desc' ? 'sortDescending' : undefined} />
        </button>
        <div className="viewToggle" role="group" aria-label="View mode">
          <button
            className={view === 'list' ? 'active' : undefined}
            type="button"
            title="List view"
            aria-label="List view"
            aria-pressed={view === 'list'}
            onClick={() => onView('list')}
          >
            <List aria-hidden="true" size={17} />
          </button>
          <button
            className={view === 'grid' ? 'active' : undefined}
            type="button"
            title="Grid view"
            aria-label="Grid view"
            aria-pressed={view === 'grid'}
            onClick={() => onView('grid')}
          >
            <Grid2X2 aria-hidden="true" size={17} />
          </button>
        </div>
        {admin ? (
          <>
            <input ref={uploadInput} className="srOnly" type="file" multiple tabIndex={-1} onChange={(event) => {
              onUpload(Array.from(event.target.files ?? []));
              event.target.value = '';
            }} />
            <button className="iconButton" type="button" title="Upload files" aria-label="Upload files" onClick={() => uploadInput.current?.click()}>
              <Upload aria-hidden="true" size={17} />
            </button>
            <button className="iconButton" type="button" title="Create folder" aria-label="Create folder" onClick={onCreateFolder}>
              <Plus aria-hidden="true" size={17} />
            </button>
            {selectionCount > 0 ? <span className="selectionCount">{selectionCount} selected</span> : null}
          </>
        ) : (
          <button className="iconButton" type="button" title="Admin sign in" aria-label="Admin sign in" onClick={onLogin}>
            <LogIn aria-hidden="true" size={17} />
          </button>
        )}
      </div>
    </section>
  );
}
