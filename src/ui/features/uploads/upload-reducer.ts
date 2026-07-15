export type UploadStatus = 'queued' | 'creating' | 'uploading' | 'paused' | 'completing' | 'completed' | 'failed' | 'cancelled';

export interface UploadTask {
  id: string;
  parentId: string;
  file: File;
  status: UploadStatus;
  transport: 'single' | 'multipart';
  uploadedBytes: number;
  progress: number;
  sessionId?: string;
  partNumber?: number;
  partCount?: number;
  uploadedParts?: number[];
  /** True when a server session exists but the local File must be re-selected. */
  needsRebind?: boolean;
  fileName?: string;
  /** Expected total size from the server session (used when rebinding after reload). */
  expectedSize?: number;
  error?: string;
}

export type UploadAction =
  | { type: 'enqueue'; tasks: UploadTask[] }
  | { type: 'started'; id: string; multipart: boolean }
  | { type: 'session'; id: string; sessionId: string; uploadedParts: number[]; partCount: number; uploadedBytes: number }
  | { type: 'partConfirmed'; id: string; partNumber: number; uploadedBytes: number }
  | { type: 'progress'; id: string; uploadedBytes: number; totalBytes: number; partNumber?: number; partCount?: number }
  | { type: 'paused'; id: string }
  | { type: 'resume'; id: string }
  | { type: 'completing'; id: string }
  | { type: 'completed'; id: string }
  | { type: 'failed'; id: string; error: string }
  | { type: 'cancelled'; id: string }
  | { type: 'retry'; id: string }
  | { type: 'released'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'clearCompleted' }
  | { type: 'rebind'; id: string; file: File };

function percent(uploadedBytes: number, totalBytes: number): number {
  return totalBytes ? Math.round((Math.min(uploadedBytes, totalBytes) / totalBytes) * 100) : 100;
}

export function uploadReducer(tasks: UploadTask[], action: UploadAction): UploadTask[] {
  if (action.type === 'enqueue') return [...tasks, ...action.tasks];
  if (action.type === 'remove') return tasks.filter((task) => task.id !== action.id);
  if (action.type === 'clearCompleted') return tasks.filter((task) => task.status !== 'completed');
  return tasks.map((task) => {
    if (task.id !== action.id) return task;
    if (action.type === 'started') return { ...task, status: action.multipart ? 'creating' : 'uploading', error: undefined };
    if (action.type === 'session') return {
      ...task,
      status: task.status === 'paused' ? 'paused' : 'uploading',
      sessionId: action.sessionId,
      uploadedParts: action.uploadedParts,
      partCount: action.partCount,
      uploadedBytes: Math.max(task.uploadedBytes, action.uploadedBytes),
      progress: percent(Math.max(task.uploadedBytes, action.uploadedBytes), task.file.size),
    };
    if (action.type === 'partConfirmed') return {
      ...task,
      status: task.status === 'paused' ? 'paused' : 'uploading',
      uploadedParts: [...new Set([...(task.uploadedParts ?? []), action.partNumber])].sort((a, b) => a - b),
      uploadedBytes: Math.max(task.uploadedBytes, action.uploadedBytes),
      progress: percent(Math.max(task.uploadedBytes, action.uploadedBytes), task.file.size),
    };
    if (action.type === 'progress') {
      const totalBytes = action.totalBytes || task.file.size;
      const uploadedBytes = Math.max(task.uploadedBytes, Math.min(action.uploadedBytes, totalBytes));
      return {
        ...task,
        status: task.status === 'queued' || task.status === 'creating' ? 'uploading' : task.status,
        uploadedBytes,
        progress: Math.max(task.progress, percent(uploadedBytes, totalBytes)),
        partNumber: action.partNumber ?? task.partNumber,
        partCount: action.partCount ?? task.partCount,
      };
    }
    if (action.type === 'paused') return { ...task, status: 'paused', error: undefined };
    if (action.type === 'resume') return { ...task, status: 'queued', error: undefined };
    if (action.type === 'completing') return { ...task, status: 'completing', uploadedBytes: task.file.size, progress: 100, error: undefined };
    if (action.type === 'completed') return { ...task, status: 'completed', uploadedBytes: task.file.size, progress: 100, error: undefined };
    if (action.type === 'failed') return { ...task, status: 'failed', error: action.error };
    if (action.type === 'cancelled') return { ...task, status: 'cancelled', error: undefined };
    if (action.type === 'retry') {
      if (task.needsRebind) return task;
      if (task.transport === 'multipart' && task.sessionId) return { ...task, status: 'queued', error: undefined };
      return { ...task, status: 'queued', uploadedBytes: 0, progress: 0, error: undefined };
    }
    if (action.type === 'rebind') {
      if (task.fileName && action.file.name !== task.fileName) return task;
      const expectedSize = task.expectedSize ?? task.file.size;
      if (expectedSize > 0 && action.file.size !== expectedSize) return task;
      return {
        ...task,
        file: action.file,
        expectedSize: action.file.size,
        needsRebind: false,
        status: 'queued',
        error: undefined,
      };
    }
    if (action.type === 'released') return task;
    return task;
  });
}
