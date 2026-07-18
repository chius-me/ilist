import type { Page, Route } from '@playwright/test';

export type DirectoryState = 'normal' | 'loading' | 'empty' | 'error';

export interface ApiFixtureOptions {
  admin?: boolean;
  directoryState?: DirectoryState;
  completionDelayMs?: number;
}

export interface UploadFixtureState {
  createCalls: number;
  partCalls: number[];
  confirmedParts: Set<number>;
  completeCalls: number;
  abortCalls: number;
  directoryCalls: number;
}

interface ShareFixture {
  id: string;
  mountId: string;
  mountName: string;
  name: string;
  targetKind: 'file' | 'folder';
  protected: boolean;
  expiresAt: string | null;
  allowDownload: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const UPLOAD_PART_SIZE = 10 * 1024 * 1024;

const mutableCapabilities = {
  open: false,
  preview: true,
  download: true,
  upload: false,
  createFolder: false,
  rename: true,
  move: true,
  delete: true,
  changeVisibility: true,
};

const folderCapabilities = {
  open: true,
  preview: false,
  download: false,
  upload: false,
  createFolder: false,
  rename: true,
  move: true,
  delete: true,
  changeVisibility: true,
};

const current = {
  id: 'root', parentId: null, name: '', kind: 'folder', size: 0, contentType: null,
  updatedAt: '2026-07-15T08:00:00.000Z', isPublic: true, effectivePublic: true,
  sortOrder: 0, description: '', mountPath: null,
  capabilities: { ...folderCapabilities, upload: true, multipartUpload: true, createFolder: true, rename: false, move: false, delete: false, changeVisibility: false },
};

export const fixtureEntries = [
  {
    id: 'projects', parentId: 'root', name: '项目资料', kind: 'folder', size: 0, contentType: null,
    updatedAt: '2026-07-15T07:30:00.000Z', isPublic: true, effectivePublic: true,
    sortOrder: 0, description: '团队文档', mountPath: null, capabilities: folderCapabilities,
  },
  {
    id: 'archive', parentId: 'root', name: 'Archive', kind: 'folder', size: 0, contentType: null,
    updatedAt: '2026-07-14T12:00:00.000Z', isPublic: true, effectivePublic: true,
    sortOrder: 1, description: 'Connected storage', mountPath: '/archive', capabilities: folderCapabilities,
  },
  {
    id: 'report', parentId: 'root', name: 'Quarterly report 2026 with an exceptionally long filename.txt', kind: 'file', size: 18432, contentType: 'text/plain',
    updatedAt: '2026-07-15T06:45:00.000Z', isPublic: true, effectivePublic: true,
    sortOrder: 2, description: 'Planning notes and results', mountPath: null, capabilities: mutableCapabilities,
  },
  {
    id: 'sunrise', parentId: 'root', name: 'sunrise.png', kind: 'file', size: 2048, contentType: 'image/png',
    updatedAt: '2026-07-13T10:20:00.000Z', isPublic: true, effectivePublic: true,
    sortOrder: 3, description: 'Reference image', mountPath: null, capabilities: mutableCapabilities,
  },
  {
    id: 'private-pdf', parentId: 'root', name: 'financial-plan.pdf', kind: 'file', size: 524288, contentType: 'application/pdf',
    updatedAt: '2026-07-12T09:10:00.000Z', isPublic: false, effectivePublic: false,
    sortOrder: 4, description: 'Private forecast', mountPath: null, capabilities: mutableCapabilities,
  },
  {
    id: 'recording', parentId: 'root', name: 'meeting-recording.mp3', kind: 'file', size: 7340032, contentType: 'audio/mpeg',
    updatedAt: '2026-07-11T16:00:00.000Z', isPublic: true, effectivePublic: true,
    sortOrder: 5, description: 'Team recording', mountPath: null, capabilities: mutableCapabilities,
  },
] as const;

const initialMounts = [
  {
    id: 'r2', name: 'Production archive', mountPath: '/archive', driverType: 's3', provider: 'cloudflare-r2',
    enabled: true, isPublic: true, sortOrder: 0, rootItemId: null, connected: true,
    config: { endpoint: 'https://account.r2.cloudflarestorage.com', region: 'auto', bucket: 'archive', addressingMode: 'path' },
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z',
  },
  {
    id: 'personal', name: 'Personal drive', mountPath: '/personal', driverType: 'onedrive', provider: 'microsoft-onedrive-personal',
    enabled: true, isPublic: false, sortOrder: 1, rootItemId: null, connected: true, config: {},
    createdAt: '2026-07-02T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z',
  },
];

function json(route: Route, data: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
}

export async function installApiFixtures(page: Page, options: ApiFixtureOptions = {}) {
  const admin = options.admin ?? true;
  const directoryState = options.directoryState ?? 'normal';
  const completionDelayMs = options.completionDelayMs ?? 1500;
  let mounts: Array<Record<string, unknown>> = initialMounts.map((mount) => ({ ...mount, config: { ...mount.config } }));
  const uploads: UploadFixtureState = {
    createCalls: 0,
    partCalls: [],
    confirmedParts: new Set(),
    completeCalls: 0,
    abortCalls: 0,
    directoryCalls: 0,
  };
  let uploadSize = UPLOAD_PART_SIZE * 2 + UPLOAD_PART_SIZE / 2;
  let failedPartTwo = false;
  let shareAuthorized = false;
  const sharedFolder = {
    ...fixtureEntries[0], id: 'sealed-root', parentId: null, name: 'Shared workspace',
    isPublic: false, effectivePublic: false,
    capabilities: { ...folderCapabilities, rename: false, move: false, delete: false, changeVisibility: false },
  };
  const sharedNested = { ...sharedFolder, id: 'sealed-nested', parentId: 'sealed-root', name: 'Nested' };
  const sharedFile = {
    ...fixtureEntries[2], id: 'sealed-file', parentId: 'sealed-nested', name: 'shared-notes.txt', size: 64,
    isPublic: false, effectivePublic: false,
    capabilities: { ...mutableCapabilities, download: false, rename: false, move: false, delete: false, changeVisibility: false },
  };
  let shares: ShareFixture[] = [{
    id: 'existing-share', mountId: 'r2', mountName: 'Production archive', name: 'financial-plan.pdf',
    targetKind: 'file', protected: false, expiresAt: null, allowDownload: true, enabled: true,
    createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
  }];

  const uploadSession = () => ({
    id: 'e2e-upload-session',
    kind: 'multipart',
    partSize: UPLOAD_PART_SIZE,
    size: uploadSize,
    uploadedParts: [...uploads.confirmedParts].sort((a, b) => a - b).map((partNumber) => ({
      partNumber,
      size: Math.min(UPLOAD_PART_SIZE, uploadSize - (partNumber - 1) * UPLOAD_PART_SIZE),
    })),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    status: 'active',
  });

  await page.addInitScript(() => {
    localStorage.setItem('ilist.ui.preferences', JSON.stringify({ version: 1, locale: 'en', theme: 'light', defaultView: 'list' }));
  });

  await page.route('**/api/admin/me', (route) => admin
    ? json(route, { ok: true, data: { username: 'admin' } })
    : json(route, { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } }, 401));

