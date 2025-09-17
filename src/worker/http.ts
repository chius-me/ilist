export class HttpError extends Error {
  public readonly code: string;
  public readonly details: unknown;

  constructor(
    public readonly status: number,
    codeOrMessage: string,
    message?: string,
    details?: unknown,
  ) {
    const legacyCall = message === undefined;
    super(legacyCall ? codeOrMessage : message);
    this.name = 'HttpError';
    this.code = legacyCall ? `HTTP_${status}` : codeOrMessage;
    this.details = details;
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function ok(data: unknown = {}, init: ResponseInit = {}): Response {
  return json({ ok: true, data }, init);
}

export function fail(status: number, codeOrMessage: string, message?: string, details?: unknown): Response {
  const legacyCall = message === undefined;
  return json(
    {
      ok: false,
      error: {
        code: legacyCall ? `HTTP_${status}` : codeOrMessage,
        message: legacyCall ? codeOrMessage : message,
        ...(details === undefined ? {} : { details }),
      },
    },
    { status },
  );
}

export function requireSameOrigin(request: Request): void {
  const expected = new URL(request.url).origin;
  const actual = request.headers.get('origin');
  if (actual !== expected) {
    throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed');
  }
}

export function requireSameOriginWhenPresent(request: Request): void {
  if (request.headers.has('origin')) requireSameOrigin(request);
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

export function notFound(): Response {
  return fail(404, 'Not found');
}

export function noContent(headers?: HeadersInit): Response {
  return new Response(null, { status: 204, headers });
}
