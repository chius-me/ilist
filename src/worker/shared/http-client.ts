import { HttpError } from '../http';

export const DEFAULT_METADATA_TIMEOUT_MS = 30_000;
export const DEFAULT_TRANSFER_TIMEOUT_MS = 120_000;

const VALID_RANGE_PATTERN = /^bytes=(?:\d+-\d*|-\d+)$/;
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 5_000;

export interface FetchWithRetryOptions extends RequestInit {
  timeoutMs?: number;
  maxRetries?: number;
  idempotent?: boolean;
}

export function validRange(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!VALID_RANGE_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export function assertValidRange(value: string | null): string | null {
  if (value === null) return null;
  const checked = validRange(value);
  if (checked === null) {
    throw new HttpError(400, 'INVALID_RANGE', 'Range header is invalid');
  }
  return checked;
}

export function retryAfterSeconds(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const seconds = Number(value.trim());
  return Number.isSafeInteger(seconds) ? seconds : null;
}

export function retryAfterDetails(value: string | null): { retryAfter: number } | undefined {
  const seconds = retryAfterSeconds(value);
  return seconds === null ? undefined : { retryAfter: seconds };
}

export function safeUpstreamResponse(response: Response, headerNames: readonly string[]): Response {
  const headers = new Headers();
  for (const name of headerNames) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function headMetadataResponse(item: {
  size: number | null;
  contentType: string | null;
  etag: string | null;
  modifiedAt: string | null;
}): Response {
  const headers = new Headers();
  headers.set('accept-ranges', 'bytes');
  if (item.size !== null) headers.set('content-length', String(item.size));
  headers.set('content-type', item.contentType ?? 'application/octet-stream');
  if (item.etag) headers.set('etag', item.etag);
  if (item.modifiedAt) {
    const timestamp = Date.parse(item.modifiedAt);
    if (Number.isFinite(timestamp)) {
      headers.set('last-modified', new Date(timestamp).toUTCString());
    }
  }
  return new Response(null, { status: 200, headers });
}

function timeoutAbortSignal(timeoutMs: number): { signal?: AbortSignal; cleanup: () => void } {
  if (timeoutMs <= 0) return { cleanup: () => undefined };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return { signal: AbortSignal.timeout(timeoutMs), cleanup: () => undefined };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}

function composeSignals(
  callerSignal: AbortSignal | null | undefined,
  timeoutSignal: AbortSignal | undefined,
): { signal?: AbortSignal; cleanup: () => void } {
  if (!callerSignal && !timeoutSignal) return { cleanup: () => undefined };
  if (!callerSignal) return { signal: timeoutSignal, cleanup: () => undefined };
  if (!timeoutSignal) return { signal: callerSignal, cleanup: () => undefined };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([callerSignal, timeoutSignal]), cleanup: () => undefined };
  }
  const controller = new AbortController();
  const abortFrom = (source: AbortSignal) => () => controller.abort(source.reason);
  const onCaller = abortFrom(callerSignal);
  const onTimeout = abortFrom(timeoutSignal);
  if (callerSignal.aborted) {
    controller.abort(callerSignal.reason);
  } else if (timeoutSignal.aborted) {
    controller.abort(timeoutSignal.reason);
  } else {
    callerSignal.addEventListener('abort', onCaller, { once: true });
    timeoutSignal.addEventListener('abort', onTimeout, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      callerSignal.removeEventListener('abort', onCaller);
      timeoutSignal.removeEventListener('abort', onTimeout);
    },
  };
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isIdempotentMethod(method: string | undefined): boolean {
  const upper = (method ?? 'GET').toUpperCase();
  return upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS' || upper === 'PUT' || upper === 'DELETE';
}

export async function fetchWithRetry(
  fetcher: typeof fetch,
  input: string | URL,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_METADATA_TIMEOUT_MS, maxRetries = 2, signal: callerSignal, idempotent: idempotentOverride, ...init } = options;
  const idempotent = idempotentOverride ?? isIdempotentMethod(init.method);
  const unbufferedStream = init.body instanceof ReadableStream;
  const attempts = unbufferedStream ? 1 : Math.max(1, maxRetries + 1);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (callerSignal?.aborted) {
      throw callerSignal.reason ?? new DOMException('Aborted', 'AbortError');
    }

    const timeout = timeoutAbortSignal(timeoutMs);
    const combined = composeSignals(callerSignal, timeout.signal);
    let response: Response;
    try {
      response = await fetcher.call(globalThis, input, {
        ...init,
        ...(combined.signal ? { signal: combined.signal } : {}),
      });
    } catch (error) {
      combined.cleanup();
      timeout.cleanup();
      const isLast = attempt >= attempts - 1;
      const isAbortOrTimeout = callerSignal?.aborted
        || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'));
      if (isLast || isAbortOrTimeout || !idempotent) {
        throw error;
      }
      await sleep(50 * 2 ** attempt + Math.floor(Math.random() * 25), callerSignal);
      continue;
    }

    combined.cleanup();
    timeout.cleanup();

    const shouldRetryStatus = TRANSIENT_STATUSES.has(response.status)
      && (response.status === 429 || response.status === 503 || idempotent);
    if (attempt >= attempts - 1 || !shouldRetryStatus) {
      return response;
    }

    const explicitRetry = retryAfterSeconds(response.headers.get('retry-after'));
    if (explicitRetry !== null && explicitRetry > MAX_RETRY_DELAY_MS / 1000) {
      return response;
    }

    void response.body?.cancel();
    const delayMs = explicitRetry !== null
      ? Math.min(explicitRetry * 1000, MAX_RETRY_DELAY_MS)
      : Math.min(50 * 2 ** attempt + Math.floor(Math.random() * 25), MAX_RETRY_DELAY_MS);
    await sleep(delayMs, callerSignal);
  }

  throw new Error('Unreachable retry state');
}
