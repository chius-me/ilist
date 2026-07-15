import { useCallback, useEffect, useReducer, useRef } from 'react';
import { uploadFileWithProgress } from '../../api/uploads';
import { useI18n } from '../../i18n/I18nProvider';
import { uploadReducer, type UploadTask } from './upload-reducer';

const RESERVED_ROOT_NAMES = new Set(['api', 'file', 'admin']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_CONCURRENT_UPLOADS = 2;

type Transport = (input: {
  id: string;
  parentId: string;
  file: File;
  signal: AbortSignal;
  onProgress(uploadedBytes: number, totalBytes: number): void;
}) => Promise<void>;

interface UploadQueueOptions {
  transport?: Transport;
  onCompleted(parentId: string): void;
  canUpload?: boolean;
  existingNames?: Iterable<string>;
}

function validationError(name: string, parentId: string, occupiedNames: Set<string>, canUpload: boolean, t: ReturnType<typeof useI18n>['t']): string | undefined {
  if (!canUpload) return t('upload.permissionDenied');
  const byteLength = new TextEncoder().encode(name).byteLength;
  if (!name.trim() || name === '.' || name === '..' || name.includes('/') || CONTROL_CHARACTERS.test(name) || byteLength > 255 || (parentId === 'root' && RESERVED_ROOT_NAMES.has(name))) {
    return t('upload.invalidName');
  }
  if (occupiedNames.has(name)) return t('upload.duplicateName');
  return undefined;
}

export function useUploadQueue({ transport = uploadFileWithProgress, onCompleted, canUpload = true, existingNames = [] }: UploadQueueOptions) {
  const { t } = useI18n();
  const [tasks, dispatch] = useReducer(uploadReducer, []);
  const controllers = useRef(new Map<string, AbortController>());
  const transportRef = useRef(transport);
  const completedRef = useRef(onCompleted);
  transportRef.current = transport;
  completedRef.current = onCompleted;

  useEffect(() => () => {
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
  }, []);

  useEffect(() => {
    const running = tasks.filter((task) => task.status === 'uploading').length;
    const available = Math.max(0, MAX_CONCURRENT_UPLOADS - running);
    if (!available) return;
    tasks.filter((task) => task.status === 'queued').slice(0, available).forEach((task) => {
      if (controllers.current.has(task.id)) return;
      const controller = new AbortController();
      controllers.current.set(task.id, controller);
      dispatch({ type: 'started', id: task.id });
      void transportRef.current({
        id: task.id,
        parentId: task.parentId,
        file: task.file,
        signal: controller.signal,
        onProgress: (uploadedBytes, totalBytes) => dispatch({ type: 'progress', id: task.id, uploadedBytes, totalBytes }),
      }).then(() => {
        if (!controller.signal.aborted) {
          dispatch({ type: 'completed', id: task.id });
          completedRef.current(task.parentId);
        }
      }).catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) dispatch({ type: 'cancelled', id: task.id });
        else dispatch({ type: 'failed', id: task.id, error: t('upload.failedMessage') });
      }).finally(() => {
        controllers.current.delete(task.id);
      });
    });
  }, [t, tasks]);

  const enqueue = useCallback((parentId: string, files: File[]) => {
    const occupiedNames = new Set(existingNames);
    tasks.filter((task) => task.parentId === parentId && task.status !== 'cancelled').forEach((task) => occupiedNames.add(task.file.name));
    const additions: UploadTask[] = files.map((file) => {
      const error = validationError(file.name, parentId, occupiedNames, canUpload, t);
      if (!error) occupiedNames.add(file.name);
      return {
        id: crypto.randomUUID(), parentId, file,
        status: error ? 'failed' : 'queued', uploadedBytes: 0, progress: 0, ...(error ? { error } : {}),
      };
    });
    if (additions.length) dispatch({ type: 'enqueue', tasks: additions });
  }, [canUpload, existingNames, t, tasks]);

  const cancel = useCallback((id: string) => {
    const controller = controllers.current.get(id);
    if (controller) controller.abort();
    else dispatch({ type: 'cancelled', id });
  }, []);

  const retry = useCallback((id: string) => dispatch({ type: 'retry', id }), []);
  const remove = useCallback((id: string) => dispatch({ type: 'remove', id }), []);
  const clearCompleted = useCallback(() => dispatch({ type: 'clearCompleted' }), []);

  return { tasks, enqueue, cancel, retry, remove, clearCompleted };
}
