import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { putCredentials } from '../../src/worker/credentials';
import { PikPakClient } from '../../src/worker/drivers/pikpak/client';
import { createMount } from '../../src/worker/mounts';
import type { Env } from '../../src/worker/types';

const clientEnv = {} as Env;
const workerEnv = () => env as unknown as Env;

async function createPikPakMount(): Promise<string> {
  const mount = await createMount(workerEnv().DB, {
    name: 'PikPak', mountPath: '/pikpak', driverType: 'pikpak', provider: 'pikpak', config: { useTrash: true },
  });
  return mount.id;
}

beforeEach(async () => {
  await workerEnv().DB.prepare('DELETE FROM storage_credentials').run();
  await workerEnv().DB.prepare('DELETE FROM mounts').run();
});

describe('PikPak client downloads', () => {
  it('proxies the original HTTPS URL and forwards only the Range request header', async () => {
    const upstream = new Response('partial', {
      status: 206,
      headers: { 'content-range': 'bytes 10-16/100' },
    });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => upstream);
    const client = new PikPakClient(clientEnv, 'mount-id', fetcher);
    const request = new Request('https://ilist.example/api/files/download', {
      headers: { authorization: 'private-session', range: 'bytes=10-16', cookie: 'admin=private' },
    });

    await expect(client.download({
      id: 'file-id', parent_id: 'root', name: 'file.bin', kind: 'drive#file', size: '100',
      links: { 'application/octet-stream': { url: 'https://download.example/file.bin' } },
    }, request)).resolves.toBe(upstream);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://download.example/file.bin');
    const headers = new Headers(init?.headers);
    expect(headers.get('range')).toBe('bytes=10-16');
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
  });

  it('rejects insecure or missing original download links', async () => {
    const client = new PikPakClient(clientEnv, 'mount-id', vi.fn());
    const request = new Request('https://ilist.example/api/files/download');
    const file = { id: 'file-id', parent_id: 'root', name: 'file.bin', kind: 'drive#file' as const, size: '100' };

    await expect(client.download(file, request)).rejects.toMatchObject({ code: 'PIKPAK_DOWNLOAD_UNAVAILABLE' });
    await expect(client.download({ ...file, web_content_link: 'http://download.example/file.bin' }, request))
      .rejects.toMatchObject({ code: 'PIKPAK_DOWNLOAD_UNAVAILABLE' });
  });
});

describe('PikPak client API requests', () => {
  it('uses the OpenList Worker compatible .net list protocol', async () => {
    const mountId = await createPikPakMount();
    await putCredentials(workerEnv(), mountId, {
      auth: {
        accessToken: 'access-token', refreshToken: 'refresh-token', tokenType: 'Bearer',
        expiresAt: Date.now() + 3_600_000,
      },
    });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ files: [], next_page_token: '' }));
    const client = new PikPakClient(workerEnv(), mountId, fetcher);

    await expect(client.list('root')).resolves.toEqual({ files: [], next_page_token: '' });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const initialListUrl = new URL(String(fetcher.mock.calls[0]![0]));
    expect(initialListUrl.hostname).toBe('api-drive.mypikpak.net');
    expect(initialListUrl.searchParams.get('parent_id')).toBe('');
    expect(initialListUrl.searchParams.has('page_token')).toBe(true);
    expect(initialListUrl.searchParams.get('page_token')).toBe('');
    expect(initialListUrl.searchParams.get('with_audit')).toBe('false');
    expect(initialListUrl.searchParams.has('limit')).toBe(false);
    const headers = new Headers(fetcher.mock.calls[0]![1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer access-token');
    expect(headers.get('x-captcha-token')).toBeNull();
    expect(headers.get('x-device-id')).toBeNull();
    expect(headers.get('x-client-id')).toBeNull();
  });

  it('requests fetch-ready metadata before an original download', async () => {
    const mountId = await createPikPakMount();
    await putCredentials(workerEnv(), mountId, {
      auth: {
        accessToken: 'access-token', refreshToken: 'refresh-token', tokenType: 'Bearer',
        expiresAt: Date.now() + 3_600_000,
      },
    });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      id: 'file-id', parent_id: '', name: 'file.bin', kind: 'drive#file', web_content_link: 'https://download.example/file.bin',
    }));
    const client = new PikPakClient(workerEnv(), mountId, fetcher);

    await expect(client.downloadInfo('file-id')).resolves.toMatchObject({ id: 'file-id' });

    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.origin).toBe('https://api-drive.mypikpak.net');
    expect(url.pathname).toBe('/drive/v1/files/file-id');
    expect(url.searchParams.get('_magic')).toBe('2021');
    expect(url.searchParams.get('usage')).toBe('FETCH');
    expect(url.searchParams.get('thumbnail_size')).toBe('SIZE_LARGE');
  });

  it('returns only stable upstream diagnostics and omits provider descriptions', async () => {
    const mountId = await createPikPakMount();
    await putCredentials(workerEnv(), mountId, {
      auth: {
        accessToken: 'access-token', refreshToken: 'refresh-token', tokenType: 'Bearer',
        expiresAt: Date.now() + 3_600_000,
      },
    });
    const fetcher = vi.fn(async () => Response.json({
      error: 'invalid_request', error_code: 4003, error_description: 'private provider detail',
    }, { status: 400 }));
    const client = new PikPakClient(workerEnv(), mountId, fetcher);

    const error = await client.list('root').catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: 'PIKPAK_UPSTREAM_FAILED',
      details: { upstreamStatus: 400, upstreamReason: 'invalid_request', upstreamCode: 4003 },
    });
    expect(JSON.stringify(error)).not.toContain('private provider detail');
  });
});
