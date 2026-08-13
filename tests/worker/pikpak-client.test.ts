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
  it('refreshes an invalid captcha token once and retries the request', async () => {
    const mountId = await createPikPakMount();
    await putCredentials(workerEnv(), mountId, {
      auth: {
        accessToken: 'access-token', refreshToken: 'refresh-token', tokenType: 'Bearer',
        expiresAt: Date.now() + 3_600_000, userId: 'user-id',
      },
      provider: {
        deviceId: 'device-id', captchaToken: 'signin-captcha', captchaExpiresAt: Date.now() + 300_000,
      },
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'captcha_invalid' }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ captcha_token: 'drive-captcha', expires_in: 300 }))
      .mockResolvedValueOnce(Response.json({ files: [], next_page_token: '' }));
    const client = new PikPakClient(workerEnv(), mountId, fetcher);

    await expect(client.list('root')).resolves.toEqual({ files: [], next_page_token: '' });

    expect(fetcher).toHaveBeenCalledTimes(3);
    const captchaInit = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
    expect(captchaInit).toMatchObject({
      action: 'GET:/drive/v1/files', captcha_token: '', device_id: 'device-id', meta: { user_id: 'user-id' },
    });
    expect(new Headers(fetcher.mock.calls[2]![1]?.headers).get('x-captcha-token')).toBe('drive-captcha');
  });
});
