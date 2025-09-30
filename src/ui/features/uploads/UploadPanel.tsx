import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { UploadTask } from './upload-reducer';
import { UploadTaskRow } from './UploadTaskRow';

export function UploadPanel({ tasks, onCancel, onRetry, onRemove, onClearCompleted }: {
  tasks: UploadTask[];
  onCancel(id: string): void;
  onRetry(id: string): void;
  onRemove(id: string): void;
  onClearCompleted(): void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  if (!tasks.length) return null;
  const activeCount = tasks.filter((task) => task.status === 'queued' || task.status === 'uploading').length;
  const completedCount = tasks.filter((task) => task.status === 'completed').length;
  return (
    <aside className="uploadPanel" aria-label="Upload queue">
      <div className="uploadPanelHeader">
        <button className="uploadPanelToggle" type="button" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>
          <span>Uploads{activeCount ? ` (${activeCount})` : ''}</span>
          {collapsed ? <ChevronUp aria-hidden="true" size={17} /> : <ChevronDown aria-hidden="true" size={17} />}
        </button>
        {completedCount ? <button className="iconButton" type="button" title="Clear completed uploads" aria-label="Clear completed uploads" onClick={onClearCompleted}><Trash2 aria-hidden="true" size={16} /></button> : null}
      </div>
      {!collapsed ? <ul className="uploadTasks" aria-live="polite">{tasks.map((task) => <UploadTaskRow key={task.id} task={task} onCancel={onCancel} onRetry={onRetry} onRemove={onRemove} />)}</ul> : null}
    </aside>
  );
}
