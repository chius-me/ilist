import { HttpError, noContent, ok, readJson } from './http';
import {
  abortResumableUpload,
  completeResumableUpload,
  createResumableUpload,
  getResumableUpload,
  uploadResumablePart,
  type CreateUploadSessionBody,
} from './upload-service';
import type { Env } from './types';

const SESSION_PATH = '/api/admin/uploads/sessions';

function methodNotAllowed(): never {
  throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'UPLOAD_PART_INVALID', 'Upload route contains invalid encoding');
  }
}

export async function handleUploadRoutes(
  request: Request,
  env: Env,
  url: URL,
  ownerSessionId: string,
): Promise<Response | null> {
  if (url.pathname === SESSION_PATH) {
    if (request.method !== 'POST') return methodNotAllowed();
    const body = await readJson<unknown>(request);
    return ok(await createResumableUpload(env, ownerSessionId, body as CreateUploadSessionBody));
  }

  const partMatch = /^\/api\/admin\/uploads\/sessions\/([^/]+)\/parts\/([^/]+)$/.exec(url.pathname);
  if (partMatch) {
    if (request.method !== 'PUT') return methodNotAllowed();
    const id = decodePathSegment(partMatch[1]);
    const partNumberText = decodePathSegment(partMatch[2]);
    const partNumber = /^[0-9]+$/.test(partNumberText) ? Number(partNumberText) : Number.NaN;
    return ok(await uploadResumablePart(env, ownerSessionId, id, partNumber, request));
  }

  const completeMatch = /^\/api\/admin\/uploads\/sessions\/([^/]+)\/complete$/.exec(url.pathname);
  if (completeMatch) {
    if (request.method !== 'POST') return methodNotAllowed();
    return ok(await completeResumableUpload(
      env,
      ownerSessionId,
      decodePathSegment(completeMatch[1]),
    ));
  }

  const sessionMatch = /^\/api\/admin\/uploads\/sessions\/([^/]+)$/.exec(url.pathname);
  if (sessionMatch) {
    const id = decodePathSegment(sessionMatch[1]);
    if (request.method === 'GET') return ok(await getResumableUpload(env, ownerSessionId, id));
    if (request.method === 'DELETE') {
      await abortResumableUpload(env, ownerSessionId, id);
      return noContent();
    }
    return methodNotAllowed();
  }

  return null;
}
