import { jsonRequest, unwrap } from './client';

export const LARGE_UPLOAD_THRESHOLD_BYTES = 10 * 1024 * 1024;

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
const SESSION_PATH = '/api/admin/uploads/sessions';
const UPLOAD_SESSION_STATUSES = ['active', 'completing', 'completed', 'aborted'] as const;

export interface UploadSessionPart {
  partNumber: number;
  size: number;
}

export interface UploadSessionView {
  id: string;
  kind: 'multipart';
  partSize: number;
  size: number;
  uploadedParts: UploadSessionPart[];
  expiresAt: string;
  status: 'active' | 'completing' | 'completed' | 'aborted';
}

export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  partNumber?: number;
  partCount?: number;
}

export interface ResumableUploadControl {
  sessionId?: string;
  uploadedParts?: UploadSessionPart[];
  paused?: boolean;
  shouldPause?(): boolean;
  onSession?(session: UploadSessionView): void;
  onPartConfirmed?(part: UploadSessionPart): void;
}

export interface UploadFileInput {
  id: string;
  parentId: string;
  file: File;
  multipartUpload?: boolean;
  signal: AbortSignal;
  control?: ResumableUploadControl;
  onProgress(uploadedBytes: number, totalBytes: number): void;
}

export type UploadTransport = (input: UploadFileInput) => Promise<void>;

export class UploadPausedError extends Error {
  constructor() {
    super('Upload paused');
    this.name = 'UploadPausedError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isOpaqueSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && value.trim() === value
    && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function isFutureExpiration(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now();
}

function uploadResponseInvalid(): Error {
  return new Error('Upload session response is invalid');
}

function parseSessionPart(value: unknown): UploadSessionPart {
  if (!isRecord(value) || !isSafeNonNegativeInteger(value.partNumber) || value.partNumber < 1 || !isSafeNonNegativeInteger(value.size)) {
    throw uploadResponseInvalid();
  }
  return { partNumber: value.partNumber, size: value.size };
}

function parseUploadSession(value: unknown): UploadSessionView {
  if (!isRecord(value)
    || !isOpaqueSessionId(value.id)
    || value.kind !== 'multipart'
    || value.partSize !== LARGE_UPLOAD_THRESHOLD_BYTES
    || !isSafeNonNegativeInteger(value.size)
    || !Array.isArray(value.uploadedParts)
    || !isFutureExpiration(value.expiresAt)
    || !UPLOAD_SESSION_STATUSES.includes(value.status as UploadSessionView['status'])) {
    throw uploadResponseInvalid();
  }
  return {
    id: value.id,
    kind: 'multipart',
    partSize: value.partSize,
    size: value.size,
    uploadedParts: value.uploadedParts.map(parseSessionPart),
    expiresAt: value.expiresAt,
    status: value.status as UploadSessionView['status'],
  };
}

function xhrError(xhr: XMLHttpRequest): Error {
  try {
    const payload = JSON.parse(xhr.responseText) as { error?: { message?: unknown } };
    if (typeof payload.error?.message === 'string') return new Error(payload.error.message);
  } catch {
    // Use the status message when a failed upload response is not JSON.
  }
  return new Error(`Upload failed with ${xhr.status}`);
}

function abortError(): DOMException {
  return new DOMException('Upload cancelled', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function shouldPause(control: ResumableUploadControl | undefined): boolean {
  return control?.paused === true || control?.shouldPause?.() === true;
}

function contentType(file: Blob): string {
  return file.type || DEFAULT_CONTENT_TYPE;
}

function sendXhr(input: {
  method: 'PUT';
  url: string;
  body: Blob;
  contentType: string;
  signal: AbortSignal;
  onProgress?(loadedBytes: number): void;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const onSignalAbort = () => xhr.abort();
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener('abort', onSignalAbort);
      callback();
    };

    xhr.open(input.method, input.url);
    xhr.setRequestHeader('content-type', input.contentType);
    xhr.upload.onprogress = (event) => input.onProgress?.(Math.min(event.loaded, input.body.size));
    xhr.onerror = () => settle(() => reject(new Error('Network upload failed')));
    xhr.onabort = () => settle(() => reject(abortError()));
    xhr.onload = () => settle(() => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(xhrError(xhr));
        return;
      }
      try {
        const payload = JSON.parse(xhr.responseText) as { ok?: unknown; data?: unknown };
        if (payload.ok !== true || payload.data === undefined) throw uploadResponseInvalid();
        resolve(payload.data);
      } catch (error) {
        reject(error instanceof Error ? error : uploadResponseInvalid());
      }
    });
    input.signal.addEventListener('abort', onSignalAbort, { once: true });
    if (input.signal.aborted) {
      onSignalAbort();
      return;
    }
    try {
      // Sending the Blob directly lets the browser derive Content-Length.
      xhr.send(input.body);
    } catch (error) {
      settle(() => reject(error));
    }
  });
}

export function uploadSmallFile(input: UploadFileInput): Promise<void> {
  const query = new URLSearchParams({ parentId: input.parentId, name: input.file.name });
  return sendXhr({
    method: 'PUT',
    url: `/api/admin/files/${encodeURIComponent(input.id)}?${query}`,
    body: input.file,
    contentType: contentType(input.file),
    signal: input.signal,
    onProgress: (loadedBytes) => input.onProgress(loadedBytes, input.file.size),
  }).then(() => undefined);
}

