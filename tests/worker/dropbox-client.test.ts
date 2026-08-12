import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { DropboxClient } from '../../src/worker/drivers/dropbox/client';
import type { DropboxMetadata } from '../../src/worker/drivers/dropbox/types';
import type { Env } from '../../src/worker/types';

const workerEnv = () => env as unknown as Env;

function file(overrides: Partial<DropboxMetadata> = {}): DropboxMetadata {
  return {
    '.tag': 'file', id: 'id:file-1', name: 'notes.txt', path_lower: '/notes.txt', path_display: '/notes.txt',
    size: 12, server_modified: '2026-08-12T00:00:00Z', rev: 'rev-1', is_downloadable: true,
    ...overrides,
  };
}

describe('Dropbox API client', () => {
  it('lists folders and continues with an opaque cursor', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => Response.json({
      entries: [file()], cursor: 'next-cursor', has_more: true,
    }));
    const client = new DropboxClient(workerEnv(), 'mount-dropbox', fetcher, async () => 'access');
    const result = await client.list('id:folder');
    expect(result).toEqual({ items: [file()], nextCursor: 'next-cursor' });
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://api.dropboxapi.com/2/files/list_folder');
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ path: 'id:folder', recursive: false });

    await client.list('ignored', 'next-cursor');
    expect(String(fetcher.mock.calls[1]![0])).toContain('list_folder/continue');
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual({ cursor: 'next-cursor' });
  });

  it('streams downloads with Range and filters private response headers', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('partial', {
      status: 206,
      headers: { 'content-type': 'text/plain', 'content-range': 'bytes 2-8/12', 'x-private': 'secret' },
    }));
    const client = new DropboxClient(workerEnv(), 'mount-dropbox', fetcher, async () => 'access');
    const response = await client.download('id:file-1', 'bytes=2-8');
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 2-8/12');
    expect(response.headers.get('x-private')).toBeNull();
    const init = fetcher.mock.calls[0]![1];
    expect(new Headers(init?.headers).get('range')).toBe('bytes=2-8');
    expect(JSON.parse(new Headers(init?.headers).get('dropbox-api-arg')!)).toEqual({ path: 'id:file-1' });
  });

  it('sends conflict-safe mutation arguments', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      if (String(input).includes('/files/upload')) return Response.json(file({ id: 'id:uploaded' }));
      return Response.json({ metadata: file({ id: 'id:written' }) });
    });
    const client = new DropboxClient(workerEnv(), 'mount-dropbox', fetcher, async () => 'access');
    await client.createFolder('/Projects');
    await client.upload('/资料/笔记.txt', new ReadableStream());
    await client.move('id:file-1', '/Archive/notes.txt');
    await client.copy('id:file-1', '/Copies/notes.txt');

    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ path: '/Projects', autorename: false });
    expect(JSON.parse(new Headers(calls[1]!.init.headers).get('dropbox-api-arg')!)).toMatchObject({
      path: '/资料/笔记.txt', mode: 'add', autorename: false, strict_conflict: true,
    });
    expect(JSON.parse(String(calls[2]!.init.body))).toMatchObject({ from_path: 'id:file-1', to_path: '/Archive/notes.txt', autorename: false });
    expect(JSON.parse(String(calls[3]!.init.body))).toMatchObject({ from_path: 'id:file-1', to_path: '/Copies/notes.txt', autorename: false });
  });

  it('starts, appends, finishes, and closes upload sessions without exposing the session id in URLs', async () => {
    const calls: Array<{ url: string; arg: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const arg = JSON.parse(new Headers(init.headers).get('dropbox-api-arg') ?? '{}') as Record<string, unknown>;
      calls.push({ url: String(input), arg });
      if (String(input).endsWith('/start')) return Response.json({ session_id: 'private-session' });
      if (String(input).endsWith('/finish')) return Response.json(file({ id: 'id:uploaded' }));
      return new Response(null, { status: 200 });
    });
    const client = new DropboxClient(workerEnv(), 'mount-dropbox', fetcher, async () => 'access');
    const sessionId = await client.createUploadSession();
    await client.appendUploadSession(sessionId, 0, new ReadableStream(), false);
    await expect(client.finishUploadSession(sessionId, 10, '/video.mp4')).resolves.toMatchObject({ id: 'id:uploaded' });
    await client.closeUploadSession(sessionId, 10);

    expect(calls.every((call) => !call.url.includes('private-session'))).toBe(true);
    expect(calls[1]!.arg).toMatchObject({ cursor: { session_id: 'private-session', offset: 0 }, close: false });
    expect(calls[2]!.arg).toMatchObject({
      cursor: { session_id: 'private-session', offset: 10 },
      commit: { path: '/video.mp4', mode: 'add', autorename: false },
    });
  });

  it('normalizes conflicts and rate limits without leaking provider bodies', async () => {
    const conflict = new DropboxClient(workerEnv(), 'mount-dropbox', vi.fn(async () => Response.json({
      error_summary: 'to/conflict/file/', private: 'secret',
    }, { status: 409 })), async () => 'access');
    await expect(conflict.move('id:file', '/existing')).rejects.toMatchObject({ code: 'ENTRY_NAME_CONFLICT', status: 409 });

    const limited = new DropboxClient(workerEnv(), 'mount-dropbox', vi.fn(async () => Response.json({
      error_summary: 'too_many_requests/', private: 'secret',
    }, { status: 429, headers: { 'retry-after': '30' } })), async () => 'access');
    const error = await limited.stat('id:file').catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'DROPBOX_RATE_LIMITED', status: 503, details: { retryAfter: 30 } });
    expect(String(error)).not.toContain('secret');
  });
});
