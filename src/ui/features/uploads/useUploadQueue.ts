import { useCallback, useEffect, useReducer, useRef, type Dispatch } from 'react';
import {
  LARGE_UPLOAD_THRESHOLD_BYTES,
  UploadPausedError,
  abortUploadSession,
  listUploadSessions,
  uploadFile,
  type ResumableUploadControl,
  type UploadTransport,
} from '../../api/uploads';
import { useI18n } from '../../i18n/I18nProvider';
import { localizedApiError } from '../../i18n/apiErrors';
import { uploadReducer, type UploadAction, type UploadTask } from './upload-reducer';

const RESERVED_ROOT_NAMES = new Set(['api', 'file', 'admin']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_CONCURRENT_UPLOADS = 2;
const PROGRESS_THROTTLE_MS = 100;
const SESSION_STORAGE_KEY = 'ilist.upload.sessions.v1';

interface PersistedUploadSession {
  sessionId: string;
  parentId: string;
  name: string;
  size: number;
  uploadedBytes: number;
  uploadedParts: number[];
  partCount: number;
  lastModified?: number;
}

export interface EnqueueUploadOptions {
  canUpload?: boolean;
  multipartUpload?: boolean;
  existingNames?: Iterable<string>;
}

interface UploadQueueOptions {
  enabled?: boolean;
  transport?: UploadTransport;
  onCompleted(parentId: string): void;
  canUpload?: boolean;
  multipartUpload?: boolean;
  existingNames?: Iterable<string>;
}

function validationError(
  name: string,
  parentId: string,
  occupiedNames: Set<string>,
  canUpload: boolean,
  t: ReturnType<typeof useI18n>['t'],
): string | undefined {
  if (!canUpload) return t('upload.permissionDenied');
  const byteLength = new TextEncoder().encode(name).byteLength;
  if (!name.trim() || name === '.' || name === '..' || name.includes('/') || CONTROL_CHARACTERS.test(name) || byteLength > 255 || (parentId === 'root' && RESERVED_ROOT_NAMES.has(name))) {
    return t('upload.invalidName');
  }
  if (occupiedNames.has(name)) return t('upload.duplicateName');
  return undefined;
}

function resumableControl(task: UploadTask, dispatch: Dispatch<UploadAction>): ResumableUploadControl {
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
    onPartConfirmed: (part, committedBytes) => dispatch({
      type: 'partConfirmed',
      id: task.id,
      partNumber: part.partNumber,
      uploadedBytes: committedBytes ?? Math.min(task.file.size || Number.MAX_SAFE_INTEGER, part.partNumber * LARGE_UPLOAD_THRESHOLD_BYTES),
    }),
    onCompleting: () => dispatch({ type: 'completing', id: task.id }),
  };
}

function readPersistedSessions(): PersistedUploadSession[] {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PersistedUploadSession => (
      typeof item === 'object'
      && item !== null
      && typeof (item as PersistedUploadSession).sessionId === 'string'
      && typeof (item as PersistedUploadSession).parentId === 'string'
      && typeof (item as PersistedUploadSession).name === 'string'
      && typeof (item as PersistedUploadSession).size === 'number'
    ));
  } catch {
    return [];
  }
}

function writePersistedSessions(sessions: PersistedUploadSession[]): void {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // Storage may be unavailable; resume still works from the server list alone.
  }
}

/**
 * Placeholder File for restored sessions. Body is empty (cannot re-read disk),
 * but `size` is set to the server session size so rebind validation works.
 */
export function placeholderFile(name: string, size: number): File {
  const file = new File([new Uint8Array(0)], name, { type: 'application/octet-stream' });
  if (Number.isSafeInteger(size) && size >= 0) {
    Object.defineProperty(file, 'size', { value: size, configurable: true });
  }
  return file;
}

