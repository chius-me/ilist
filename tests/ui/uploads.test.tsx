import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { uploadReducer } from '../../src/ui/features/uploads/upload-reducer';
import { useUploadQueue } from '../../src/ui/features/uploads/useUploadQueue';

describe('upload queue', () => {
  it('tracks byte progress and retryable failure', () => {
    const task = { id: 'upload-12345678', parentId: 'root', file: new File(['hello'], 'a.txt'), status: 'queued' as const, uploadedBytes: 0, progress: 0 };
    const uploading = uploadReducer([task], { type: 'progress', id: task.id, uploadedBytes: 3, totalBytes: 5 });
    expect(uploading[0]).toMatchObject({ status: 'uploading', uploadedBytes: 3, progress: 60 });
    const failed = uploadReducer(uploading, { type: 'failed', id: task.id, error: 'Upload failed' });
    expect(failed[0]).toMatchObject({ status: 'failed', error: 'Upload failed' });
  });

  it('never starts more than two transports concurrently', async () => {
    let active = 0;
    let maximum = 0;
    const resolvers: Array<() => void> = [];
    const transport = vi.fn(() => new Promise<void>((resolve) => {
      active += 1;
      maximum = Math.max(maximum, active);
      resolvers.push(() => { active -= 1; resolve(); });
    }));
    const { result } = renderHook(() => useUploadQueue({ transport, onCompleted: () => undefined }));
    act(() => result.current.enqueue('root', [new File(['1'], '1.txt'), new File(['2'], '2.txt'), new File(['3'], '3.txt')]));
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    expect(maximum).toBe(2);
    act(() => resolvers.shift()?.());
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(3));
  });

  it('keeps invalid and duplicate names out of the transport queue', async () => {
    const transport = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() => useUploadQueue({ transport, onCompleted: () => undefined }));
    act(() => result.current.enqueue('root', [new File([''], '   '), new File(['a'], 'same.txt'), new File(['b'], 'same.txt')]));
    await waitFor(() => expect(result.current.tasks).toHaveLength(3));
    await waitFor(() => expect(result.current.tasks.map((task) => task.status)).toEqual(['failed', 'completed', 'failed']));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.current.tasks.map((task) => task.error)).toEqual(['Invalid file name', undefined, 'Another queued file already has this name']);
  });
});
