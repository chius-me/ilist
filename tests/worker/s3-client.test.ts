import { describe, expect, it, vi } from 'vitest';
import { S3Client, S3Error } from '../../src/worker/drivers/s3/client';

const credentials = {
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
};

function createClient(fetcher: typeof fetch, addressingStyle: 'path' | 'virtual' = 'path') {
  return new S3Client({
    endpoint: 'https://objects.example.test/storage',
    region: 'auto',
    bucket: 'archive',
    addressingStyle,
    credentials,
    fetch: fetcher,
    now: () => new Date('2026-07-13T02:03:04.000Z'),
  });
}

function captureRequest(input: RequestInfo | URL, init?: RequestInit) {
  if (input instanceof Request) {
    return { url: input.url, method: input.method, headers: new Headers(input.headers) };
  }
  return {
    url: String(input),
    method: init?.method ?? 'GET',
    headers: new Headers(init?.headers),
  };
}

function rawPathname(url: string): string {
  const authorityStart = url.indexOf('://') + 3;
  const pathStart = url.indexOf('/', authorityStart);
  if (pathStart === -1) return '/';
  const queryStart = url.indexOf('?', pathStart);
  return url.slice(pathStart, queryStart === -1 ? undefined : queryStart);
}

async function readRequestBody(input: RequestInfo | URL, init?: RequestInit): Promise<string | null> {
  if (input instanceof Request) return input.text();
  if (init?.body === undefined || init.body === null) return null;
  return new Response(init.body).text();
}