export async function createUploadSession(input: {
  parentId: string;
  file: File;
}): Promise<UploadSessionView> {
  const result = await jsonRequest<unknown>(SESSION_PATH, {
    method: 'POST',
    body: JSON.stringify({
      parentId: input.parentId,
      name: input.file.name,
      size: input.file.size,
      contentType: input.file.type || null,
    }),
  });
  return parseUploadSession(result);
}

export async function getUploadSession(id: string, signal?: AbortSignal): Promise<UploadSessionView> {
  const result = await unwrap<unknown>(await fetch(`${SESSION_PATH}/${encodeURIComponent(id)}`, {
    signal,
    credentials: 'same-origin',
  }));
  return parseUploadSession(result);
}

export async function uploadSessionPart(input: {
  sessionId: string;
  partNumber: number;
  body: Blob;
  contentType: string;
  signal: AbortSignal;
  onProgress?(loadedBytes: number): void;
}): Promise<UploadSessionPart> {
  const result = await sendXhr({
    method: 'PUT',
    url: `${SESSION_PATH}/${encodeURIComponent(input.sessionId)}/parts/${input.partNumber}`,
    body: input.body,
    contentType: input.contentType,
    signal: input.signal,
    onProgress: input.onProgress,
  });
  return parseSessionPart(result);
}

export async function completeUploadSession(id: string, signal?: AbortSignal): Promise<void> {
  await jsonRequest<unknown>(`${SESSION_PATH}/${encodeURIComponent(id)}/complete`, {
    method: 'POST',
    signal,
  });
}

export async function abortUploadSession(id: string): Promise<void> {
  const response = await fetch(`${SESSION_PATH}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!response.ok) await unwrap<unknown>(response);
}

function sessionParts(session: UploadSessionView, file: File): Map<number, UploadSessionPart> {
  if (session.status !== 'active' || session.size !== file.size || session.partSize !== LARGE_UPLOAD_THRESHOLD_BYTES) throw uploadResponseInvalid();
  const partCount = Math.ceil(file.size / session.partSize);
  const parts = new Map<number, UploadSessionPart>();
  for (const part of session.uploadedParts) {
    const expectedSize = Math.min(session.partSize, file.size - (part.partNumber - 1) * session.partSize);
    if (part.partNumber > partCount || part.size !== expectedSize || parts.has(part.partNumber)) throw uploadResponseInvalid();
    parts.set(part.partNumber, part);
  }
  return parts;
}

function rememberSession(control: ResumableUploadControl | undefined, session: UploadSessionView, parts: Map<number, UploadSessionPart>): void {
  if (!control) return;
  control.sessionId = session.id;
  control.uploadedParts = [...parts.values()].sort((left, right) => left.partNumber - right.partNumber);
  control.onSession?.({ ...session, uploadedParts: control.uploadedParts });
}

async function uploadMultipartFile(input: UploadFileInput): Promise<void> {
  let sessionId = input.control?.sessionId;
  let cancellationObserved = input.signal.aborted;
  let abortPromise: Promise<void> | undefined;
  const observeCancellation = () => { cancellationObserved = true; };
  const abortServerSession = (): Promise<void> => {
    if (!sessionId) return Promise.resolve();
    if (!abortPromise) {
      abortPromise = abortUploadSession(sessionId).catch(() => undefined);
    }
    return abortPromise;
  };
  input.signal.addEventListener('abort', observeCancellation, { once: true });
  try {
    const session = sessionId
      ? await getUploadSession(sessionId, input.signal)
      : await createUploadSession({ parentId: input.parentId, file: input.file });
    sessionId = session.id;
    if (cancellationObserved || input.signal.aborted) {
      await abortServerSession();
      throw abortError();
    }
    const parts = sessionParts(session, input.file);
    rememberSession(input.control, session, parts);
    const partCount = Math.ceil(input.file.size / session.partSize);
    let committedBytes = [...parts.values()].reduce((total, part) => total + part.size, 0);
    input.onProgress(committedBytes, input.file.size);

    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      if (parts.has(partNumber)) continue;
      if (shouldPause(input.control)) throw new UploadPausedError();
      const start = (partNumber - 1) * session.partSize;
      const body = input.file.slice(start, Math.min(start + session.partSize, input.file.size), input.file.type);
      const part = await uploadSessionPart({
        sessionId: session.id,
        partNumber,
        body,
        contentType: contentType(input.file),
        signal: input.signal,
        onProgress: (loadedBytes) => input.onProgress(committedBytes + loadedBytes, input.file.size),
      });
      if (part.partNumber !== partNumber || part.size !== body.size) throw uploadResponseInvalid();
      parts.set(partNumber, part);
      committedBytes += part.size;
      rememberSession(input.control, session, parts);
      input.control?.onPartConfirmed?.(part);
      input.onProgress(committedBytes, input.file.size);
    }

    if (parts.size !== partCount) throw uploadResponseInvalid();
    await completeUploadSession(session.id, input.signal);
  } catch (error) {
    if (isAbortError(error) && input.signal.aborted) {
      if (shouldPause(input.control)) throw new UploadPausedError();
      await abortServerSession();
    }
    throw error;
  } finally {
    input.signal.removeEventListener('abort', observeCancellation);
  }
}

export const uploadFile: UploadTransport = async (input) => {
  if (!input.multipartUpload || input.file.size < LARGE_UPLOAD_THRESHOLD_BYTES) {
    await uploadSmallFile(input);
    return;
  }
  await uploadMultipartFile(input);
};

// Keep the pre-resumable transport name available until Task 7 wires capabilities through the queue.
export const uploadFileWithProgress: UploadTransport = uploadFile;