export function useUploadQueue({
  enabled = true,
  transport = uploadFile,
  onCompleted,
  canUpload = true,
  multipartUpload = false,
  existingNames = [],
}: UploadQueueOptions) {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const [tasks, dispatch] = useReducer(uploadReducer, []);
  const controllers = useRef(new Map<string, AbortController>());
  const controls = useRef(new Map<string, ResumableUploadControl>());
  const pendingResumes = useRef(new Set<string>());
  const progressTimers = useRef(new Map<string, number>());
  const lastProgressDispatch = useRef(new Map<string, number>());
  const pendingProgressActions = useRef(new Map<string, UploadAction>());
  const transportRef = useRef(transport);
  const completedRef = useRef(onCompleted);
  const restoredRef = useRef(false);
  transportRef.current = transport;
  completedRef.current = onCompleted;

  const clearProgressThrottle = useCallback((id: string) => {
    const timer = progressTimers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      progressTimers.current.delete(id);
    }
    pendingProgressActions.current.delete(id);
    lastProgressDispatch.current.delete(id);
  }, []);

  useEffect(() => () => {
    controllers.current.forEach((controller) => { controller.abort(); });
    controllers.current.clear();
    progressTimers.current.forEach((timer) => { window.clearTimeout(timer); });
    progressTimers.current.clear();
    pendingProgressActions.current.clear();
  }, []);

  useEffect(() => {
    if (!enabled) {
      restoredRef.current = false;
      return;
    }
    if (restoredRef.current) return;
    restoredRef.current = true;
    void listUploadSessions().then((sessions) => {
      const persisted = new Map(readPersistedSessions().map((item) => [item.sessionId, item]));
      const restored: UploadTask[] = sessions
        .filter((session) => session.status === 'active' || session.status === 'completing')
        .map((session) => {
          const local = persisted.get(session.id);
          const name = session.name ?? local?.name ?? 'upload.bin';
          const size = session.size;
          const parentId = local?.parentId || session.parentItemId || '';
          const uploadedBytes = session.uploadedBytes ?? local?.uploadedBytes ?? 0;
          const partCount = Math.ceil(size / session.partSize);
          return {
            id: crypto.randomUUID(),
            parentId,
            file: placeholderFile(name, size),
            transport: 'multipart' as const,
            status: 'failed' as const,
            uploadedBytes,
            progress: size ? Math.round((uploadedBytes / size) * 100) : 0,
            sessionId: session.id,
            partCount,
            uploadedParts: session.uploadedParts.map((part) => part.partNumber),
            needsRebind: true,
            fileName: name,
            expectedSize: size,
            ...(typeof local?.lastModified === 'number' ? { expectedLastModified: local.lastModified } : {}),
            error: tRef.current('upload.rebindRequired'),
          };
        });
      if (restored.length) dispatch({ type: 'enqueue', tasks: restored });
    }).catch(() => undefined);
  }, [enabled]);

  useEffect(() => {
    const next = tasks
      .filter((task) => task.transport === 'multipart' && task.sessionId && !['completed', 'cancelled', 'aborted'].includes(task.status))
      .map((task): PersistedUploadSession => ({
        sessionId: task.sessionId!,
        parentId: task.parentId,
        name: task.fileName ?? task.file.name,
        size: task.expectedSize ?? task.file.size ?? 0,
        uploadedBytes: task.uploadedBytes,
        uploadedParts: task.uploadedParts ?? [],
        partCount: task.partCount ?? 0,
        ...(task.expectedLastModified !== undefined ? { lastModified: task.expectedLastModified } : {}),
      }));
    writePersistedSessions(next);
  }, [tasks]);

  useEffect(() => {
    const needsWarning = tasks.some((task) => task.transport === 'multipart' && (
      ['creating', 'uploading', 'paused', 'completing'].includes(task.status)
      || (task.status === 'failed' && Boolean(task.sessionId))
    ));
    if (!needsWarning) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = tRef.current('upload.leaveWarning');
      return event.returnValue;
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [tasks]);

  useEffect(() => {
    const running = tasks.filter((task) => ['creating', 'uploading', 'completing'].includes(task.status)).length;
    const available = Math.max(0, MAX_CONCURRENT_UPLOADS - running);
    if (!available) return;
    tasks.filter((task) => task.status === 'queued' && !task.needsRebind).slice(0, available).forEach((task) => {
      if (controllers.current.has(task.id)) return;
      const controller = new AbortController();
      const multipart = task.transport === 'multipart';
      const control = controls.current.get(task.id) ?? resumableControl(task, dispatch);
      control.paused = false;
      if (task.restartSession) control.sessionId = undefined;
      else if (task.sessionId) control.sessionId = task.sessionId;
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
          const action: UploadAction = {
            type: 'progress',
            id: task.id,
            uploadedBytes,
            totalBytes,
            partNumber,
            partCount: multipart ? partCount : undefined,
          };
          const now = Date.now();
          const lastAt = lastProgressDispatch.current.get(task.id) ?? 0;
          if (uploadedBytes === 0 || uploadedBytes >= totalBytes || now - lastAt >= PROGRESS_THROTTLE_MS) {
            clearProgressThrottle(task.id);
            lastProgressDispatch.current.set(task.id, now);
            dispatch(action);
            return;
          }
          pendingProgressActions.current.set(task.id, action);
          if (!progressTimers.current.has(task.id)) {
            const delay = Math.max(0, PROGRESS_THROTTLE_MS - (now - lastAt));
            const timer = window.setTimeout(() => {
              progressTimers.current.delete(task.id);
              const pending = pendingProgressActions.current.get(task.id);
              pendingProgressActions.current.delete(task.id);
              if (pending && controllers.current.has(task.id)) {
                lastProgressDispatch.current.set(task.id, Date.now());
                dispatch(pending);
              }
            }, delay);
            progressTimers.current.set(task.id, timer);
          }
        },
      }).then(() => {
        clearProgressThrottle(task.id);
        if (!controller.signal.aborted) {
          dispatch({ type: 'completed', id: task.id });
          controls.current.delete(task.id);
          completedRef.current(task.parentId);
        }
      }).catch((error: unknown) => {
        clearProgressThrottle(task.id);
        if (error instanceof UploadPausedError || control.paused) return;
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
          dispatch({ type: 'cancelled', id: task.id });
        } else {
          dispatch({ type: 'failed', id: task.id, error: localizedApiError(error, tRef.current, 'upload.failedMessage') });
        }
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
  }, [clearProgressThrottle, tasks]);

  const enqueue = useCallback((parentId: string, files: File[], overrides?: EnqueueUploadOptions) => {
    const effectiveCanUpload = overrides?.canUpload ?? canUpload;
    const effectiveMultipartUpload = overrides?.multipartUpload ?? multipartUpload;
    const effectiveExistingNames = overrides?.existingNames ?? existingNames;
    const occupiedNames = new Set(effectiveExistingNames);
    tasks.filter((task) => task.parentId === parentId && task.status !== 'cancelled').forEach((task) => { occupiedNames.add(task.file.name); });
    const additions: UploadTask[] = files.map((file) => {
      const error = validationError(file.name, parentId, occupiedNames, effectiveCanUpload, tRef.current);
      if (!error) occupiedNames.add(file.name);
      const transportKind = effectiveMultipartUpload && file.size >= LARGE_UPLOAD_THRESHOLD_BYTES ? 'multipart' : 'single';
      return {
        id: crypto.randomUUID(),
        parentId,
        file,
        transport: transportKind,
        status: error ? 'failed' : 'queued',
        uploadedBytes: 0,
        progress: 0,
        fileName: file.name,
        expectedSize: file.size,
        expectedLastModified: file.lastModified,
        ...(error ? { error } : {}),
      };
    });
    if (additions.length) dispatch({ type: 'enqueue', tasks: additions });
  }, [canUpload, existingNames, multipartUpload, tasks]);

  const pause = useCallback((id: string) => {
    clearProgressThrottle(id);
    const control = controls.current.get(id);
    if (control) control.paused = true;
    dispatch({ type: 'paused', id });
    controllers.current.get(id)?.abort();
  }, [clearProgressThrottle]);

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
    clearProgressThrottle(id);
    const task = tasks.find((candidate) => candidate.id === id);
    const control = controls.current.get(id);
    if (control) control.paused = false;
    pendingResumes.current.delete(id);
    const controller = controllers.current.get(id);
    if (controller) controller.abort();
    if (task?.sessionId && (!controller || task.status === 'paused' || task.needsRebind || task.status === 'failed')) {
      void abortUploadSession(task.sessionId).catch(() => undefined);
    }
    dispatch({ type: 'cancelled', id });
    controls.current.delete(id);
  }, [clearProgressThrottle, tasks]);

  const retry = useCallback((id: string) => dispatch({ type: 'retry', id }), []);
  const rebind = useCallback((id: string, file: File) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (task?.sessionId && task.expectedLastModified === undefined) {
      void abortUploadSession(task.sessionId).catch(() => undefined);
    }
    dispatch({ type: 'rebind', id, file });
  }, [tasks]);
  const remove = useCallback((id: string) => {
    clearProgressThrottle(id);
    controls.current.delete(id);
    pendingResumes.current.delete(id);
    dispatch({ type: 'remove', id });
  }, [clearProgressThrottle]);
  const clearCompleted = useCallback(() => dispatch({ type: 'clearCompleted' }), []);

  return { tasks, enqueue, pause, resume, cancel, retry, rebind, remove, clearCompleted };
}