describe('S3Client listings and XML', () => {
  it('encodes list options and parses contents, common prefixes, and an opaque continuation token', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
        <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
          <Name>archive</Name>
          <Prefix>照片/</Prefix>
          <KeyCount>2</KeyCount>
          <MaxKeys>2</MaxKeys>
          <IsTruncated>true</IsTruncated>
          <Contents>
            <Key>照片/a &amp; b.txt</Key>
            <LastModified>2026-07-12T10:00:00.000Z</LastModified>
            <ETag>&quot;etag-1&quot;</ETag>
            <Size>12</Size>
            <StorageClass>STANDARD</StorageClass>
          </Contents>
          <Contents>
            <Key>照片/雪.txt</Key>
            <LastModified>2026-07-12T11:00:00.000Z</LastModified>
            <ETag>&quot;etag-2&quot;</ETag>
            <Size>34</Size>
          </Contents>
          <CommonPrefixes><Prefix>照片/一/</Prefix></CommonPrefixes>
          <CommonPrefixes><Prefix>照片/二 &amp; 三/</Prefix></CommonPrefixes>
          <NextContinuationToken>AQEB+/==&amp;雪</NextContinuationToken>
        </ListBucketResult>`,
        { status: 200, headers: { 'content-type': 'application/xml' } },
      ),
    );
    const client = createClient(fetcher);

    const result = await client.listObjectsV2({
      prefix: '照片/2026 + 100%/',
      delimiter: '/',
      continuationToken: 'opaque+/= token &雪',
      maxKeys: 2,
    });

    const [input, init] = fetcher.mock.calls[0]!;
    const request = captureRequest(input, init);
    const url = new URL(request.url);
    expect(url.pathname).toBe('/storage/archive');
    expect([...url.searchParams.entries()]).toEqual([
      ['list-type', '2'],
      ['encoding-type', 'url'],
      ['prefix', '照片/2026 + 100%/'],
      ['delimiter', '/'],
      ['continuation-token', 'opaque+/= token &雪'],
      ['max-keys', '2'],
    ]);
    expect(request.headers.get('authorization')).toContain('AWS4-HMAC-SHA256 Credential=test-access-key/20260713/auto/s3/aws4_request');
    expect(result).toEqual({
      objects: [
        {
          key: '照片/a & b.txt',
          lastModified: '2026-07-12T10:00:00.000Z',
          etag: '"etag-1"',
          size: 12,
          storageClass: 'STANDARD',
        },
        {
          key: '照片/雪.txt',
          lastModified: '2026-07-12T11:00:00.000Z',
          etag: '"etag-2"',
          size: 34,
          storageClass: null,
        },
      ],
      commonPrefixes: ['照片/一/', '照片/二 & 三/'],
      nextContinuationToken: 'AQEB+/==&雪',
      isTruncated: true,
      keyCount: 2,
    });
  });

  it('decodes documented URL-encoded list fields once and preserves opaque token spaces', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(
        `<s3:ListBucketResult xmlns:s3="http://s3.amazonaws.com/doc/2006-03-01/">
          <s3:EncodingType> url </s3:EncodingType>
          <s3:KeyCount> 1 </s3:KeyCount>
          <s3:IsTruncated> false </s3:IsTruncated>
          <s3:Contents>
            <s3:Key>%20folder%20/%2520literal%2Bplus</s3:Key>
            <s3:Size> 7 </s3:Size>
          </s3:Contents>
          <s3:CommonPrefixes><s3:Prefix>%20folder%20/%20child%20/</s3:Prefix></s3:CommonPrefixes>
          <s3:NextContinuationToken>  opaque +/%20 token  </s3:NextContinuationToken>
        </s3:ListBucketResult>`,
        { status: 200, headers: { 'content-type': 'application/xml' } },
      ),
    );
    const client = createClient(fetcher);

    const result = await client.listObjectsV2();

    expect(result.objects[0]).toMatchObject({ key: ' folder /%20literal+plus', size: 7 });
    expect(result.commonPrefixes).toEqual([' folder / child /']);
    expect(result.nextContinuationToken).toBe('  opaque +/%20 token  ');
    const [input, init] = fetcher.mock.calls[0]!;
    expect(new URL(captureRequest(input, init).url).searchParams.get('encoding-type')).toBe('url');
  });

  it('normalizes missing list collections and rejects malformed XML', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 }),
      )
      .mockResolvedValueOnce(new Response('<ListBucketResult><Contents></ListBucketResult>', { status: 200 }));
    const client = createClient(fetcher);

    await expect(client.listObjectsV2()).resolves.toEqual({
      objects: [],
      commonPrefixes: [],
      nextContinuationToken: null,
      isTruncated: false,
      keyCount: 0,
    });
    await expect(client.listObjectsV2()).rejects.toThrow('Invalid S3 XML response');
  });

  it('parses structured S3 XML errors without exposing raw response bodies', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(
        `<?xml version="1.0"?><s3:Error xmlns:s3="http://s3.amazonaws.com/doc/2006-03-01/">
          <s3:Code> AccessDenied </s3:Code>
          <s3:Message> Access &amp; policy denied </s3:Message>
          <s3:Resource> /archive/private </s3:Resource>
          <s3:RequestId> request-123 </s3:RequestId>
          <s3:HostId>host-secret</s3:HostId>
        </s3:Error>`,
        { status: 403, headers: { 'content-type': 'application/xml' } },
      ),
    );
    const client = createClient(fetcher);

    const error = await client.getObject('private').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(S3Error);
    expect(error).toMatchObject({
      status: 403,
      code: 'AccessDenied',
      message: 'Access & policy denied',
      resource: '/archive/private',
      requestId: 'request-123',
    });
    expect(String(error)).not.toContain('host-secret');
  });
});

describe('S3Client object requests', () => {
  it('uses virtual-hosted encoded object URLs and implements all object methods', async () => {
    const seen: Array<{ method: string; url: string; headers: Headers; body: string | null }> = [];
    const downloadResponse = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('streamed body'));
          controller.close();
        },
      }),
      { status: 200, headers: { etag: 'download-etag' } },
    );
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = captureRequest(input, init);
      const body = request.method === 'PUT' && !request.headers.has('x-amz-copy-source')
        ? await readRequestBody(input, init)
        : null;
      seen.push({ ...request, body });
      if (request.method === 'GET') return downloadResponse;
      if (request.headers.has('x-amz-copy-source')) {
        return new Response(
          '<s3:CopyObjectResult xmlns:s3="http://s3.amazonaws.com/doc/2006-03-01/"><s3:ETag>"copy-etag"</s3:ETag><s3:LastModified>2026-07-13T02:03:04.000Z</s3:LastModified></s3:CopyObjectResult>',
          { status: 200 },
        );
      }
      return new Response(null, { status: request.method === 'DELETE' ? 204 : 200 });
    });
    const client = createClient(fetcher, 'virtual');
    const key = '照片/+ 100%/雪.txt';

    await client.headObject(key);
    const downloaded = await client.getObject(key, { range: 'bytes=2-8' });
    await client.putObject(key, new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('upload stream'));
        controller.close();
      },
    }), { contentType: 'text/plain; charset=utf-8' });
    await client.copyObject('来源/+ source.txt', key);
    await client.deleteObject(key);

    expect(downloaded).toBe(downloadResponse);
    await expect(downloaded.text()).resolves.toBe('streamed body');
    expect(seen.map(({ method }) => method)).toEqual(['HEAD', 'GET', 'PUT', 'PUT', 'DELETE']);
    expect(seen.map(({ url }) => new URL(url).pathname)).toEqual(Array(5).fill('/storage/%E7%85%A7%E7%89%87/%2B%20100%25/%E9%9B%AA.txt'));
    expect(new URL(seen[0]!.url).host).toBe('archive.objects.example.test');
    expect(seen[1]!.headers.get('range')).toBe('bytes=2-8');
    expect(seen[2]).toMatchObject({ body: 'upload stream' });
    expect(seen[2]!.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(seen[3]!.headers.get('x-amz-copy-source')).toBe('/archive/%E6%9D%A5%E6%BA%90/%2B%20source.txt');
    for (const request of seen) {
      expect(request.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
      expect(request.headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD');
    }
  });

  it('rejects a CopyObject error returned with HTTP 200', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(
        '<s3:Error xmlns:s3="http://s3.amazonaws.com/doc/2006-03-01/"><s3:Code>SlowDown</s3:Code><s3:Message>Copy failed after request acceptance</s3:Message><s3:RequestId>copy-1</s3:RequestId></s3:Error>',
        { status: 200, headers: { 'content-type': 'application/xml' } },
      ),
    );
    const client = createClient(fetcher);

    await expect(client.copyObject('source.txt', 'destination.txt')).rejects.toMatchObject({
      status: 200,
      code: 'SlowDown',
      message: 'Copy failed after request acceptance',
      requestId: 'copy-1',
    });
  });

  it('accepts a complete namespace-prefixed CopyObjectResult without consuming the returned body', async () => {
    const xml =
      '<s3:CopyObjectResult xmlns:s3="http://s3.amazonaws.com/doc/2006-03-01/"><s3:ETag>"etag"</s3:ETag><s3:LastModified>2026-07-13T02:03:04.000Z</s3:LastModified></s3:CopyObjectResult>';
    const fetcher = vi.fn<typeof fetch>(async () => new Response(xml, { status: 200 }));
    const client = createClient(fetcher);

    const response = await client.copyObject('source.txt', 'destination.txt');

    await expect(response.text()).resolves.toBe(xml);
  });

  it.each([
    ['empty', ''],
    ['malformed', '<CopyObjectResult><ETag><Unexpected /></ETag><LastModified>now</LastModified></CopyObjectResult>'],
    ['truncated', '<CopyObjectResult><ETag>"etag"</ETag>'],
    ['blank result', '<CopyObjectResult><ETag> </ETag><LastModified> </LastModified></CopyObjectResult>'],
    ['blank error', '<Error><Code> </Code><Message> </Message></Error>'],
    ['unknown', '<CompleteMultipartUploadResult><ETag>"etag"</ETag></CompleteMultipartUploadResult>'],
  ])('rejects an %s HTTP 200 CopyObject body', async (_case, xml) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(xml, { status: 200 }));
    const client = createClient(fetcher);

    await expect(client.copyObject('source.txt', 'destination.txt')).rejects.toThrow('Invalid S3 XML response');
  });

  it.each(['path', 'virtual'] as const)(
    'preserves period-only key segments across all object operations in %s addressing mode',
    async (addressingStyle) => {
      const seen: Array<{ url: string; method: string; headers: Headers }> = [];
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        const request = captureRequest(input, init);
        seen.push(request);
        if (request.headers.has('x-amz-copy-source')) {
          return new Response(
            '<CopyObjectResult><ETag>"etag"</ETag><LastModified>2026-07-13T02:03:04.000Z</LastModified></CopyObjectResult>',
            { status: 200 },
          );
        }
        return new Response(null, { status: request.method === 'DELETE' ? 204 : 200 });
      });
      const client = createClient(fetcher, addressingStyle);

      for (const key of ['folder/../target', 'folder/./target']) {
        await client.headObject(key);
        await client.getObject(key);
        await client.putObject(key, 'body');
        await client.copyObject(key, key);
        await client.deleteObject(key);
      }

      const root = addressingStyle === 'path' ? '/storage/archive' : '/storage';
      expect(seen.map(({ url }) => rawPathname(url))).toEqual([
        ...Array(5).fill(`${root}/folder/%2E%2E/target`),
        ...Array(5).fill(`${root}/folder/%2E/target`),
      ]);
      expect(seen.filter(({ headers }) => headers.has('x-amz-copy-source')).map(({ headers }) =>
        headers.get('x-amz-copy-source'),
      )).toEqual([
        '/archive/folder/%2E%2E/target',
        '/archive/folder/%2E/target',
      ]);
    },
  );
});

describe('S3Client multipart requests', () => {
  it('signs marked multipart requests, escapes sorted completion parts, and returns the completion ETag', async () => {
    const seen: Array<{ method: string; url: string; headers: Headers; body: string | null }> = [];
    const partBody = new Uint8Array([1, 2, 3]);
    const completionXml = '<CompleteMultipartUploadResult><ETag>"complete"</ETag><Location>https://objects.example.test/archive</Location><Bucket>archive</Bucket><Key>archive.bin</Key></CompleteMultipartUploadResult>';
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = captureRequest(input, init);
      seen.push({ ...request, body: await readRequestBody(input, init) });
      if (request.method === 'POST' && new URL(request.url).search === '?uploads') {
        return new Response('<InitiateMultipartUploadResult><UploadId>upload-123</UploadId></InitiateMultipartUploadResult>');
      }
      if (request.method === 'PUT') return new Response(null, { headers: { etag: '"etag-1"' } });
      if (request.method === 'POST') return new Response(completionXml);
      return new Response(null, { status: 204 });
    });
    const client = createClient(fetcher);

    await expect(client.createMultipartUpload('中文/archive.bin', 'application/octet-stream', 'session-marker')).resolves.toEqual({ uploadId: 'upload-123' });
    await expect(client.uploadPart('中文/archive.bin', 'upload-123', 1, partBody)).resolves.toEqual({ etag: '"etag-1"' });
    await expect(client.completeMultipartUpload('中文/archive.bin', 'upload-123', [
      { partNumber: 2, size: 10 * 1024 * 1024, etag: '"etag-2&<"' },
      { partNumber: 1, size: 10 * 1024 * 1024, etag: '"etag-1"' },
    ])).resolves.toEqual({ etag: '"complete"' });
    await client.abortMultipartUpload('中文/archive.bin', 'upload-123');

    expect(seen.map(({ method, url }) => [method, rawPathname(url), new URL(url).search])).toEqual([
      ['POST', '/storage/archive/%E4%B8%AD%E6%96%87/archive.bin', '?uploads'],
      ['PUT', '/storage/archive/%E4%B8%AD%E6%96%87/archive.bin', '?partNumber=1&uploadId=upload-123'],
      ['POST', '/storage/archive/%E4%B8%AD%E6%96%87/archive.bin', '?uploadId=upload-123'],
      ['DELETE', '/storage/archive/%E4%B8%AD%E6%96%87/archive.bin', '?uploadId=upload-123'],
    ]);
    expect(seen[0]!.headers.get('content-type')).toBe('application/octet-stream');
    expect(seen[0]!.headers.get('x-amz-meta-ilist-upload-marker')).toBe('session-marker');
    expect(seen[1]!.body).toBe('\u0001\u0002\u0003');
    expect(seen[2]!.body).toBe(
      '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;etag-1&quot;</ETag></Part><Part><PartNumber>2</PartNumber><ETag>&quot;etag-2&amp;&lt;&quot;</ETag></Part></CompleteMultipartUpload>',
    );
    for (const request of seen) expect(request.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
  });

  it('rejects a multipart part response without an ETag', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null));
    const client = createClient(fetcher);

    await expect(client.uploadPart('archive.bin', 'upload-123', 1, 'part')).rejects.toThrow('S3 upload part response is missing ETag');
  });

  it('forwards an upload-part AbortSignal to fetch', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      return new Response(null, { headers: { etag: '"part-etag"' } });
    });
    const client = createClient(fetcher);

    await client.uploadPart('archive.bin', 'upload-123', 1, 'part', { signal: controller.signal });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ['malformed XML', '<InitiateMultipartUploadResult><UploadId></InitiateMultipartUploadResult>'],
    ['missing UploadId', '<InitiateMultipartUploadResult><Bucket>archive</Bucket></InitiateMultipartUploadResult>'],
    ['blank UploadId', '<InitiateMultipartUploadResult><UploadId> </UploadId></InitiateMultipartUploadResult>'],
  ])('rejects a %s create-multipart response', async (_case, xml) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(xml));
    const client = createClient(fetcher);

    await expect(client.createMultipartUpload('archive.bin', null, 'session-marker')).rejects.toThrow('Invalid S3 XML response');
  });

  it('rejects an S3 completion error returned with HTTP 200', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(
      '<Error><Code>InvalidPart</Code><Message>Part does not match</Message><RequestId>complete-1</RequestId></Error>',
    ));
    const client = createClient(fetcher);

    await expect(client.completeMultipartUpload('archive.bin', 'upload-123', [
      { partNumber: 1, size: 1, etag: '"part-1"' },
    ])).rejects.toMatchObject({
      status: 200,
      code: 'InvalidPart',
      message: 'Part does not match',
      requestId: 'complete-1',
    });
  });

  it('retains only a validated retry-after duration on S3 errors', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        '<Error><Code>SlowDown</Code><Message>private upstream message</Message></Error>',
        { status: 503, headers: { 'retry-after': '30' } },
      ))
      .mockResolvedValueOnce(new Response(
        '<Error><Code>RequestTimeout</Code><Message>private upstream message</Message></Error>',
        { status: 503, headers: { 'retry-after': 'not-seconds' } },
      ));
    const client = createClient(fetcher);

    await expect(client.headObject('archive.bin')).rejects.toMatchObject({
      code: 'SlowDown',
      retryAfterSeconds: 30,
    });
    await expect(client.headObject('archive.bin')).rejects.toMatchObject({
      code: 'RequestTimeout',
      retryAfterSeconds: null,
    });
  });

  it('rejects duplicate and non-positive completion parts before issuing a request', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null));
    const client = createClient(fetcher);

    await expect(client.completeMultipartUpload('archive.bin', 'upload-123', [
      { partNumber: 1, size: 1, etag: '"one"' },
      { partNumber: 1, size: 1, etag: '"duplicate"' },
    ])).rejects.toThrow('S3 multipart part numbers must be unique positive integers');
    await expect(client.completeMultipartUpload('archive.bin', 'upload-123', [
      { partNumber: 0, size: 1, etag: '"zero"' },
    ])).rejects.toThrow('S3 multipart part numbers must be unique positive integers');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
