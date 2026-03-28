import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../src/ui/app/AppProviders';
import {
  LARGE_UPLOAD_THRESHOLD_BYTES,
  createUploadSession,
  uploadFile,
  UploadPausedError,
  type ResumableUploadControl,
} from '../../src/ui/api/uploads';
import { uploadReducer } from '../../src/ui/features/uploads/upload-reducer';
import { useUploadQueue } from '../../src/ui/features/uploads/useUploadQueue';

const PART_SIZE = 10 * 1024 * 1024;

type XhrPlan =
  | { type: 'success'; response?: unknown }
  | { type: 'failure'; status: number; response?: unknown }
  | { type: 'pending' };

class MockXMLHttpRequest {
  static plans: XhrPlan[] = [];
  static requests: MockXMLHttpRequest[] = [];

  method = '';
  url = '';
  status = 0;
  responseText = '';
  readonly headers = new Headers();
  body: Document | XMLHttpRequestBodyInit | null = null;
  derivedContentLength: number | undefined;
  upload: XMLHttpRequestUpload = {} as XMLHttpRequestUpload;
  onerror: ((this: XMLHttpRequest, ev: ProgressEvent<EventTarget>) => unknown) | null = null;
  onabort: ((this: XMLHttpRequest, ev: ProgressEvent<EventTarget>) => unknown) | null = null;
  onload: ((this: XMLHttpRequest, ev: ProgressEvent<EventTarget>) => unknown) | null = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value);
  }

  send(body: Document | XMLHttpRequestBodyInit | null) {
    this.body = body;
    this.derivedContentLength = body instanceof Blob ? body.size : undefined;
    MockXMLHttpRequest.requests.push(this);
    const plan = MockXMLHttpRequest.plans.shift() ?? { type: 'success' };
    if (plan.type === 'pending') return;
    queueMicrotask(() => {
      const size = body instanceof Blob ? body.size : 0;
      const partNumber = Number(this.url.split('/').at(-1));
      (this.upload.onprogress as unknown as ((event: ProgressEvent) => void) | null)?.(new ProgressEvent('progress', { lengthComputable: true, loaded: size, total: size }));
      if (plan.type === 'success') {
        this.status = 200;
        this.responseText = JSON.stringify({ ok: true, data: plan.response ?? { partNumber, size } });
        this.onload?.call(this as unknown as XMLHttpRequest, new ProgressEvent('load'));
      } else {
        this.status = plan.status;
        this.responseText = JSON.stringify({ ok: false, error: { message: 'Part upload failed' } });
        this.onload?.call(this as unknown as XMLHttpRequest, new ProgressEvent('load'));
      }
    });
  }

  abort() {
    this.onabort?.call(this as unknown as XMLHttpRequest, new ProgressEvent('abort'));
  }
}

function sessionView(size: number, uploadedParts: Array<{ partNumber: number; size: number }> = []) {
  return {
    id: 'session-123',
    kind: 'multipart' as const,
    partSize: PART_SIZE,
    size,
    uploadedParts,
    expiresAt: '2026-07-18T00:00:00.000Z',
    status: 'active' as const,
  };
}

function apiResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ ok: status >= 200 && status < 300, ...(status >= 200 && status < 300 ? { data } : { error: { message: 'Request failed' } }) }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function multipartInput(file: File, control?: ResumableUploadControl) {
  return {
    id: 'upload-123',
    parentId: 'folder/with space',
    file,
    multipartUpload: true,
    signal: new AbortController().signal,
    control,
    onProgress: vi.fn(),
  };
}

