import { Pause, Play, RotateCcw, Trash2, X } from 'lucide-react';
import { useFeedbackI18n } from '../../components/ToastRegion';
import type { UploadTask } from './upload-reducer';

interface Props {
  task: UploadTask;
  onPause(id: string): void;
  onResume(id: string): void;
  onCancel(id: string): void;
  onRetry(id: string): void;
  onRemove(id: string): void;
}

export function UploadTaskRow({ task, onPause, onResume, onCancel, onRetry, onRemove }: Props) {
  const { formatBytes, t } = useFeedbackI18n();
  const status = task.status === 'creating'
    ? t('upload.creating')
    : task.status === 'uploading'
      ? task.partNumber && task.partCount
        ? t('upload.currentPart', { current: task.partNumber, total: task.partCount, progress: task.progress })
        : t('upload.uploading', { progress: task.progress })
      : task.status === 'paused'
        ? t('upload.paused')
        : task.status === 'completing'
          ? t('upload.completing')
          : task.status === 'queued'
            ? t('upload.queued')
            : task.status === 'completed'
              ? t('upload.completed')
              : task.status === 'failed'
                ? t('upload.failed')
                : t('upload.cancelled');
  const showProgress = !['completed', 'cancelled'].includes(task.status);
  const canPause = ['creating', 'uploading'].includes(task.status);
  const canResume = task.status === 'paused';
  const canCancel = ['queued', 'creating', 'uploading', 'paused', 'completing'].includes(task.status) || (task.status === 'failed' && Boolean(task.sessionId));
  const canRemove = ['completed', 'cancelled'].includes(task.status) || (task.status === 'failed' && !task.sessionId);

  return (
    <li className={`uploadTask uploadTask-${task.status}`}>
      <div className="uploadTaskDetails">
        <strong title={task.file.name}>{task.file.name}</strong>
        <span>{task.error || t('upload.progress', { uploaded: formatBytes(task.uploadedBytes), total: formatBytes(task.file.size), status })}</span>
        {showProgress ? <div className="uploadProgress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={task.progress} aria-label={t('upload.progressLabel', { name: task.file.name, progress: task.progress })}><span style={{ width: `${task.progress}%` }} /></div> : null}
      </div>
      <div className="uploadTaskActions">
        {canPause || canResume ? <button className="iconButton uploadPauseResume" type="button" title={canPause ? t('upload.pause', { name: task.file.name }) : t('upload.resume', { name: task.file.name })} aria-label={canPause ? t('upload.pause', { name: task.file.name }) : t('upload.resume', { name: task.file.name })} onClick={() => canPause ? onPause(task.id) : onResume(task.id)}>{canPause ? <Pause aria-hidden="true" size={16} /> : <Play aria-hidden="true" size={16} />}</button> : null}
        {task.status === 'failed' ? <button className="iconButton" type="button" title={t('upload.retry', { name: task.file.name })} aria-label={t('upload.retry', { name: task.file.name })} onClick={() => onRetry(task.id)}><RotateCcw aria-hidden="true" size={16} /></button> : null}
        {canCancel ? <button className="iconButton" type="button" title={t('upload.cancel', { name: task.file.name })} aria-label={t('upload.cancel', { name: task.file.name })} onClick={() => onCancel(task.id)}><X aria-hidden="true" size={16} /></button> : null}
        {canRemove ? <button className="iconButton" type="button" title={t('upload.remove', { name: task.file.name })} aria-label={t('upload.remove', { name: task.file.name })} onClick={() => onRemove(task.id)}><Trash2 aria-hidden="true" size={16} /></button> : null}
      </div>
    </li>
  );
}
