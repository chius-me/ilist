import { describe, expect, it } from 'vitest';
import { canonicalizeS3Request, signS3Request } from '../../src/worker/drivers/s3/signing';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('S3 Signature Version 4', () => {
  it('matches the official AWS S3 GET Object signing vector', async () => {
    const request = new Request('https://examplebucket.s3.amazonaws.com/test.txt', {
      headers: {
        range: 'bytes=0-9',
        'x-amz-content-sha256': EMPTY_SHA256,
      },
    });

    const signed = await signS3Request({
      request,
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      now: new Date('2013-05-24T00:00:00.000Z'),
    });

    expect(signed.headers.get('authorization')).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(signed.headers.get('x-amz-date')).toBe('20130524T000000Z');
  });

  it('canonicalizes encoded Unicode paths, duplicate query values, and header whitespace', () => {
    const request = new Request(
      'https://examplebucket.s3.amazonaws.com/photos/%E4%B8%AD%20%E6%96%87/%2B%25.txt' +
        '?z=last&marker=a%2Fb%2Bc%20d&empty=&dup=b&dup=a',
      {
        headers: {
          'my-header': 'value one   value two',
          'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
          'x-amz-date': '20260713T020304Z',
          'x-amz-meta-note': 'alpha\t beta   gamma',
        },
      },
    );

    expect(canonicalizeS3Request(request, 'UNSIGNED-PAYLOAD')).toEqual({
      canonicalRequest: [
        'GET',
        '/photos/%E4%B8%AD%20%E6%96%87/%2B%25.txt',
        'dup=a&dup=b&empty=&marker=a%2Fb%2Bc%20d&z=last',
        'host:examplebucket.s3.amazonaws.com',
        'my-header:value one value two',
        'x-amz-content-sha256:UNSIGNED-PAYLOAD',
        'x-amz-date:20260713T020304Z',
        'x-amz-meta-note:alpha beta gamma',
        '',
        'host;my-header;x-amz-content-sha256;x-amz-date;x-amz-meta-note',
        'UNSIGNED-PAYLOAD',
      ].join('\n'),
      signedHeaders: 'host;my-header;x-amz-content-sha256;x-amz-date;x-amz-meta-note',
    });
  });

  it('signs temporary credentials without including a stale authorization header', async () => {
    const request = new Request('https://s3.example.test/a//b?flag&space=a+b', {
      headers: {
        authorization: 'stale',
        'x-amz-meta-value': '  one\t two  ',
      },
    });

    const signed = await signS3Request({
      request,
      region: 'auto',
      credentials: {
        accessKeyId: 'access',
        secretAccessKey: 'secret',
        sessionToken: 'token+/=',
      },
      now: new Date('2026-07-13T02:03:04.999Z'),
    });

    expect(signed.headers.get('authorization')).toContain(
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-meta-value;x-amz-security-token',
    );
    expect(signed.headers.get('x-amz-security-token')).toBe('token+/=');
    expect(signed.headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD');
    expect(signed.headers.get('x-amz-date')).toBe('20260713T020304Z');
  });

  it('sorts canonical query names and values by encoded byte order instead of locale', () => {
    const request = new Request('https://s3.example.test/object?lower=1&Upper=2&%C3%A9=3&same=z&same=A');

    const { canonicalRequest } = canonicalizeS3Request(request, 'UNSIGNED-PAYLOAD');

    expect(canonicalRequest.split('\n')[2]).toBe('%C3%A9=3&Upper=2&lower=1&same=A&same=z');
  });

  it('distinguishes raw plus bytes from spaces while canonicalizing duplicate query values', () => {
    const request = new Request(
      'https://s3.example.test/object?value=raw+plus&value=encoded%2Bplus&value=space%20value&dup=b&dup=a&empty=',
    );

    const { canonicalRequest } = canonicalizeS3Request(request, 'UNSIGNED-PAYLOAD');

    expect(canonicalRequest.split('\n')[2]).toBe(
      'dup=a&dup=b&empty=&value=encoded%2Bplus&value=raw%2Bplus&value=space%20value',
    );
  });
});
