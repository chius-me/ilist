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
  const payload = (await response.json()) as {
    ok: boolean;
    data?: T;
    error?: { code?: string; message?: string; details?: unknown };
  };
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new ApiError(
      response.status,
      payload.error?.code ?? `HTTP_${response.status}`,
      payload.error?.message ?? 'Request failed',
      payload.error?.details,
    );
  }
  return payload.data;
}

export async function jsonRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  return unwrap<T>(await fetch(url, { ...init, headers, credentials: 'same-origin' }));
}
