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

const PRESERVED_HEADERS = [
  'accept-ranges',
  'content-range',
  'content-length',
  'etag',
  'last-modified',
] as const;

const FILE_CONTENT_SECURITY_POLICY = "sandbox; default-src 'none'; frame-ancestors 'none'";

export interface SecureFileResponseOptions {
  filename: string;
  contentType: string | null;
  download: boolean;
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

export function secureFileResponse(
  response: Response,
  options: SecureFileResponseOptions,
): Response {
  const sourceType = normalizeContentType(options.contentType);
  const inline = !options.download && sourceType !== null && INLINE_CONTENT_TYPES.has(sourceType);
  const headers = new Headers();

  for (const name of PRESERVED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  headers.set('content-type', inline ? sourceType : 'application/octet-stream');
  headers.set('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodedFilename(options.filename)}`);
  headers.set('cache-control', options.publicFile ? 'public, max-age=3600' : 'private, no-store');
  headers.set('content-security-policy', FILE_CONTENT_SECURITY_POLICY);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('cross-origin-resource-policy', 'same-origin');

  const bodyAllowed = options.method.toUpperCase() !== 'HEAD' && ![204, 205, 304].includes(response.status);
  return new Response(bodyAllowed ? response.body : null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
