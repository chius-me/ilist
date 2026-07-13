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

    const request = fetcher.mock.calls[0]?.[0] as Request;
    const url = new URL(request.url);
    expect(url.pathname).toBe('/storage/archive');
    expect([...url.searchParams.entries()]).toEqual([
      ['list-type', '2'],
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
        `<?xml version="1.0"?><Error>
          <Code>AccessDenied</Code>
          <Message>Access &amp; policy denied</Message>
          <Resource>/archive/private</Resource>
          <RequestId>request-123</RequestId>
          <HostId>host-secret</HostId>
        </Error>`,
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
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const request = input as Request;
      const body = request.method === 'PUT' && !request.headers.has('x-amz-copy-source') ? await request.text() : null;
      seen.push({ method: request.method, url: request.url, headers: new Headers(request.headers), body });
      if (request.method === 'GET') return downloadResponse;
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
        '<Error><Code>SlowDown</Code><Message>Copy failed after request acceptance</Message><RequestId>copy-1</RequestId></Error>',
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
});
