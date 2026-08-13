import { describe, expect, it, vi } from 'vitest';
import { PikPakClient } from '../../src/worker/drivers/pikpak/client';
import type { Env } from '../../src/worker/types';

const clientEnv = {} as Env;

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
