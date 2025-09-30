export type UploadStatus = 'queued' | 'uploading' | 'completed' | 'failed' | 'cancelled';

export interface UploadTask {
  id: string;
  parentId: string;
  file: File;
  status: UploadStatus;
  uploadedBytes: number;
  progress: number;
  error?: string;
}

export type UploadAction =
  | { type: 'enqueue'; tasks: UploadTask[] }
  | { type: 'started'; id: string }
  | { type: 'progress'; id: string; uploadedBytes: number; totalBytes: number }
  | { type: 'completed'; id: string }
  | { type: 'failed'; id: string; error: string }
  | { type: 'cancelled'; id: string }
  | { type: 'retry'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'clearCompleted' };

export function uploadReducer(tasks: UploadTask[], action: UploadAction): UploadTask[] {
  if (action.type === 'enqueue') return [...tasks, ...action.tasks];
  if (action.type === 'remove') return tasks.filter((task) => task.id !== action.id);
  if (action.type === 'clearCompleted') return tasks.filter((task) => task.status !== 'completed');
  return tasks.map((task) => {
    if (task.id !== action.id) return task;
    if (action.type === 'started') return { ...task, status: 'uploading', error: undefined };
    if (action.type === 'progress') {
      const uploadedBytes = Math.min(action.uploadedBytes, action.totalBytes || task.file.size);
      const totalBytes = action.totalBytes || task.file.size;
      return { ...task, status: 'uploading', uploadedBytes, progress: totalBytes ? Math.round((uploadedBytes / totalBytes) * 100) : 100 };
    }
    if (action.type === 'completed') return { ...task, status: 'completed', uploadedBytes: task.file.size, progress: 100, error: undefined };
    if (action.type === 'failed') return { ...task, status: 'failed', error: action.error };
    if (action.type === 'cancelled') return { ...task, status: 'cancelled', error: undefined };
    if (action.type === 'retry') return { ...task, status: 'queued', uploadedBytes: 0, progress: 0, error: undefined };
    return task;
  });
}
