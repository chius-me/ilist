import { describe, expect, it } from 'vitest';
import {
  assertTextPreviewSizeAllowed,
  secureFileResponse,
  TEXT_PREVIEW_MAX_BYTES,
} from '../../src/worker/file-response-security';
import { withApplicationSecurityHeaders } from '../../src/worker/response-security';

const FILE_CSP = "sandbox; default-src 'none'; frame-ancestors 'none'";
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

describe('secureFileResponse', () => {
  it.each([
    ['text/html', 'application/octet-stream', 'attachment'],
    ['image/svg+xml', 'application/octet-stream', 'attachment'],
    ['application/xml', 'application/octet-stream', 'attachment'],
    ['application/pdf', 'application/octet-stream', 'attachment'],
    [null, 'application/octet-stream', 'attachment'],
    ['image/png', 'image/png', 'inline'],
    ['IMAGE/JPEG; charset=binary', 'image/jpeg', 'inline'],
    ['image/gif', 'image/gif', 'inline'],
    ['image/webp', 'image/webp', 'inline'],
    ['image/avif', 'image/avif', 'inline'],
    ['video/mp4', 'video/mp4', 'inline'],
    ['video/webm', 'video/webm', 'inline'],
    ['audio/mpeg', 'audio/mpeg', 'inline'],
    ['audio/ogg', 'audio/ogg', 'inline'],
    ['audio/wav', 'audio/wav', 'inline'],
  ])('applies a safe response policy to %s', (sourceType, expectedType, disposition) => {
    const response = secureFileResponse(new Response('body'), {
      filename: '报告 2026.html',
      contentType: sourceType,
      download: false,
      publicFile: true,
      method: 'GET',
    });

    expect(response.headers.get('content-type')).toBe(expectedType);
    expect(response.headers.get('content-disposition')).toBe(`${disposition}; filename*=UTF-8''%E6%8A%A5%E5%91%8A%202026.html`);
    expect(response.headers.get('content-security-policy')).toBe(FILE_CSP);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('allows PDF only through the sandboxed preview path with embeddable CSP', () => {
    const attachment = secureFileResponse(new Response('%PDF'), {
      filename: 'doc.pdf',
      contentType: 'application/pdf',
      download: false,
      publicFile: false,
      method: 'GET',
    });
    expect(attachment.headers.get('content-type')).toBe('application/octet-stream');
    expect(attachment.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(attachment.headers.get('content-security-policy')).toBe(FILE_CSP);
    expect(attachment.headers.get('x-frame-options')).toBeNull();

    const preview = secureFileResponse(new Response('%PDF'), {
      filename: 'doc.pdf',
      contentType: 'application/pdf',
      download: false,
      sandboxedPreview: true,
      publicFile: false,
      method: 'GET',
    });
    expect(preview.headers.get('content-type')).toBe('application/pdf');
    expect(preview.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(preview.headers.get('content-security-policy')).toBe(
      "sandbox; default-src 'none'; frame-ancestors 'self'",
    );
    expect(preview.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it('fails closed when text preview content-length exceeds the bound', () => {
    expect(() => assertTextPreviewSizeAllowed(String(TEXT_PREVIEW_MAX_BYTES))).not.toThrow();
    expect(() => assertTextPreviewSizeAllowed(String(TEXT_PREVIEW_MAX_BYTES + 1))).toThrow('TEXT_PREVIEW_TOO_LARGE');
    expect(() => assertTextPreviewSizeAllowed('not-a-number')).toThrow('TEXT_PREVIEW_TOO_LARGE');
  });

  it('rejects oversized text responses on the secure file path for non-download previews', () => {
    expect(() => secureFileResponse(new Response('x'.repeat(10), {
      headers: { 'content-length': String(TEXT_PREVIEW_MAX_BYTES + 1) },
    }), {
      filename: 'notes.txt',
      contentType: 'text/plain',
      download: false,
      publicFile: false,
      method: 'GET',
    })).toThrow(/TEXT_PREVIEW_TOO_LARGE|too large/i);

    const allowed = secureFileResponse(new Response('ok', {
      headers: { 'content-length': '2' },
    }), {
      filename: 'notes.txt',
      contentType: 'text/plain',
      download: false,
      publicFile: false,
      method: 'GET',
    });
    expect(allowed.headers.get('content-type')).toBe('application/octet-stream');
    expect(allowed.headers.get('content-disposition')).toMatch(/^attachment;/);

    const downloadLarge = secureFileResponse(new Response('x'.repeat(10), {
      headers: { 'content-length': String(TEXT_PREVIEW_MAX_BYTES + 1) },
    }), {
      filename: 'notes.txt',
      contentType: 'text/plain',
      download: true,
      publicFile: false,
      method: 'GET',
    });
    expect(downloadLarge.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('forces explicit downloads and filters untrusted provider headers', () => {
    const upstream = new Response('partial', {
      status: 206,
      headers: {
        'accept-ranges': 'bytes',
        'cache-control': 'public, max-age=999999',
        'content-disposition': 'inline; filename=provider.html',
        'content-length': '7',
        'content-range': 'bytes 0-6/20',
        'content-security-policy': "script-src *",
        'content-type': 'text/html',
        etag: '"trusted-etag"',
        'last-modified': 'Wed, 01 Jul 2026 00:00:00 GMT',
        'set-cookie': 'provider=secret',
        'x-provider-debug': 'internal',
      },
    });

    const response = secureFileResponse(upstream, {
      filename: 'photo.png',
      contentType: 'image/png',
      download: true,
      publicFile: false,
      method: 'GET',
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe('bytes 0-6/20');
    expect(response.headers.get('content-length')).toBe('7');
    expect(response.headers.get('etag')).toBe('"trusted-etag"');
    expect(response.headers.get('last-modified')).toBe('Wed, 01 Jul 2026 00:00:00 GMT');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-provider-debug')).toBeNull();
    expect(response.headers.get('content-security-policy')).toBe(FILE_CSP);
  });

  it('preserves conditional status and strips the body for HEAD', async () => {
    const conditional = secureFileResponse(new Response(null, {
      status: 304,
      headers: { etag: '"current"' },
    }), {
      filename: 'movie.mp4', contentType: 'video/mp4', download: false, publicFile: true, method: 'GET',
    });
    const head = secureFileResponse(new Response('not returned', {
      headers: { 'content-length': '12' },
    }), {
      filename: 'movie.mp4', contentType: 'video/mp4', download: false, publicFile: true, method: 'HEAD',
    });

    expect(conditional.status).toBe(304);
    expect(conditional.headers.get('etag')).toBe('"current"');
    expect(head.headers.get('content-length')).toBe('12');
    await expect(head.text()).resolves.toBe('');
  });
});

describe('withApplicationSecurityHeaders', () => {
  it('applies the application policy and preserves application headers', () => {
    const response = withApplicationSecurityHeaders(
      new Response('{}', { headers: { 'content-type': 'application/json', 'set-cookie': 'session=value' } }),
      new Request('https://ilist.chius.cc/api/admin/login'),
    );

    expect(response.headers.get('content-security-policy')).toBe(APP_CSP);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('set-cookie')).toBe('session=value');
  });

  it('does not add HSTS to HTTP development responses', () => {
    const response = withApplicationSecurityHeaders(
      new Response('app'),
      new Request('http://localhost:8787/'),
    );
    expect(response.headers.get('strict-transport-security')).toBeNull();
  });
});
