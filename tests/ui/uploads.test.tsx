import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
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
import { ApiError } from '../../src/ui/api/client';
import { uploadReducer } from '../../src/ui/features/uploads/upload-reducer';
import { UploadPanel } from '../../src/ui/features/uploads/UploadPanel';
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
    queueMicrotask(() => this.respond(plan));
  }

  emitProgress(loaded: number) {
    const total = this.body instanceof Blob ? this.body.size : 0;
    (this.upload.onprogress as unknown as ((event: ProgressEvent) => void) | null)?.(new ProgressEvent('progress', { lengthComputable: true, loaded, total }));
  }

  succeed(response?: unknown) {
    this.respond({ type: 'success', response });
  }

  private respond(plan: Exclude<XhrPlan, { type: 'pending' }>) {
    const size = this.body instanceof Blob ? this.body.size : 0;
    const partNumber = Number(this.url.split('/').at(-1));
    this.emitProgress(size);
    if (plan.type === 'success') {
      this.status = 200;
      this.responseText = JSON.stringify({ ok: true, data: plan.response ?? { partNumber, size } });
      this.onload?.call(this as unknown as XMLHttpRequest, new ProgressEvent('load'));
      return;
    }
    this.status = plan.status;
    this.responseText = JSON.stringify({ ok: false, error: plan.response ?? { message: 'Part upload failed' } });
    this.onload?.call(this as unknown as XMLHttpRequest, new ProgressEvent('load'));
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
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
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

  it('rejects a pre-aborted upload without sending or hanging', async () => {
    const controller = new AbortController();
    controller.abort();
    const file = new File(['cancelled'], 'cancelled.txt', { type: 'text/plain' });

    await expect(uploadFile({ ...multipartInput(file), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(MockXMLHttpRequest.requests).toHaveLength(0);
  });

  it('preserves stable API error codes from failed part responses', async () => {
    const file = new File([new Uint8Array(PART_SIZE)], 'limited.bin', { type: 'application/octet-stream' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(apiResponse(sessionView(file.size))));
    MockXMLHttpRequest.plans = [{ type: 'failure', status: 429, response: { code: 'UPLOAD_PROVIDER_RATE_LIMITED', message: 'Retry later' } }];

    const upload = uploadFile(multipartInput(file));
    await expect(upload).rejects.toBeInstanceOf(ApiError);
    await expect(upload).rejects.toMatchObject({ status: 429, code: 'UPLOAD_PROVIDER_RATE_LIMITED' });
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

  it('rejects malformed session responses before opening a part XHR', async () => {
    const file = new File([new Uint8Array(PART_SIZE)], 'invalid.bin', { type: 'application/octet-stream' });
    const malformedSessions = [
      { ...sessionView(file.size), id: '   ' },
      { ...sessionView(file.size), partSize: PART_SIZE / 2 },
      { ...sessionView(file.size), expiresAt: 'not-a-date' },
      { ...sessionView(file.size), expiresAt: new Date(Date.now() - 60_000).toISOString() },
      { ...sessionView(file.size), status: 'provider-uploading' },
      { ...sessionView(file.size), status: 'aborted' },
    ];

    for (const session of malformedSessions) {
      const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(apiResponse(session)));
      vi.stubGlobal('fetch', fetchMock);

      await expect(uploadFile(multipartInput(file))).rejects.toThrow('Upload session response is invalid');
      expect(MockXMLHttpRequest.requests).toHaveLength(0);
      vi.unstubAllGlobals();
      vi.stubGlobal('XMLHttpRequest', MockXMLHttpRequest);
    }
  });

  it('strips hostile provider-shaped fields from session data before browser transport uses it', async () => {
    const file = new File([new Uint8Array(PART_SIZE)], 'safe.bin', { type: 'application/octet-stream' });
    const hostile = {
      ...sessionView(file.size),
      uploadUrl: 'https://provider.example/upload?token=secret',
      uploadId: 'provider-upload-id',
      providerState: { uploadUrl: 'https://provider.example/private' },
      credentials: { token: 'secret' },
    };
    const control: ResumableUploadControl = { onSession: vi.fn() };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(apiResponse(hostile))
      .mockResolvedValueOnce(apiResponse({ id: 'entry-1' }));
    vi.stubGlobal('fetch', fetchMock);

    await uploadFile(multipartInput(file, control));

    expect(control.sessionId).toBe('session-123');
    expect(control.uploadedParts).toEqual([{ partNumber: 1, size: PART_SIZE }]);
    expect(control.onSession).toHaveBeenCalledWith({
      id: 'session-123',
      kind: 'multipart',
      partSize: PART_SIZE,
      size: file.size,
      uploadedParts: [],
      expiresAt: hostile.expiresAt,
      status: 'active',
    });
    expect(JSON.stringify(control)).not.toContain('provider.example');
    expect(MockXMLHttpRequest.requests[0].url).toBe('/api/admin/uploads/sessions/session-123/parts/1');
  });

  it('uploads a 25 MiB file as sequential 10 MiB, 10 MiB, and 5 MiB Blob parts', async () => {
    const file = new File([new Uint8Array(PART_SIZE * 2 + PART_SIZE / 2)], 'archive.bin', { type: 'application/custom' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(apiResponse(sessionView(file.size)))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
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
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', credentials: 'same-origin' });
  });

  it('starts each part only after the previous part succeeds and reports committed plus active progress', async () => {
    const file = new File([new Uint8Array(PART_SIZE * 2)], 'sequential.bin', { type: 'application/octet-stream' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(apiResponse(sessionView(file.size)))
      .mockResolvedValueOnce(apiResponse({ id: 'entry-1' }));
    vi.stubGlobal('fetch', fetchMock);
    MockXMLHttpRequest.plans = [{ type: 'pending' }, { type: 'pending' }];
    const progress: Array<[number, number]> = [];

    const upload = uploadFile({ ...multipartInput(file), onProgress: (uploadedBytes, totalBytes) => progress.push([uploadedBytes, totalBytes]) });
    await waitFor(() => expect(MockXMLHttpRequest.requests).toHaveLength(1));
    MockXMLHttpRequest.requests[0].emitProgress(PART_SIZE / 2);
    expect(progress).toEqual([[0, PART_SIZE * 2], [PART_SIZE / 2, PART_SIZE * 2]]);
    expect(MockXMLHttpRequest.requests).toHaveLength(1);

    MockXMLHttpRequest.requests[0].succeed();
    await waitFor(() => expect(MockXMLHttpRequest.requests).toHaveLength(2));
    expect(progress).toContainEqual([PART_SIZE, PART_SIZE * 2]);
    MockXMLHttpRequest.requests[1].emitProgress(PART_SIZE / 4);
    expect(progress).toContainEqual([PART_SIZE + PART_SIZE / 4, PART_SIZE * 2]);

    MockXMLHttpRequest.requests[1].succeed();
    await upload;

    expect(progress.map(([uploadedBytes]) => uploadedBytes)).toEqual([...progress.map(([uploadedBytes]) => uploadedBytes)].sort((left, right) => left - right));
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

    const firstProgress: Array<[number, number]> = [];
    await expect(uploadFile({ ...multipartInput(file, control), onProgress: (uploadedBytes, totalBytes) => firstProgress.push([uploadedBytes, totalBytes]) })).rejects.toThrow('Part upload failed');
    expect(control.sessionId).toBe('session-123');
    expect(MockXMLHttpRequest.requests.map((request) => request.url)).toEqual([
      '/api/admin/uploads/sessions/session-123/parts/1',
      '/api/admin/uploads/sessions/session-123/parts/2',
    ]);

    const retryProgress: Array<[number, number]> = [];
    await uploadFile({ ...multipartInput(file, control), onProgress: (uploadedBytes, totalBytes) => retryProgress.push([uploadedBytes, totalBytes]) });

    expect(MockXMLHttpRequest.requests.map((request) => request.url)).toEqual([
      '/api/admin/uploads/sessions/session-123/parts/1',
      '/api/admin/uploads/sessions/session-123/parts/2',
      '/api/admin/uploads/sessions/session-123/parts/2',
    ]);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/admin/uploads/sessions/session-123');
    expect(firstProgress).toContainEqual([PART_SIZE, PART_SIZE * 2]);
    expect(retryProgress[0]).toEqual([PART_SIZE, PART_SIZE * 2]);
    expect(retryProgress.every(([uploadedBytes], index) => index === 0 || uploadedBytes >= retryProgress[index - 1][0])).toBe(true);
  });

  it('waits for an in-flight creation response, then aborts its opaque session exactly once on cancellation', async () => {
    const controller = new AbortController();
    const file = new File([new Uint8Array(PART_SIZE)], 'create-cancel.bin', { type: 'application/octet-stream' });
    let resolveCreate!: (response: Response) => void;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/admin/uploads/sessions' && init?.method === 'POST') {
        return new Promise<Response>((resolve, reject) => {
          resolveCreate = resolve;
          init.signal?.addEventListener('abort', () => reject(new DOMException('Upload cancelled', 'AbortError')), { once: true });
        });
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const upload = uploadFile({ ...multipartInput(file), signal: controller.signal });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    resolveCreate(apiResponse(sessionView(file.size)));

    await expect(upload).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/uploads/sessions/session-123', {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    expect(MockXMLHttpRequest.requests).toHaveLength(0);
  });

  it('preserves a session when pausing during in-flight creation', async () => {
    const controller = new AbortController();
    const control: ResumableUploadControl = { paused: false };
    const file = new File([new Uint8Array(PART_SIZE)], 'create-pause.bin', { type: 'application/octet-stream' });
    let resolveCreate!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveCreate = resolve; }));
    vi.stubGlobal('fetch', fetchMock);

    const upload = uploadFile({ ...multipartInput(file, control), signal: controller.signal });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    control.paused = true;
    controller.abort();
    resolveCreate(apiResponse(sessionView(file.size)));

    await expect(upload).rejects.toBeInstanceOf(UploadPausedError);
    expect(control.sessionId).toBe('session-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(MockXMLHttpRequest.requests).toHaveLength(0);
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
    const task = { id: 'upload-12345678', parentId: 'root', file: new File(['hello'], 'a.txt'), transport: 'single' as const, status: 'queued' as const, uploadedBytes: 0, progress: 0 };
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

  it('supports the full multipart lifecycle and preserves progress on retry', () => {
    const file = new File([new Uint8Array(PART_SIZE * 2)], 'large.bin');
    const task = { id: 'multipart-1', parentId: 'root', file, transport: 'multipart' as const, status: 'queued' as const, uploadedBytes: 0, progress: 0 };
    let state = uploadReducer([task], { type: 'started', id: task.id, multipart: true });
    expect(state[0].status).toBe('creating');
    state = uploadReducer(state, { type: 'session', id: task.id, sessionId: 'session-1', uploadedParts: [], partCount: 2, uploadedBytes: 0 });
    expect(state[0]).toMatchObject({ status: 'uploading', sessionId: 'session-1', partCount: 2 });
    state = uploadReducer(state, { type: 'partConfirmed', id: task.id, partNumber: 1, uploadedBytes: PART_SIZE });
    state = uploadReducer(state, { type: 'paused', id: task.id });
    expect(state[0]).toMatchObject({ status: 'paused', uploadedBytes: PART_SIZE, uploadedParts: [1] });
    state = uploadReducer(state, { type: 'resume', id: task.id });
    state = uploadReducer(state, { type: 'started', id: task.id, multipart: true });
    state = uploadReducer(state, { type: 'session', id: task.id, sessionId: 'session-1', uploadedParts: [1], partCount: 2, uploadedBytes: PART_SIZE });
    const retryable = state;
    state = uploadReducer(state, { type: 'completing', id: task.id });
    expect(state[0]).toMatchObject({ status: 'completing', progress: 100 });
    expect(uploadReducer(state, { type: 'completed', id: task.id })[0].status).toBe('completed');

    const failed = uploadReducer(retryable, { type: 'failed', id: task.id, error: 'retry' });
    const retried = uploadReducer(failed, { type: 'retry', id: task.id });
    expect(retried[0]).toMatchObject({ status: 'queued', sessionId: 'session-1', uploadedParts: [1], uploadedBytes: PART_SIZE });
  });

  it('restarts a failed single upload from zero and cancels every nonterminal state', () => {
    const file = new File(['small'], 'small.txt');
    const base = { id: 'single-1', parentId: 'root', file, transport: 'single' as const, status: 'failed' as const, uploadedBytes: 3, progress: 60, error: 'failed' };
    expect(uploadReducer([base], { type: 'retry', id: base.id })[0]).toMatchObject({ status: 'queued', uploadedBytes: 0, progress: 0 });
    for (const status of ['queued', 'creating', 'uploading', 'paused', 'failed'] as const) {
      expect(uploadReducer([{ ...base, status }], { type: 'cancelled', id: base.id })[0].status).toBe('cancelled');
    }
  });

  it('releases a paused multipart task slot and resumes it once', async () => {
    const starts: string[] = [];
    const transport = vi.fn(({ id, signal }: Parameters<typeof uploadFile>[0]) => new Promise<void>((resolve, reject) => {
      starts.push(id);
      signal.addEventListener('abort', () => reject(new UploadPausedError()), { once: true });
      if (id.endsWith('3')) resolve();
    }));
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000002')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000003');
    const { result } = renderHook(() => useUploadQueue({ transport, multipartUpload: true, onCompleted: () => undefined }), { wrapper });
    act(() => result.current.enqueue('root', [
      new File([new Uint8Array(PART_SIZE)], '1.bin'),
      new File([new Uint8Array(PART_SIZE)], '2.bin'),
      new File([new Uint8Array(PART_SIZE)], '3.bin'),
    ]));
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    act(() => result.current.pause('00000000-0000-4000-8000-000000000001'));
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(3));
    expect(result.current.tasks.find((task) => task.id.endsWith('1'))?.status).toBe('paused');
    act(() => result.current.resume('00000000-0000-4000-8000-000000000001'));
    await waitFor(() => expect(starts.filter((id) => id.endsWith('1'))).toHaveLength(2));
  });

  it('defers an immediate resume until the paused transport releases its controller', async () => {
    let rejectFirst!: (error: unknown) => void;
    const transport = vi.fn(({ signal }: Parameters<typeof uploadFile>[0]) => {
      if (transport.mock.calls.length > 1) return Promise.resolve();
      return new Promise<void>((_resolve, reject) => {
        rejectFirst = reject;
        signal.addEventListener('abort', () => undefined, { once: true });
      });
    });
    const { result } = renderHook(() => useUploadQueue({ transport, multipartUpload: true, onCompleted: () => undefined }), { wrapper });
    act(() => result.current.enqueue('root', [new File([new Uint8Array(PART_SIZE)], 'fast-resume.bin')]));
    await waitFor(() => expect(transport).toHaveBeenCalledOnce());
    const id = result.current.tasks[0].id;

    act(() => {
      result.current.pause(id);
      result.current.resume(id);
    });
    expect(transport).toHaveBeenCalledOnce();
    act(() => rejectFirst(new UploadPausedError()));
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
  });

  it('warns before leaving only while a resumable server session remains', async () => {
    const transport = vi.fn((input: Parameters<typeof uploadFile>[0]) => new Promise<void>((_resolve, reject) => {
      input.control?.onSession?.(sessionView(input.file.size));
      input.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    }));
    const { result } = renderHook(() => useUploadQueue({ transport, multipartUpload: true, onCompleted: () => undefined }), { wrapper });
    act(() => result.current.enqueue('root', [new File([new Uint8Array(PART_SIZE)], 'leave.bin')]));
    await waitFor(() => expect(result.current.tasks[0]?.sessionId).toBe('session-123'));

    const activeEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(activeEvent);
    expect(activeEvent.defaultPrevented).toBe(true);

    act(() => result.current.cancel(result.current.tasks[0].id));
    await waitFor(() => expect(result.current.tasks[0]?.status).toBe('cancelled'));
    const finishedEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(finishedEvent);
    expect(finishedEvent.defaultPrevented).toBe(false);
  });
});

describe('upload panel', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <AppProviders>{children}</AppProviders>;
  it('invokes pause, resume, retry, and cancel with translated accessible controls', () => {
    const file = new File(['content'], '报告-非常长的文件名.bin');
    const base = { id: 'task-1', parentId: 'root', file, transport: 'multipart' as const, uploadedBytes: 2, progress: 40, sessionId: 'session-1' };
    const handlers = { onPause: vi.fn(), onResume: vi.fn(), onCancel: vi.fn(), onRetry: vi.fn(), onRemove: vi.fn(), onClearCompleted: vi.fn() };
    const { rerender } = render(<UploadPanel tasks={[{ ...base, status: 'uploading' }]} {...handlers} />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: `Pause ${file.name}` }));
    expect(handlers.onPause).toHaveBeenCalledWith('task-1');
    const pauseResume = screen.getByRole('button', { name: `Pause ${file.name}` });
    pauseResume.focus();

    rerender(<UploadPanel tasks={[{ ...base, status: 'paused' }]} {...handlers} />);
    const resume = screen.getByRole('button', { name: `Resume ${file.name}` });
    expect(resume).toHaveFocus();
    fireEvent.click(resume);
    fireEvent.click(screen.getByRole('button', { name: `Cancel ${file.name}` }));
    expect(handlers.onResume).toHaveBeenCalledWith('task-1');
    expect(handlers.onCancel).toHaveBeenCalledWith('task-1');

    rerender(<UploadPanel tasks={[{ ...base, status: 'failed', error: 'failed' }]} {...handlers} />);
    fireEvent.click(screen.getByRole('button', { name: `Retry ${file.name}` }));
    expect(handlers.onRetry).toHaveBeenCalledWith('task-1');
    expect(screen.getByText(file.name)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
  });
});
