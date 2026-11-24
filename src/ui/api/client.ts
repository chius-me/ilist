export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function unwrap<T>(response: Response): Promise<T> {
  let payload: {
    ok?: unknown;
    data?: T;
    error?: { code?: unknown; message?: unknown; details?: unknown };
  } | null = null;

  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      payload = parsed as {
        ok?: unknown;
        data?: T;
        error?: { code?: unknown; message?: unknown; details?: unknown };
      };
    }
  } catch {
    payload = null;
  }

  if (!response.ok || payload?.ok !== true || payload.data === undefined) {
    const code = typeof payload?.error?.code === 'string' ? payload.error.code : `HTTP_${response.status}`;
    const message = typeof payload?.error?.message === 'string'
      ? payload.error.message
      : response.statusText || 'Request failed';
    throw new ApiError(response.status, code, message, payload?.error?.details);
  }
  return payload.data;
}

export async function jsonRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  return unwrap<T>(await fetch(url, { ...init, headers, credentials: 'same-origin' }));
}
