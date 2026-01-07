import { RotateCcw, Trash2, X } from 'lucide-react';
import { useFeedbackI18n } from '../../components/ToastRegion';
import type { UploadTask } from './upload-reducer';

export function UploadTaskRow({ task, onCancel, onRetry, onRemove }: { task: UploadTask; onCancel(id: string): void; onRetry(id: string): void; onRemove(id: string): void }) {
  const { formatBytes, t } = useFeedbackI18n();
  const active = task.status === 'queued' || task.status === 'uploading';
  const status = task.status === 'uploading'
    ? t('upload.uploading', { progress: task.progress })
    : task.status === 'queued'
      ? t('upload.queued')
      : task.status === 'completed'
        ? t('upload.completed')
        : task.status === 'failed'
          ? t('upload.failed')
          : t('upload.cancelled');
  return (
    <li className={`uploadTask uploadTask-${task.status}`}>
      <div className="uploadTaskDetails">
        <strong title={task.file.name}>{task.file.name}</strong>
        <span>{task.error || t('upload.progress', { uploaded: formatBytes(task.uploadedBytes), total: formatBytes(task.file.size), status })}</span>
        {active ? <div className="uploadProgress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={task.progress} aria-label={t('upload.progressLabel', { name: task.file.name, progress: task.progress })}><span style={{ width: `${task.progress}%` }} /></div> : null}
      </div>
      {active ? <button className="iconButton" type="button" title={t('upload.cancel', { name: task.file.name })} aria-label={t('upload.cancel', { name: task.file.name })} onClick={() => onCancel(task.id)}><X aria-hidden="true" size={16} /></button> : null}
      {task.status === 'failed' ? <button className="iconButton" type="button" title={t('upload.retry', { name: task.file.name })} aria-label={t('upload.retry', { name: task.file.name })} onClick={() => onRetry(task.id)}><RotateCcw aria-hidden="true" size={16} /></button> : null}
      {task.status === 'failed' || task.status === 'completed' || task.status === 'cancelled' ? <button className="iconButton" type="button" title={t('upload.remove', { name: task.file.name })} aria-label={t('upload.remove', { name: task.file.name })} onClick={() => onRemove(task.id)}><Trash2 aria-hidden="true" size={16} /></button> : null}
    </li>
  );
}
