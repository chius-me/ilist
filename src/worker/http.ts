export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
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

export function fail(status: number, message: string): Response {
  return json({ ok: false, error: { message } }, { status });
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
