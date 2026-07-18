import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useFeedbackI18n } from '../../components/ToastRegion';
import type { UploadTask } from './upload-reducer';
import { UploadTaskRow } from './UploadTaskRow';

export function UploadPanel({ tasks, onPause, onResume, onCancel, onRetry, onRemove, onClearCompleted }: {
  tasks: UploadTask[];
  onPause(id: string): void;
  onResume(id: string): void;
  onCancel(id: string): void;
  onRetry(id: string): void;
  onRemove(id: string): void;
  onClearCompleted(): void;
}) {
  const { t } = useFeedbackI18n();
  const [collapsed, setCollapsed] = useState(false);
  if (!tasks.length) return null;
  const activeCount = tasks.filter((task) => ['queued', 'creating', 'uploading', 'paused', 'completing'].includes(task.status)).length;
  const completedCount = tasks.filter((task) => task.status === 'completed').length;
  return (
    <aside className="uploadPanel" aria-label={t('upload.queue')}>
      <div className="uploadPanelHeader">
        <button className="uploadPanelToggle" type="button" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>
          <span>{activeCount ? t('upload.activeCount', { count: activeCount }) : t('upload.title')}</span>
          {collapsed ? <ChevronUp aria-hidden="true" size={17} /> : <ChevronDown aria-hidden="true" size={17} />}
        </button>
        {completedCount ? <button className="iconButton" type="button" title={t('upload.clearCompleted')} aria-label={t('upload.clearCompleted')} onClick={onClearCompleted}><Trash2 aria-hidden="true" size={16} /></button> : null}
      </div>
      {!collapsed ? <ul className="uploadTasks" aria-live="polite">{tasks.map((task) => <UploadTaskRow key={task.id} task={task} onPause={onPause} onResume={onResume} onCancel={onCancel} onRetry={onRetry} onRemove={onRemove} />)}</ul> : null}
    </aside>
  );
}