describe('upload transport', () => {
  beforeEach(() => {
    MockXMLHttpRequest.plans = [];
    MockXMLHttpRequest.requests = [];
    vi.stubGlobal('XMLHttpRequest', MockXMLHttpRequest);
  });

  it('keeps a 10 MiB minus one file on the existing single-request transport', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const file = new File([new Uint8Array(LARGE_UPLOAD_THRESHOLD_BYTES - 1)], 'small.bin', { type: 'application/octet-stream' });

    await uploadFile(multipartInput(file));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockXMLHttpRequest.requests).toHaveLength(1);
    expect(MockXMLHttpRequest.requests[0]).toMatchObject({
      method: 'PUT',
      url: '/api/admin/files/upload-123?parentId=folder%2Fwith+space&name=small.bin',
      body: file,
    });
  });

  it('creates a safe multipart session for an exact 10 MiB file when the folder supports it', async () => {
    const file = new File([new Uint8Array(PART_SIZE)], 'exact.bin', { type: 'application/octet-stream' });
    const session = sessionView(file.size);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(apiResponse(session))
      .mockResolvedValueOnce(apiResponse(session))
      .mockResolvedValueOnce(apiResponse({ id: 'entry-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const created = await createUploadSession({ parentId: 'folder/with space', file });
    expect(created).toEqual(session);
    expect(created).not.toHaveProperty('uploadUrl');
    expect(created).not.toHaveProperty('uploadId');

    await uploadFile(multipartInput(file));

    expect(fetchMock.mock.calls[1][0]).toBe('/api/admin/uploads/sessions');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ parentId: 'folder/with space', name: 'exact.bin', size: PART_SIZE, contentType: 'application/octet-stream' }),
    });
  });

  it('uploads a 25 MiB file as sequential 10 MiB, 10 MiB, and 5 MiB Blob parts', async () => {
    const file = new File([new Uint8Array(PART_SIZE * 2 + PART_SIZE / 2)], 'archive.bin', { type: 'application/custom' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(apiResponse(sessionView(file.size)))
      .mockResolvedValueOnce(apiResponse({ id: 'entry-1' }));
    vi.stubGlobal('fetch', fetchMock);
    const progress = vi.fn();

    await uploadFile({ ...multipartInput(file), onProgress: progress });

    expect(MockXMLHttpRequest.requests).toHaveLength(3);
    expect(MockXMLHttpRequest.requests.map((request) => (request.body as Blob).size)).toEqual([PART_SIZE, PART_SIZE, PART_SIZE / 2]);
    expect(MockXMLHttpRequest.requests.map((request) => request.url)).toEqual([
      '/api/admin/uploads/sessions/session-123/parts/1',
      '/api/admin/uploads/sessions/session-123/parts/2',
      '/api/admin/uploads/sessions/session-123/parts/3',
    ]);
    expect(MockXMLHttpRequest.requests.map((request) => request.derivedContentLength)).toEqual([PART_SIZE, PART_SIZE, PART_SIZE / 2]);
    expect(MockXMLHttpRequest.requests.map((request) => request.headers.get('content-type'))).toEqual(['application/custom', 'application/custom', 'application/custom']);
    expect(MockXMLHttpRequest.requests.every((request) => request.headers.has('content-length') === false)).toBe(true);
    expect(progress).toHaveBeenLastCalledWith(PART_SIZE * 2 + PART_SIZE / 2, PART_SIZE * 2 + PART_SIZE / 2);
    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/admin/uploads/sessions/session-123/complete');
  });

  it('retries a failed part from the server-confirmed session state without resending earlier parts', async () => {
    const file = new File([new Uint8Array(PART_SIZE * 2)], 'retry.bin', { type: 'application/octet-stream' });
    const control: ResumableUploadControl = {};
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(apiResponse(sessionView(file.size)))
      .mockResolvedValueOnce(apiResponse(sessionView(file.size, [{ partNumber: 1, size: PART_SIZE }])))
      .mockResolvedValueOnce(apiResponse({ id: 'entry-1' }));
    vi.stubGlobal('fetch', fetchMock);
    MockXMLHttpRequest.plans = [{ type: 'success' }, { type: 'failure', status: 503 }, { type: 'success' }];

    await expect(uploadFile(multipartInput(file, control))).rejects.toThrow('Part upload failed');
    expect(control.sessionId).toBe('session-123');
    expect(MockXMLHttpRequest.requests.map((request) => request.url)).toEqual([
      '/api/admin/uploads/sessions/session-123/parts/1',
      '/api/admin/uploads/sessions/session-123/parts/2',
    ]);

    await uploadFile(multipartInput(file, control));

    expect(MockXMLHttpRequest.requests.map((request) => request.url)).toEqual([
      '/api/admin/uploads/sessions/session-123/parts/1',
      '/api/admin/uploads/sessions/session-123/parts/2',
      '/api/admin/uploads/sessions/session-123/parts/2',
    ]);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/admin/uploads/sessions/session-123');
  });

  it('pauses between parts without losing the server session or aborting it', async () => {
    const file = new File([new Uint8Array(PART_SIZE)], 'pause.bin', { type: 'application/octet-stream' });
    const control: ResumableUploadControl = { paused: true };
    const fetchMock = vi.fn().mockResolvedValueOnce(apiResponse(sessionView(file.size)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadFile(multipartInput(file, control))).rejects.toBeInstanceOf(UploadPausedError);

    expect(control.sessionId).toBe('session-123');
    expect(MockXMLHttpRequest.requests).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts the active XHR and requests server-side session cancellation', async () => {
    const controller = new AbortController();
    const file = new File([new Uint8Array(PART_SIZE)], 'cancel.bin', { type: 'application/octet-stream' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(apiResponse(sessionView(file.size)))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    MockXMLHttpRequest.plans = [{ type: 'pending' }];

    const upload = uploadFile({ ...multipartInput(file), signal: controller.signal });
    await waitFor(() => expect(MockXMLHttpRequest.requests).toHaveLength(1));
    controller.abort();

    await expect(upload).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/uploads/sessions/session-123', {
      method: 'DELETE',
      credentials: 'same-origin',
    });
  });
});

describe('upload queue', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <AppProviders>{children}</AppProviders>;
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
    const { result } = renderHook(() => useUploadQueue({ transport, onCompleted: () => undefined }), { wrapper });
    act(() => result.current.enqueue('root', [new File(['1'], '1.txt'), new File(['2'], '2.txt'), new File(['3'], '3.txt')]));
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    expect(maximum).toBe(2);
    act(() => resolvers.shift()?.());
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(3));
  });

  it('keeps invalid and duplicate names out of the transport queue', async () => {
    const transport = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() => useUploadQueue({ transport, onCompleted: () => undefined }), { wrapper });
    act(() => result.current.enqueue('root', [new File([''], '   '), new File(['a'], 'same.txt'), new File(['b'], 'same.txt')]));
    await waitFor(() => expect(result.current.tasks).toHaveLength(3));
    await waitFor(() => expect(result.current.tasks.map((task) => task.status)).toEqual(['failed', 'completed', 'failed']));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.current.tasks.map((task) => task.error)).toEqual(['Invalid file name', undefined, 'Another queued file already has this name']);
  });

  it('refreshes the uploaded parent only after a transport completes', async () => {
    let finish!: () => void;
    const transport = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onCompleted = vi.fn();
    const { result } = renderHook(() => useUploadQueue({ transport, onCompleted }), { wrapper });

    act(() => result.current.enqueue('onedrive-folder', [new File(['content'], 'report.txt')]));
    await waitFor(() => expect(transport).toHaveBeenCalledOnce());
    expect(onCompleted).not.toHaveBeenCalled();
    act(() => finish());
    await waitFor(() => expect(onCompleted).toHaveBeenCalledWith('onedrive-folder'));
  });
});
