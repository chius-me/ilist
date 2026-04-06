import { useCallback, useEffect, useReducer, useRef, type Dispatch } from 'react';
import {
  LARGE_UPLOAD_THRESHOLD_BYTES,
  UploadPausedError,
  abortUploadSession,
  uploadFile,
  type ResumableUploadControl,
  type UploadTransport,
} from '../../api/uploads';
import { useI18n } from '../../i18n/I18nProvider';
import { localizedApiError } from '../../i18n/apiErrors';
import { uploadReducer, type UploadTask } from './upload-reducer';

const RESERVED_ROOT_NAMES = new Set(['api', 'file', 'admin']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_CONCURRENT_UPLOADS = 2;

interface UploadQueueOptions {
  transport?: UploadTransport;
  onCompleted(parentId: string): void;
  canUpload?: boolean;
  multipartUpload?: boolean;
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

function resumableControl(task: UploadTask, dispatch: Dispatch<import('./upload-reducer').UploadAction>): ResumableUploadControl {
  return {
    sessionId: task.sessionId,
    paused: false,
    onSession: (session) => dispatch({
      type: 'session',
      id: task.id,
      sessionId: session.id,
      uploadedParts: session.uploadedParts.map((part) => part.partNumber),
      partCount: Math.ceil(session.size / session.partSize),
      uploadedBytes: session.uploadedParts.reduce((total, part) => total + part.size, 0),
    }),
    onPartConfirmed: (part) => dispatch({
      type: 'partConfirmed', id: task.id, partNumber: part.partNumber, uploadedBytes: Math.min(task.file.size, part.partNumber * LARGE_UPLOAD_THRESHOLD_BYTES),
    }),
    onCompleting: () => dispatch({ type: 'completing', id: task.id }),
  };
}

export function useUploadQueue({ transport = uploadFile, onCompleted, canUpload = true, multipartUpload = false, existingNames = [] }: UploadQueueOptions) {
  const { t } = useI18n();
  const [tasks, dispatch] = useReducer(uploadReducer, []);
  const controllers = useRef(new Map<string, AbortController>());
  const controls = useRef(new Map<string, ResumableUploadControl>());
  const pendingResumes = useRef(new Set<string>());
  const transportRef = useRef(transport);
  const completedRef = useRef(onCompleted);
  transportRef.current = transport;
  completedRef.current = onCompleted;

  useEffect(() => () => {
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
  }, []);

  useEffect(() => {
    const needsWarning = tasks.some((task) => task.transport === 'multipart' && (
      ['creating', 'uploading', 'paused', 'completing'].includes(task.status)
      || (task.status === 'failed' && Boolean(task.sessionId))
    ));
    if (!needsWarning) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = t('upload.leaveWarning');
      return event.returnValue;
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [t, tasks]);

  useEffect(() => {
    const running = tasks.filter((task) => ['creating', 'uploading', 'completing'].includes(task.status)).length;
    const available = Math.max(0, MAX_CONCURRENT_UPLOADS - running);
    if (!available) return;
    tasks.filter((task) => task.status === 'queued').slice(0, available).forEach((task) => {
      if (controllers.current.has(task.id)) return;
      const controller = new AbortController();
      const multipart = task.transport === 'multipart';
      const control = controls.current.get(task.id) ?? resumableControl(task, dispatch);
      control.paused = false;
      if (task.sessionId) control.sessionId = task.sessionId;
      controls.current.set(task.id, control);
      controllers.current.set(task.id, controller);
      dispatch({ type: 'started', id: task.id, multipart });
      void transportRef.current({
        id: task.id,
        parentId: task.parentId,
        file: task.file,
        multipartUpload: multipart,
        signal: controller.signal,
        control: multipart ? control : undefined,
        onProgress: (uploadedBytes, totalBytes) => {
          const partCount = Math.ceil(task.file.size / LARGE_UPLOAD_THRESHOLD_BYTES);
          const partNumber = multipart ? Math.min(partCount, Math.floor(uploadedBytes / LARGE_UPLOAD_THRESHOLD_BYTES) + 1) : undefined;
          dispatch({ type: 'progress', id: task.id, uploadedBytes, totalBytes, partNumber, partCount: multipart ? partCount : undefined });
        },
      }).then(() => {
        if (!controller.signal.aborted) {
          dispatch({ type: 'completed', id: task.id });
          controls.current.delete(task.id);
          completedRef.current(task.parentId);
        }
      }).catch((error: unknown) => {
        if (error instanceof UploadPausedError || control.paused) return;
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) dispatch({ type: 'cancelled', id: task.id });
        else dispatch({ type: 'failed', id: task.id, error: localizedApiError(error, t, 'upload.failedMessage') });
      }).finally(() => {
        controllers.current.delete(task.id);
        if (pendingResumes.current.delete(task.id)) {
          control.paused = false;
          dispatch({ type: 'resume', id: task.id });
        } else {
          dispatch({ type: 'released', id: task.id });
        }
      });
    });
  }, [t, tasks]);

  const enqueue = useCallback((parentId: string, files: File[]) => {
    const occupiedNames = new Set(existingNames);
    tasks.filter((task) => task.parentId === parentId && task.status !== 'cancelled').forEach((task) => occupiedNames.add(task.file.name));
    const additions: UploadTask[] = files.map((file) => {
      const error = validationError(file.name, parentId, occupiedNames, canUpload, t);
      if (!error) occupiedNames.add(file.name);
      const transportKind = multipartUpload && file.size >= LARGE_UPLOAD_THRESHOLD_BYTES ? 'multipart' : 'single';
      return {
        id: crypto.randomUUID(), parentId, file, transport: transportKind,
        status: error ? 'failed' : 'queued', uploadedBytes: 0, progress: 0, ...(error ? { error } : {}),
      };
    });
    if (additions.length) dispatch({ type: 'enqueue', tasks: additions });
  }, [canUpload, existingNames, multipartUpload, t, tasks]);

  const pause = useCallback((id: string) => {
    const control = controls.current.get(id);
    if (control) control.paused = true;
    dispatch({ type: 'paused', id });
    controllers.current.get(id)?.abort();
  }, []);

  const resume = useCallback((id: string) => {
    const control = controls.current.get(id);
    if (controllers.current.has(id)) {
      pendingResumes.current.add(id);
      return;
    }
    if (control) control.paused = false;
    dispatch({ type: 'resume', id });
  }, []);

  const cancel = useCallback((id: string) => {
    const task = tasks.find((candidate) => candidate.id === id);
    const control = controls.current.get(id);
    if (control) control.paused = false;
    pendingResumes.current.delete(id);
    const controller = controllers.current.get(id);
    if (controller) controller.abort();
    if (task?.sessionId && (!controller || task.status === 'paused')) void abortUploadSession(task.sessionId).catch(() => undefined);
    dispatch({ type: 'cancelled', id });
    controls.current.delete(id);
  }, [tasks]);

  const retry = useCallback((id: string) => dispatch({ type: 'retry', id }), []);
  const remove = useCallback((id: string) => {
    controls.current.delete(id);
    pendingResumes.current.delete(id);
    dispatch({ type: 'remove', id });
  }, []);
  const clearCompleted = useCallback(() => dispatch({ type: 'clearCompleted' }), []);

  return { tasks, enqueue, pause, resume, cancel, retry, remove, clearCompleted };
}
