import {
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  Grid2X2,
  Globe2,
  Home,
  Info,
  Link2,
  List,
  Loader2,
  LogOut,
  MoreHorizontal,
  RefreshCw,
  Save,
  Search,
  Shield,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteObject,
  fileUrl,
  getAdminTree,
  getPublicTree,
  login,
  logout,
  me,
  patchObject,
  uploadObject,
} from './api';
import type { AdminUser, DirectoryEntry, FileEntry, TreeResponse } from './types';

type ToastKind = 'success' | 'error' | 'info';
type ViewMode = 'public' | 'admin';
type BrowserView = 'list' | 'grid';
type SortField = 'name' | 'size' | 'updated' | 'visibility';
type SortOrder = 'asc' | 'desc';
type MenuAction = 'download' | 'copy' | 'toggle-public' | 'delete';

interface Toast {
  kind: ToastKind;
  text: string;
}

interface UploadTask {
  id: string;
  name: string;
  key: string;
  status: 'queued' | 'uploading' | 'done' | 'error';
  error?: string;
}

interface ContextMenuState {
  file: FileEntry;
  x: number;
  y: number;
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function parentPrefix(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index < 0 ? '' : `${trimmed.slice(0, index)}/`;
}

function normalizeUploadPrefix(value: string): string {
  const trimmed = value.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed ? `${trimmed}/` : '';
}

function joinPrefix(prefix: string, name: string): string {
  return `${normalizeUploadPrefix(prefix)}${name}`.replace(/^\/+/, '');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units.shift()!;
  while (value >= 1024 && units.length) {
    value /= 1024;
    unit = units.shift()!;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function fileExtension(name: string): string {
  const match = /\.([^.]+)$/.exec(name);
  return match ? match[1].toUpperCase() : 'FILE';
}

function fileKind(file: FileEntry): { label: string; className: string; icon: React.ReactNode } {
  const type = file.contentType || '';
  const extension = fileExtension(file.name).toLowerCase();
  if (type.startsWith('image/')) return { label: 'Image', className: 'image', icon: <FileImage size={19} /> };
  if (type.startsWith('video/')) return { label: 'Video', className: 'video', icon: <FileVideo size={19} /> };
  if (type.startsWith('audio/')) return { label: 'Audio', className: 'audio', icon: <FileAudio size={19} /> };
  if (type.includes('pdf') || type.includes('text') || ['md', 'txt', 'pdf', 'doc', 'docx'].includes(extension)) {
    return { label: extension === 'pdf' ? 'PDF' : 'Document', className: 'document', icon: <FileText size={19} /> };
  }
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) {
    return { label: 'Archive', className: 'archive', icon: <FileArchive size={19} /> };
  }
  return { label: fileExtension(file.name), className: 'generic', icon: <File size={19} /> };
}

function totalSize(files: FileEntry[]): number {
  return files.reduce((sum, file) => sum + file.size, 0);
}

function filterTree(tree: TreeResponse, query: string): TreeResponse {
  const needle = query.trim().toLowerCase();
  if (!needle) return tree;
  return {
    ...tree,
    directories: tree.directories.filter((entry) => entry.name.toLowerCase().includes(needle)),
    files: tree.files.filter(
      (entry) =>
        entry.name.toLowerCase().includes(needle) ||
        entry.key.toLowerCase().includes(needle) ||
        entry.description.toLowerCase().includes(needle),
    ),
  };
}

function sortTree(tree: TreeResponse, sortField: SortField, sortOrder: SortOrder): TreeResponse {
  const direction = sortOrder === 'asc' ? 1 : -1;
  const directories = [...tree.directories].sort((a, b) => a.name.localeCompare(b.name) * direction);
  const files = [...tree.files].sort((a, b) => {
    let result = 0;
    if (sortField === 'size') result = a.size - b.size;
    if (sortField === 'updated') result = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
    if (sortField === 'visibility') result = Number(a.isPublic) - Number(b.isPublic);
    if (sortField === 'name' || result === 0) result = a.name.localeCompare(b.name);
    return result * direction;
  });
  return { ...tree, directories, files };
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function Breadcrumbs({ prefix, onOpen }: { prefix: string; onOpen: (prefix: string) => void }) {
  const parts = prefix.split('/').filter(Boolean);
  let cursor = '';
  return (
    <nav className="breadcrumbs" aria-label="Path">
      <button type="button" onClick={() => onOpen('')} title="Root">
        <Home size={15} />
        ilist
      </button>
      {parts.map((part) => {
        cursor += `${part}/`;
        return (
          <button type="button" key={cursor} onClick={() => onOpen(cursor)} title={cursor}>
            <ChevronRight size={14} />
            {part}
          </button>
        );
      })}
    </nav>
  );
}

function PathInspector({ prefix, tree, mode }: { prefix: string; tree: TreeResponse; mode: ViewMode }) {
  const visibleFiles = mode === 'admin' ? tree.files.length : tree.files.filter((file) => file.isPublic).length;
  return (
    <section className="pathInspector" aria-label="Current folder">
      <div>
        <span>Current path</span>
        <strong title={prefix || '/'}>{prefix || '/'}</strong>
      </div>
      <div>
        <span>Folders</span>
        <strong>{tree.directories.length}</strong>
      </div>
      <div>
        <span>Files</span>
        <strong>{visibleFiles}</strong>
      </div>
    </section>
  );
}

function ToastBar({ toast, onClose }: { toast: Toast | null; onClose: () => void }) {
  if (!toast) return null;
  return (
    <div className={`toast ${toast.kind}`} role="status">
      <span>{toast.text}</span>
      <button type="button" onClick={onClose} title="Dismiss">
        <X size={16} />
      </button>
    </div>
  );
}

function StatusPill({ file }: { file: FileEntry }) {
  return (
    <span className={`statusPill ${file.isPublic ? 'public' : 'hidden'}`}>
      {file.isPublic ? <Eye size={13} /> : <EyeOff size={13} />}
      {file.isPublic ? 'Public' : 'Hidden'}
    </span>
  );
}

function SummaryStrip({ tree, mode }: { tree: TreeResponse; mode: ViewMode }) {
  const hiddenCount = tree.files.filter((file) => !file.isPublic).length;
  return (
    <section className="summaryStrip" aria-label="Folder summary">
      <div>
        <strong>{tree.directories.length}</strong>
        <span>folders</span>
      </div>
      <div>
        <strong>{tree.files.length}</strong>
        <span>files</span>
      </div>
      <div>
        <strong>{formatSize(totalSize(tree.files))}</strong>
        <span>listed size</span>
      </div>
      {mode === 'admin' ? (
        <div>
          <strong>{hiddenCount}</strong>
          <span>hidden</span>
        </div>
      ) : null}
    </section>
  );
}

function EmptyState({ mode, query }: { mode: ViewMode; query: string }) {
  const text = query
    ? 'No matching items'
    : mode === 'admin'
      ? 'This folder is empty'
      : 'No public files in this folder';
  const hint = query
    ? 'Clear the search field to see the full folder.'
    : mode === 'admin'
      ? 'Upload files or open another folder.'
      : 'Public files will appear here after they are uploaded and made visible.';
  return (
    <div className="empty">
      <Folder size={36} />
      <strong>{text}</strong>
      <span>{hint}</span>
    </div>
  );
}

function FileList({
  tree,
  mode,
  viewMode,
  selectedKey,
  selectedKeys,
  onOpen,
  onSelect,
  onToggleSelect,
  onDownload,
  onContext,
}: {
  tree: TreeResponse;
  mode: ViewMode;
  viewMode: BrowserView;
  selectedKey?: string;
  selectedKeys: Set<string>;
  onOpen: (prefix: string) => void;
  onSelect: (file: FileEntry) => void;
  onToggleSelect: (file: FileEntry) => void;
  onDownload: (file: FileEntry) => void;
  onContext: (file: FileEntry, event: React.MouseEvent) => void;
}) {
  return (
    <div className={`fileList ${viewMode}`} role="list">
      {tree.directories.map((directory) => (
        <button className="row directoryRow" type="button" key={directory.key} onClick={() => onOpen(directory.key)}>
          <span className="rowIcon folderIcon">
            <Folder size={20} />
          </span>
          <span className="rowMain">
            <strong>{directory.name}</strong>
            <small>{directory.key}</small>
          </span>
          <span className="rowMeta">Folder</span>
          <ChevronRight size={18} />
        </button>
      ))}
      {tree.files.map((file) => {
        const kind = fileKind(file);
        return (
          <button
            className={`row fileRow ${selectedKey === file.key ? 'selected' : ''}`}
            type="button"
            key={file.key}
            onClick={() => onSelect(file)}
            onContextMenu={(event) => onContext(file, event)}
          >
            <span className="selectBox" onClick={(event) => event.stopPropagation()}>
              <input
                type="checkbox"
                checked={selectedKeys.has(file.key)}
                onChange={() => onToggleSelect(file)}
                aria-label={`Select ${file.name}`}
              />
            </span>
            <span className={`rowIcon fileIcon ${kind.className}`}>{kind.icon}</span>
            <span className="rowMain">
              <strong>{file.name}</strong>
              <small>{file.description || file.key}</small>
            </span>
            <span className="kindBadge">{kind.label}</span>
            <span className="rowMeta">
              <span>{formatSize(file.size)}</span>
              <span>{formatDate(file.updatedAt)}</span>
            </span>
            {mode === 'admin' ? <StatusPill file={file} /> : null}
            <span className="rowActions" onClick={(event) => event.stopPropagation()}>
              <button className="iconButton" type="button" onClick={() => onDownload(file)} title="Download">
                <Download size={17} />
              </button>
              <button className="iconButton" type="button" onClick={(event) => onContext(file, event)} title="More actions">
                <MoreHorizontal size={17} />
              </button>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ContextMenu({
  state,
  mode,
  onAction,
  onClose,
}: {
  state: ContextMenuState | null;
  mode: ViewMode;
  onAction: (action: MenuAction, file: FileEntry) => void;
  onClose: () => void;
}) {
  if (!state) return null;
  const actions: Array<{ action: MenuAction; label: string; icon: React.ReactNode; danger?: boolean }> = [
    { action: 'download', label: 'Download', icon: <Download size={16} /> },
    { action: 'copy', label: 'Copy link', icon: <Copy size={16} /> },
  ];
  if (mode === 'admin') {
    actions.push({
      action: 'toggle-public',
      label: state.file.isPublic ? 'Hide from public' : 'Publish',
      icon: state.file.isPublic ? <EyeOff size={16} /> : <Eye size={16} />,
    });
    actions.push({ action: 'delete', label: 'Delete', icon: <Trash2 size={16} />, danger: true });
  }

  return (
    <div className="menuScrim" onClick={onClose} onContextMenu={(event) => event.preventDefault()}>
      <div className="contextMenu" style={{ left: state.x, top: state.y }} role="menu" aria-label={`Actions for ${state.file.name}`}>
        <div className="contextMenuTitle">
          <strong title={state.file.name}>{state.file.name}</strong>
          <span>{formatSize(state.file.size)}</span>
        </div>
        {actions.map((item) => (
          <button
            className={item.danger ? 'danger' : ''}
            type="button"
            key={item.action}
            onClick={() => onAction(item.action, state.file)}
            role="menuitem"
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function FileDetails({
  file,
  mode,
  saving,
  onPatch,
  onDelete,
  onDownload,
}: {
  file: FileEntry | null;
  mode: ViewMode;
  saving?: boolean;
  onPatch?: (file: FileEntry, patch: { name?: string; description?: string; isPublic?: boolean; sortOrder?: number }) => void;
  onDelete?: (file: FileEntry) => void;
  onDownload: (file: FileEntry) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sortOrder, setSortOrder] = useState(0);

  useEffect(() => {
    setName(file?.name || '');
    setDescription(file?.description || '');
    setSortOrder(file?.sortOrder || 0);
  }, [file]);

  if (!file) {
    return (
      <aside className="detailsPane">
        <div className="detailsEmpty">
          <Info size={26} />
          <strong>Select a file</strong>
          <span>File actions and metadata appear here.</span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="detailsPane">
      <div className="detailsHeader">
        <span className="largeFileIcon">
          <File size={28} />
        </span>
        <div>
          <strong>{file.name}</strong>
          <span>{fileExtension(file.name)}</span>
        </div>
      </div>

      <dl className="metaGrid">
        <div>
          <dt>Size</dt>
          <dd>{formatSize(file.size)}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatDate(file.updatedAt)}</dd>
        </div>
        <div>
          <dt>Key</dt>
          <dd title={file.key}>{file.key}</dd>
        </div>
        {mode === 'admin' ? (
          <div>
            <dt>Status</dt>
            <dd>
              <StatusPill file={file} />
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="detailsActions">
        <button className="button primary" type="button" onClick={() => onDownload(file)}>
          <Download size={17} />
          Download
        </button>
        {mode === 'admin' ? (
          <button className="button secondary" type="button" onClick={() => onPatch?.(file, { isPublic: !file.isPublic })}>
            {file.isPublic ? <EyeOff size={17} /> : <Eye size={17} />}
            {file.isPublic ? 'Hide' : 'Publish'}
          </button>
        ) : null}
      </div>

      {mode === 'admin' ? (
        <form
          className="metadataForm"
          onSubmit={(event) => {
            event.preventDefault();
            onPatch?.(file, { name, description, sortOrder });
          }}
        >
          <label>
            Display name
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Description
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} />
          </label>
          <label>
            Sort order
            <input type="number" value={sortOrder} onChange={(event) => setSortOrder(Number(event.target.value))} />
          </label>
          <div className="detailsActions">
            <button className="button primary" type="submit" disabled={saving}>
              {saving ? <Loader2 className="spin" size={17} /> : <Save size={17} />}
              Save
            </button>
            <button className="button danger" type="button" onClick={() => onDelete?.(file)}>
              <Trash2 size={17} />
              Delete
            </button>
          </div>
        </form>
      ) : null}
    </aside>
  );
}

function UploadPanel({
  currentPrefix,
  tasks,
  onUpload,
}: {
  currentPrefix: string;
  tasks: UploadTask[];
  onUpload: (prefix: string, files: FileList | null) => void;
}) {
  const [targetPrefix, setTargetPrefix] = useState(currentPrefix);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setTargetPrefix(currentPrefix);
  }, [currentPrefix]);

  return (
    <section
      className={`uploadPanel ${dragging ? 'dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        onUpload(targetPrefix, event.dataTransfer.files);
      }}
    >
      <div className="uploadTarget">
        <label>
          Upload path
          <input
            value={targetPrefix}
            onChange={(event) => setTargetPrefix(event.target.value)}
            placeholder="folder/subfolder/"
          />
        </label>
        <button className="button primary" type="button" onClick={() => inputRef.current?.click()}>
          <Upload size={17} />
          Upload files
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          onChange={(event) => {
            onUpload(targetPrefix, event.target.files);
            event.target.value = '';
          }}
        />
      </div>
      <div className="dropHint">
        <Archive size={17} />
        Drop files here to upload into this path.
      </div>
      {tasks.length ? (
        <div className="uploadQueue">
          {tasks.slice(0, 4).map((task) => (
            <div className={`uploadTask ${task.status}`} key={task.id}>
              {task.status === 'done' ? <Check size={15} /> : task.status === 'error' ? <X size={15} /> : <Loader2 className="spin" size={15} />}
              <span title={task.key}>{task.name}</span>
              <small>{task.error || task.status}</small>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function LoginPanel({ onLogin }: { onLogin: (user: AdminUser) => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      onLogin(await login(username, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="authShell">
      <form className="authPanel" onSubmit={submit}>
        <Shield size={30} />
        <h1>ilist admin</h1>
        <p>Sign in to upload files, manage visibility, and edit file metadata.</p>
        <label>
          Username
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
        </label>
        <label>
          Password
          <input
            value={password}
            type="password"
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error ? <div className="notice error">{error}</div> : null}
        <button className="button primary" type="submit" disabled={loading}>
          {loading ? <Loader2 className="spin" size={17} /> : <Shield size={17} />}
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

function Workspace({
  mode,
  tree,
  prefix,
  query,
  viewMode,
  sortField,
  sortOrder,
  selectedKeys,
  loading,
  selected,
  toast,
  saving,
  onQuery,
  onViewMode,
  onSortField,
  onSortOrder,
  onSelectAll,
  onClearSelection,
  onToggleSelect,
  onOpen,
  onBack,
  onReload,
  onSelect,
  onDownload,
  onPatch,
  onDelete,
  onBulkDelete,
  onBulkPatch,
  onBulkDownload,
  onCopyLinks,
  onToastClose,
  adminActions,
  utilityPanel,
}: {
  mode: ViewMode;
  tree: TreeResponse | null;
  prefix: string;
  query: string;
  viewMode: BrowserView;
  sortField: SortField;
  sortOrder: SortOrder;
  selectedKeys: Set<string>;
  loading: boolean;
  selected: FileEntry | null;
  toast: Toast | null;
  saving?: boolean;
  onQuery: (query: string) => void;
  onViewMode: (mode: BrowserView) => void;
  onSortField: (field: SortField) => void;
  onSortOrder: (order: SortOrder) => void;
  onSelectAll: (files: FileEntry[]) => void;
  onClearSelection: () => void;
  onToggleSelect: (file: FileEntry) => void;
  onOpen: (prefix: string) => void;
  onBack: () => void;
  onReload: () => void;
  onSelect: (file: FileEntry) => void;
  onDownload: (file: FileEntry) => void;
  onPatch?: (file: FileEntry, patch: { name?: string; description?: string; isPublic?: boolean; sortOrder?: number }) => void;
  onDelete?: (file: FileEntry) => void;
  onBulkDelete?: (files: FileEntry[]) => void;
  onBulkPatch?: (files: FileEntry[], patch: { isPublic: boolean }) => void;
  onBulkDownload: (files: FileEntry[]) => void;
  onCopyLinks: (files: FileEntry[]) => void;
  onToastClose: () => void;
  adminActions?: React.ReactNode;
  utilityPanel?: React.ReactNode;
}) {
  const visibleTree = tree ? sortTree(filterTree(tree, query), sortField, sortOrder) : null;
  const selectedFiles = visibleTree?.files.filter((file) => selectedKeys.has(file.key)) || [];
  const allVisibleSelected = Boolean(visibleTree?.files.length) && selectedFiles.length === visibleTree?.files.length;
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    setContextMenu(null);
  }, [prefix, query, viewMode]);

  function openContextMenu(file: FileEntry, event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    const width = 224;
    const height = mode === 'admin' ? 216 : 152;
    setContextMenu({
      file,
      x: Math.min(event.clientX, window.innerWidth - width - 12),
      y: Math.min(event.clientY, window.innerHeight - height - 12),
    });
  }

  return (
    <main className="appShell">
      <ToastBar toast={toast} onClose={onToastClose} />
      <ContextMenu
        state={contextMenu}
        mode={mode}
        onClose={() => setContextMenu(null)}
        onAction={(action, file) => {
          setContextMenu(null);
          if (action === 'download') onDownload(file);
          if (action === 'copy') onCopyLinks([file]);
          if (action === 'toggle-public') onPatch?.(file, { isPublic: !file.isPublic });
          if (action === 'delete') onDelete?.(file);
        }}
      />
      <header className="topBar">
        <div>
          <Breadcrumbs prefix={prefix} onOpen={onOpen} />
          <h1>{mode === 'admin' ? 'Manage files' : 'Shared files'}</h1>
        </div>
        <div className="topActions">
          {prefix ? (
            <button className="button secondary" type="button" onClick={onBack}>
              <ArrowLeft size={17} />
              Back
            </button>
          ) : null}
          <button className="button secondary" type="button" onClick={onReload}>
            <RefreshCw size={17} />
            Refresh
          </button>
          {adminActions || (
            <a className="button secondary" href="/admin">
              <Shield size={17} />
              Admin
            </a>
          )}
        </div>
      </header>

      {tree ? <SummaryStrip tree={tree} mode={mode} /> : null}

      <section className="contentGrid">
        <section className="browserPane">
          {utilityPanel}
          {tree ? <PathInspector prefix={prefix} tree={tree} mode={mode} /> : null}
          <div className="listTools">
            <label className="searchBox">
              <Search size={17} />
              <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search this folder" />
            </label>
            <div className="toolCluster">
              <label className="selectControl">
                Sort
                <select value={sortField} onChange={(event) => onSortField(event.target.value as SortField)}>
                  <option value="name">Name</option>
                  <option value="size">Size</option>
                  <option value="updated">Updated</option>
                  {mode === 'admin' ? <option value="visibility">Visibility</option> : null}
                </select>
              </label>
              <button
                className="iconButton"
                type="button"
                onClick={() => onSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
                title={sortOrder === 'asc' ? 'Ascending' : 'Descending'}
              >
                {sortOrder === 'asc' ? 'A' : 'Z'}
              </button>
              <span className="segmented" role="group" aria-label="View mode">
                <button className={viewMode === 'list' ? 'active' : ''} type="button" onClick={() => onViewMode('list')} title="List">
                  <List size={16} />
                </button>
                <button className={viewMode === 'grid' ? 'active' : ''} type="button" onClick={() => onViewMode('grid')} title="Grid">
                  <Grid2X2 size={16} />
                </button>
              </span>
              <span className="scopeLabel">
                <Globe2 size={15} />
                {mode === 'admin' ? 'All indexed files' : 'Public files only'}
              </span>
            </div>
          </div>

          {visibleTree && visibleTree.files.length ? (
            <div className="selectionBar">
              <label className="selectAll">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={() => (allVisibleSelected ? onClearSelection() : onSelectAll(visibleTree.files))}
                />
                {selectedFiles.length ? `${selectedFiles.length} selected` : 'Select files'}
              </label>
              <div className="selectionActions">
                <button className="button secondary" type="button" disabled={!selectedFiles.length} onClick={() => onBulkDownload(selectedFiles)}>
                  <Download size={16} />
                  Download
                </button>
                <button className="button secondary" type="button" disabled={!selectedFiles.length} onClick={() => onCopyLinks(selectedFiles)}>
                  <Link2 size={16} />
                  Copy links
                </button>
                {mode === 'admin' ? (
                  <>
                    <button className="button secondary" type="button" disabled={!selectedFiles.length} onClick={() => onBulkPatch?.(selectedFiles, { isPublic: true })}>
                      <Eye size={16} />
                      Publish
                    </button>
                    <button className="button secondary" type="button" disabled={!selectedFiles.length} onClick={() => onBulkPatch?.(selectedFiles, { isPublic: false })}>
                      <EyeOff size={16} />
                      Hide
                    </button>
                    <button className="button danger" type="button" disabled={!selectedFiles.length} onClick={() => onBulkDelete?.(selectedFiles)}>
                      <Trash2 size={16} />
                      Delete
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}

          {loading || !visibleTree ? (
            <div className="loadingBlock">
              <Loader2 className="spin" size={22} />
              Loading files...
            </div>
          ) : visibleTree.directories.length || visibleTree.files.length ? (
            <FileList
              tree={visibleTree}
              mode={mode}
              viewMode={viewMode}
              selectedKey={selected?.key}
              selectedKeys={selectedKeys}
              onOpen={onOpen}
              onSelect={onSelect}
              onToggleSelect={onToggleSelect}
              onDownload={onDownload}
              onContext={openContextMenu}
            />
          ) : (
            <EmptyState mode={mode} query={query} />
          )}
        </section>

        <FileDetails
          file={selected}
          mode={mode}
          saving={saving}
          onPatch={onPatch}
          onDelete={onDelete}
          onDownload={onDownload}
        />
      </section>
    </main>
  );
}

function PublicView() {
  const [prefix, setPrefix] = useState('');
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useState<BrowserView>('list');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [toast, setToast] = useState<Toast | null>(null);
  const [loading, setLoading] = useState(true);

  async function load(nextPrefix = prefix) {
    setLoading(true);
    setToast(null);
    try {
      const nextTree = await getPublicTree(nextPrefix);
      setTree(nextTree);
      setPrefix(nextPrefix);
      setSelected(null);
      setSelectedKeys(new Set());
      setQuery('');
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to load files' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load('');
  }, []);

  return (
    <Workspace
      mode="public"
      tree={tree}
      prefix={prefix}
      query={query}
      viewMode={viewMode}
      sortField={sortField}
      sortOrder={sortOrder}
      selectedKeys={selectedKeys}
      loading={loading}
      selected={selected}
      toast={toast}
      onQuery={setQuery}
      onViewMode={setViewMode}
      onSortField={setSortField}
      onSortOrder={setSortOrder}
      onSelectAll={(files) => setSelectedKeys(new Set(files.map((file) => file.key)))}
      onClearSelection={() => setSelectedKeys(new Set())}
      onToggleSelect={(file) =>
        setSelectedKeys((current) => {
          const next = new Set(current);
          if (next.has(file.key)) next.delete(file.key);
          else next.add(file.key);
          return next;
        })
      }
      onOpen={(nextPrefix) => void load(nextPrefix)}
      onBack={() => void load(parentPrefix(prefix))}
      onReload={() => void load(prefix)}
      onSelect={setSelected}
      onDownload={(file) => window.open(fileUrl(file.key), '_blank', 'noopener,noreferrer')}
      onBulkDownload={(files) => files.forEach((file) => window.open(fileUrl(file.key), '_blank', 'noopener,noreferrer'))}
      onCopyLinks={async (files) => {
        const links = files.map((file) => `${window.location.origin}${fileUrl(file.key)}`).join('\n');
        setToast({ kind: (await copyText(links)) ? 'success' : 'error', text: links ? 'Links copied.' : 'No files selected.' });
      }}
      onToastClose={() => setToast(null)}
    />
  );
}

function AdminView() {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [prefix, setPrefix] = useState('');
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useState<BrowserView>('list');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [toast, setToast] = useState<Toast | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);

  async function load(nextPrefix = prefix) {
    setLoading(true);
    try {
      const nextTree = await getAdminTree(nextPrefix);
      setTree(nextTree);
      setPrefix(nextPrefix);
      setSelected((current) => (current ? nextTree.files.find((file) => file.key === current.key) || null : null));
      setSelectedKeys(new Set());
      setQuery('');
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to load admin files' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    me()
      .then((activeUser) => {
        setUser(activeUser);
        return load('');
      })
      .catch(() => undefined)
      .finally(() => {
        setChecking(false);
        setLoading(false);
      });
  }, []);

  function updateFileInTree(file: FileEntry) {
    setTree((current) =>
      current
        ? {
            ...current,
            files: current.files.map((item) => (item.key === file.key ? file : item)),
          }
        : current,
    );
    setSelected(file);
  }

  async function handlePatch(
    file: FileEntry,
    patch: { name?: string; description?: string; isPublic?: boolean; sortOrder?: number },
  ) {
    setSaving(true);
    try {
      const updated = await patchObject(file.key, patch);
      updateFileInTree(updated);
      setToast({ kind: 'success', text: 'File updated.' });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Update failed' });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(file: FileEntry) {
    if (!confirm(`Delete ${file.name}? This removes it from R2 and the index.`)) return;
    try {
      await deleteObject(file.key);
      setSelected(null);
      setToast({ kind: 'success', text: 'File deleted.' });
      await load(prefix);
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Delete failed' });
    }
  }

  async function handleBulkPatch(files: FileEntry[], patch: { isPublic: boolean }) {
    if (!files.length) return;
    setSaving(true);
    try {
      for (const file of files) {
        await patchObject(file.key, patch);
      }
      setToast({ kind: 'success', text: `${files.length} file${files.length === 1 ? '' : 's'} updated.` });
      await load(prefix);
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Bulk update failed' });
    } finally {
      setSaving(false);
    }
  }

  async function handleBulkDelete(files: FileEntry[]) {
    if (!files.length) return;
    if (!confirm(`Delete ${files.length} selected file${files.length === 1 ? '' : 's'}? This removes them from R2 and the index.`)) return;
    setSaving(true);
    try {
      for (const file of files) {
        await deleteObject(file.key);
      }
      setSelected(null);
      setToast({ kind: 'success', text: `${files.length} file${files.length === 1 ? '' : 's'} deleted.` });
      await load(prefix);
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Bulk delete failed' });
    } finally {
      setSaving(false);
    }
  }

  async function handleUpload(targetPrefix: string, files: FileList | null) {
    if (!files?.length) return;
    const normalized = normalizeUploadPrefix(targetPrefix || prefix);
    const tasks = [...files].map((file) => ({
      id: `${file.name}-${file.lastModified}-${Math.random()}`,
      name: file.name,
      key: joinPrefix(normalized, file.name),
      status: 'queued' as const,
    }));
    setUploadTasks((current) => [...tasks, ...current].slice(0, 8));
    setToast({ kind: 'info', text: `Uploading ${tasks.length} file${tasks.length === 1 ? '' : 's'}...` });

    for (const task of tasks) {
      setUploadTasks((current) => current.map((item) => (item.id === task.id ? { ...item, status: 'uploading' } : item)));
      try {
        const source = [...files].find((file) => joinPrefix(normalized, file.name) === task.key);
        if (!source) throw new Error('Missing file from upload queue');
        await uploadObject(task.key, source);
        setUploadTasks((current) => current.map((item) => (item.id === task.id ? { ...item, status: 'done' } : item)));
      } catch (err) {
        setUploadTasks((current) =>
          current.map((item) =>
            item.id === task.id
              ? { ...item, status: 'error', error: err instanceof Error ? err.message : 'Upload failed' }
              : item,
          ),
        );
      }
    }

    setToast({ kind: 'success', text: 'Upload queue finished.' });
    await load(prefix);
  }

  async function signOut() {
    await logout();
    setUser(null);
  }

  if (checking) {
    return (
      <main className="appShell">
        <div className="loadingBlock">
          <Loader2 className="spin" size={22} />
          Checking session...
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <LoginPanel
        onLogin={(activeUser) => {
          setUser(activeUser);
          void load('');
        }}
      />
    );
  }

  return (
    <Workspace
      mode="admin"
      tree={tree}
      prefix={prefix}
      query={query}
      viewMode={viewMode}
      sortField={sortField}
      sortOrder={sortOrder}
      selectedKeys={selectedKeys}
      loading={loading}
      selected={selected}
      toast={toast}
      saving={saving}
      onQuery={setQuery}
      onViewMode={setViewMode}
      onSortField={setSortField}
      onSortOrder={setSortOrder}
      onSelectAll={(files) => setSelectedKeys(new Set(files.map((file) => file.key)))}
      onClearSelection={() => setSelectedKeys(new Set())}
      onToggleSelect={(file) =>
        setSelectedKeys((current) => {
          const next = new Set(current);
          if (next.has(file.key)) next.delete(file.key);
          else next.add(file.key);
          return next;
        })
      }
      onOpen={(nextPrefix) => void load(nextPrefix)}
      onBack={() => void load(parentPrefix(prefix))}
      onReload={() => void load(prefix)}
      onSelect={setSelected}
      onDownload={(file) => window.open(fileUrl(file.key), '_blank', 'noopener,noreferrer')}
      onBulkDownload={(files) => files.forEach((file) => window.open(fileUrl(file.key), '_blank', 'noopener,noreferrer'))}
      onCopyLinks={async (files) => {
        const links = files.map((file) => `${window.location.origin}${fileUrl(file.key)}`).join('\n');
        setToast({ kind: (await copyText(links)) ? 'success' : 'error', text: links ? 'Links copied.' : 'No files selected.' });
      }}
      onPatch={(file, patch) => void handlePatch(file, patch)}
      onDelete={(file) => void handleDelete(file)}
      onBulkPatch={(files, patch) => void handleBulkPatch(files, patch)}
      onBulkDelete={(files) => void handleBulkDelete(files)}
      onToastClose={() => setToast(null)}
      adminActions={
        <>
          <a className="button secondary" href="/">
            <Globe2 size={17} />
            Public site
          </a>
          <button className="button secondary" type="button" onClick={() => void signOut()}>
            <LogOut size={17} />
            Logout
          </button>
        </>
      }
      utilityPanel={
        <UploadPanel currentPrefix={prefix} tasks={uploadTasks} onUpload={(target, files) => void handleUpload(target, files)} />
      }
    />
  );
}

export function App() {
  return window.location.pathname.startsWith('/admin') ? <AdminView /> : <PublicView />;
}
