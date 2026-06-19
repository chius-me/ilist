import { describe, expect, it } from 'vitest';
import { secureFileResponse } from '../../src/worker/file-response-security';
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
