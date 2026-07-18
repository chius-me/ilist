import { HttpError } from './http';

const INLINE_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
]);

/** PDF may only be inlined when the caller explicitly requests a sandboxed preview. */
const SANDBOXED_PREVIEW_CONTENT_TYPES = new Set([
  'application/pdf',
]);

const TEXT_PREVIEW_CONTENT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/css',
  'text/javascript',
  'application/json',
  'application/xml',
  'text/xml',
  'text/html', // still never inlined; kept for size-bound classification only
]);

export const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;

const PRESERVED_HEADERS = [
  'accept-ranges',
  'content-range',
  'content-length',
  'etag',
  'last-modified',
] as const;

/** Default file policy: no embedding. */
const FILE_CONTENT_SECURITY_POLICY = "sandbox; default-src 'none'; frame-ancestors 'none'";
/**
 * Sandboxed PDF preview is embedded by the same-origin explorer iframe.
 * Keep script-hostile sandbox defaults; only allow same-origin framing.
 */
const SANDBOXED_PDF_CONTENT_SECURITY_POLICY = "sandbox; default-src 'none'; frame-ancestors 'self'";

export interface SecureFileResponseOptions {
  filename: string;
  contentType: string | null;
  download: boolean;
  /** When true and content is PDF, serve inline under the sandbox CSP. */
  sandboxedPreview?: boolean;
  publicFile: boolean;
  method: string;
}

function normalizeContentType(contentType: string | null): string | null {
  const normalized = contentType?.split(';', 1)[0].trim().toLowerCase();
  return normalized || null;
}

function encodedFilename(filename: string): string {
  const name = filename || 'download';
  const attrChars = new Set('!#$&+-.^_`|~');
  return [...new TextEncoder().encode(name)].map((byte) => {
    const character = String.fromCharCode(byte);
    return /[A-Za-z0-9]/.test(character) || attrChars.has(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

export function isTextPreviewContentType(contentType: string | null): boolean {
  const normalized = normalizeContentType(contentType);
  if (!normalized) return false;
  if (TEXT_PREVIEW_CONTENT_TYPES.has(normalized)) return true;
  return normalized.startsWith('text/');
}

/**
 * Reject unbounded text previews when Content-Length is known and exceeds the cap.
 * Unknown lengths fail open at the transport layer; the UI still bounds reads.
 */
export function assertTextPreviewSizeAllowed(contentLengthHeader: string | null): void {
  if (contentLengthHeader === null) return;
  if (!/^(0|[1-9][0-9]*)$/.test(contentLengthHeader)) {
    throw new Error('TEXT_PREVIEW_TOO_LARGE');
  }
  const size = Number(contentLengthHeader);
  if (!Number.isSafeInteger(size) || size > TEXT_PREVIEW_MAX_BYTES) {
    throw new Error('TEXT_PREVIEW_TOO_LARGE');
  }
}

function baseSecurityHeaders(options: {
  contentType: string;
  disposition: 'inline' | 'attachment';
  filename: string;
  publicFile: boolean;
  csp: string;
  frameSameOrigin: boolean;
}): Headers {
  const headers = new Headers();
  headers.set('content-type', options.contentType);
  headers.set('content-disposition', `${options.disposition}; filename*=UTF-8''${encodedFilename(options.filename)}`);
  headers.set('cache-control', options.publicFile ? 'public, max-age=3600' : 'private, no-store');
  headers.set('content-security-policy', options.csp);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('cross-origin-resource-policy', 'same-origin');
  if (options.frameSameOrigin) headers.set('x-frame-options', 'SAMEORIGIN');
  return headers;
}

export function secureFileResponse(
  response: Response,
  options: SecureFileResponseOptions,
): Response {
  const sourceType = normalizeContentType(options.contentType);
  const sandboxedPdf = Boolean(options.sandboxedPreview)
    && !options.download
    && sourceType !== null
    && SANDBOXED_PREVIEW_CONTENT_TYPES.has(sourceType);
  const inline = !options.download
    && sourceType !== null
    && (INLINE_CONTENT_TYPES.has(sourceType) || sandboxedPdf);

  // Non-download text responses (previews) fail closed when the known body is too large.
  // Ranged previews report Content-Length for the range only, so partial reads still work.
  if (!options.download && isTextPreviewContentType(sourceType)) {
    try {
      assertTextPreviewSizeAllowed(response.headers.get('content-length'));
    } catch {
      throw new HttpError(413, 'TEXT_PREVIEW_TOO_LARGE', 'Text is too large to preview safely');
    }
  }

  const headers = baseSecurityHeaders({
    contentType: inline ? sourceType! : 'application/octet-stream',
    disposition: inline ? 'inline' : 'attachment',
    filename: options.filename,
    publicFile: options.publicFile,
    csp: sandboxedPdf ? SANDBOXED_PDF_CONTENT_SECURITY_POLICY : FILE_CONTENT_SECURITY_POLICY,
    frameSameOrigin: sandboxedPdf,
  });

  for (const name of PRESERVED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  const bodyAllowed = options.method.toUpperCase() !== 'HEAD' && ![204, 205, 304].includes(response.status);
  return new Response(bodyAllowed ? response.body : null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