  await page.route('**/api/admin/login', (route) => json(route, {
    ok: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' },
  }, 401));

  await page.route('**/api/admin/shares**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/admin/shares') return json(route, { ok: true, data: shares });
    if (request.method() === 'POST' && url.pathname === '/api/admin/shares') {
      const input = request.postDataJSON() as { entryId: string; password?: string; allowDownload: boolean; enabled?: boolean; expiresAt?: string };
      const source = fixtureEntries.find((entry) => entry.id === input.entryId) ?? fixtureEntries[2];
      const share = {
        id: 'created-share', mountId: 'native-r2', mountName: 'Built-in R2', name: source.name,
        targetKind: source.kind as 'file' | 'folder', protected: Boolean(input.password), expiresAt: input.expiresAt ?? null,
        allowDownload: input.allowDownload, enabled: input.enabled ?? true,
        createdAt: '2026-07-18T01:00:00.000Z', updatedAt: '2026-07-18T01:00:00.000Z',
      };
      shares = [share, ...shares.filter((item) => item.id !== share.id)];
      return json(route, { ok: true, data: { share, url: 'http://127.0.0.1:4173/s/e2e-share-token' } }, 201);
    }
    const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    if (request.method() === 'PATCH') {
      const input = request.postDataJSON() as { allowDownload?: boolean; enabled?: boolean; expiresAt?: string | null; password?: string; clearPassword?: boolean };
      const existing = shares.find((item) => item.id === id);
      if (!existing) return json(route, { ok: false, error: { code: 'SHARE_NOT_FOUND', message: 'Share not found' } }, 404);
      const updated = {
        ...existing,
        ...(typeof input.allowDownload === 'boolean' ? { allowDownload: input.allowDownload } : {}),
        ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        ...(input.password ? { protected: true } : {}),
        ...(input.clearPassword ? { protected: false } : {}),
        updatedAt: '2026-07-18T02:00:00.000Z',
      };
      shares = shares.map((item) => item.id === id ? updated : item);
      return json(route, { ok: true, data: updated });
    }
    if (request.method() === 'DELETE') {
      shares = shares.filter((item) => item.id !== id);
      return route.fulfill({ status: 204, body: '' });
    }
    return json(route, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
  });

  await page.route('**/s/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/s/disabled-share-token/api') {
      return json(route, { ok: false, error: { code: 'SHARE_DISABLED', message: 'Disabled' } }, 410);
    }
    if (!url.pathname.startsWith('/s/e2e-share-token/')) return route.fallback();
    if (url.pathname === '/s/e2e-share-token/auth' && request.method() === 'POST') {
      const input = request.postDataJSON() as { password: string };
      if (input.password !== 'share-passphrase') return json(route, { ok: false, error: { code: 'SHARE_PASSWORD_INVALID', message: 'Invalid password' } }, 401);
      shareAuthorized = true;
      return json(route, { ok: true, data: {} });
    }
    if (!shareAuthorized) return json(route, { ok: false, error: { code: 'SHARE_PASSWORD_REQUIRED', message: 'Password required' } }, 401);
    if (url.pathname === '/s/e2e-share-token/api') return json(route, { ok: true, data: {
      name: 'Shared workspace', targetKind: 'folder', allowDownload: false, protected: true, expiresAt: null, entry: sharedFolder,
    } });
    if (url.pathname === '/s/e2e-share-token/api/list') {
      const nested = url.searchParams.get('parent') === 'sealed-nested';
      return json(route, { ok: true, data: {
        current: nested ? sharedNested : sharedFolder,
        breadcrumbs: [],
        items: nested ? [sharedFile] : [sharedNested],
      } });
    }
    if (url.pathname === '/s/e2e-share-token/file/sealed-file/shared-notes.txt') {
      if (url.searchParams.get('download') === '1') return json(route, { ok: false, error: { code: 'SHARE_DOWNLOAD_DISABLED', message: 'Download disabled' } }, 403);
      return route.fulfill({ status: 200, contentType: 'text/plain', body: 'Shared preview fixture\nPrivate content remains protected.' });
    }
    return json(route, { ok: false, error: { code: 'SHARE_NOT_FOUND', message: 'Not found' } }, 404);
  });

  await page.route('**/api/fs/list**', async (route) => {
    uploads.directoryCalls += 1;
    if (directoryState === 'loading') {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    if (directoryState === 'error') {
      return json(route, { ok: false, error: { code: 'UPSTREAM_ERROR', message: 'Storage is temporarily unavailable' } }, 503);
    }
    const url = new URL(route.request().url());
    const path = url.searchParams.get('path') ?? '/';
    const items = directoryState === 'empty' ? [] : path === '/' ? fixtureEntries : [];
    return json(route, {
      ok: true,
      data: {
        current: path === '/' ? current : { ...current, id: 'projects', name: '项目资料' },
        breadcrumbs: path === '/'
          ? [{ id: 'root', name: 'ilist', path: '/' }]
          : [{ id: 'root', name: 'ilist', path: '/' }, { id: 'projects', name: '项目资料', path }],
        items,
      },
    });
  });

  await page.route('**/api/fs/entries/*', (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '');
    const entry = fixtureEntries.find((item) => item.id === id);
    return entry ? json(route, { ok: true, data: entry }) : json(route, { ok: false, error: { code: 'ENTRY_NOT_FOUND', message: 'Entry not found' } }, 404);
  });

  await page.route('**/api/admin/mounts', (route) => {
    if (route.request().method() === 'GET') return json(route, { ok: true, data: mounts });
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON() as Record<string, unknown>;
      const created = {
        ...input,
        id: 'google-e2e',
        connected: false,
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
      };
      mounts = [...mounts, created];
      return json(route, { ok: true, data: created });
    }
    return json(route, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } }, 405);
  });
  await page.route('**/api/admin/mounts/**', (route) => json(route, { ok: true, data: mounts[0] }));
  await page.route('**/api/admin/oauth/google/start**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>Google OAuth</title>',
  }));
  await page.route('**/api/admin/entries/**', (route) => json(route, { ok: true, data: { succeeded: ['report'], failed: [] } }));
  await page.route('**/api/admin/uploads/sessions**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === 'POST' && path === '/api/admin/uploads/sessions') {
      uploads.createCalls += 1;
      uploads.confirmedParts.clear();
      const body = request.postDataJSON() as { size?: number };
      uploadSize = typeof body.size === 'number' ? body.size : uploadSize;
      return json(route, { ok: true, data: uploadSession() }, 201);
    }
    if (request.method() === 'GET' && path === '/api/admin/uploads/sessions/e2e-upload-session') {
      return json(route, { ok: true, data: uploadSession() });
    }
    const partMatch = /\/parts\/(\d+)$/.exec(path);
    if (request.method() === 'PUT' && partMatch) {
      const partNumber = Number(partMatch[1]);
      uploads.partCalls.push(partNumber);
      await new Promise((resolve) => setTimeout(resolve, partNumber === 2 ? 650 : 120));
      if (request.failure()) return;
      if (partNumber === 2 && !failedPartTwo) {
        failedPartTwo = true;
        return json(route, { ok: false, error: { code: 'UPLOAD_PROVIDER_RATE_LIMITED', message: 'Retry later' } }, 503);
      }
      uploads.confirmedParts.add(partNumber);
      const size = Math.min(UPLOAD_PART_SIZE, uploadSize - (partNumber - 1) * UPLOAD_PART_SIZE);
      return json(route, { ok: true, data: { partNumber, size } });
    }
    if (request.method() === 'POST' && path.endsWith('/complete')) {
      uploads.completeCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, completionDelayMs));
      return route.fulfill({ status: 204, body: '' });
    }
    if (request.method() === 'DELETE' && path === '/api/admin/uploads/sessions/e2e-upload-session') {
      uploads.abortCalls += 1;
      return route.fulfill({ status: 204, body: '' });
    }
    return json(route, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
  });
  await page.route('**/api/admin/files/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ status: 201, body: '' });
  });
  await page.route('**/file/**', (route) => new URL(route.request().url()).pathname.startsWith('/s/')
    ? route.fallback()
    : route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'fixture' }));
  await page.route('**/file/report/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/plain',
    body: 'Quarterly report\n\nRevenue and delivery remained on plan.\nUnicode fixture: 项目资料',
  }));
  return uploads;
}
