import { RotateCcw, Trash2, X } from 'lucide-react';
import type { UploadTask } from './upload-reducer';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1);
  return `${(bytes / 1024 ** (index + 1)).toFixed(bytes / 1024 ** (index + 1) >= 10 ? 0 : 1)} ${units[index]}`;
}

export function UploadTaskRow({ task, onCancel, onRetry, onRemove }: { task: UploadTask; onCancel(id: string): void; onRetry(id: string): void; onRemove(id: string): void }) {
  const active = task.status === 'queued' || task.status === 'uploading';
  const status = task.status === 'uploading' ? `${task.progress}%` : task.status;
  return (
    <li className={`uploadTask uploadTask-${task.status}`}>
      <div className="uploadTaskDetails">
        <strong title={task.file.name}>{task.file.name}</strong>
        <span>{task.error || `${formatBytes(task.uploadedBytes)} of ${formatBytes(task.file.size)} - ${status}`}</span>
        {active ? <div className="uploadProgress" aria-label={`${task.file.name} ${task.progress}% uploaded`}><span style={{ width: `${task.progress}%` }} /></div> : null}
      </div>
      {active ? <button className="iconButton" type="button" title="Cancel upload" aria-label={`Cancel ${task.file.name}`} onClick={() => onCancel(task.id)}><X aria-hidden="true" size={16} /></button> : null}
      {task.status === 'failed' ? <button className="iconButton" type="button" title="Retry upload" aria-label={`Retry ${task.file.name}`} onClick={() => onRetry(task.id)}><RotateCcw aria-hidden="true" size={16} /></button> : null}
      {task.status === 'completed' || task.status === 'cancelled' ? <button className="iconButton" type="button" title="Remove upload" aria-label={`Remove ${task.file.name}`} onClick={() => onRemove(task.id)}><Trash2 aria-hidden="true" size={16} /></button> : null}
    </li>
  );
}
