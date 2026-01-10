import { expect, test, type Locator, type Page } from '@playwright/test';
import { installApiFixtures } from './fixtures';

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

async function expectInsideViewport(page: Page, locator: Locator) {
  const viewport = page.viewportSize();
  const box = await locator.boundingBox();
  expect(viewport).not.toBeNull();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
}

async function settleVisualState(page: Page) {
  await page.waitForTimeout(200);
}

test('@visual explorer list, grid, themes, and locales', async ({ page }) => {
  await installApiFixtures(page, { admin: true });
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Files and folders' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectInsideViewport(page, page.getByRole('button', { name: 'Upload files' }));
  await expect(page).toHaveScreenshot('explorer-list-light-en.png', { fullPage: true });

  await page.getByRole('button', { name: 'Grid view' }).click();
  await expect(page.getByRole('button', { name: 'Grid view' })).toHaveAttribute('aria-pressed', 'true');
  await settleVisualState(page);
  await expect(page).toHaveScreenshot('explorer-grid-light-en.png', { fullPage: true });

  await page.getByRole('button', { name: 'Change theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await settleVisualState(page);
  await expect(page).toHaveScreenshot('explorer-grid-dark-en.png', { fullPage: true });

  await page.getByRole('button', { name: 'Change language' }).click();
  await expect(page.getByRole('button', { name: '上传文件' })).toBeVisible();
  await settleVisualState(page);
  await expect(page).toHaveScreenshot('explorer-grid-dark-zh.png', { fullPage: true });
  await expectNoHorizontalOverflow(page);
});

test('@visual previews, selection, menus, and dialogs stay in bounds', async ({ page }) => {
  await installApiFixtures(page, { admin: true });
  await page.goto('/');
  const report = 'Quarterly report 2026 with an exceptionally long filename.txt';

  await page.getByRole('button', { name: `Open ${report}` }).click();
  const preview = page.getByRole('dialog', { name: `Preview ${report}` });
  await expect(preview).toContainText('Revenue and delivery remained on plan.');
  await expectInsideViewport(page, preview);
  await expect(page).toHaveScreenshot('preview-text.png', { fullPage: true });
  await page.getByRole('button', { name: 'Close preview' }).click();

  await page.getByRole('checkbox', { name: `Select ${report}` }).check();
  await expect(page.getByRole('region', { name: 'Selected file actions' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await page.getByRole('button', { name: `Actions for ${report}` }).click();

  if ((page.viewportSize()?.width ?? 0) <= 760) {
    const sheet = page.getByRole('dialog', { name: `Actions for ${report}` });
    await expect(sheet).toBeVisible();
    await expectInsideViewport(page, sheet);
    await sheet.getByRole('button', { name: 'Rename' }).click();
  } else {
    const menu = page.getByRole('menu', { name: `Actions for ${report}` });
    await expect(menu).toBeVisible();
    await expectInsideViewport(page, menu);
    await menu.getByRole('menuitem', { name: 'Rename' }).click();
  }
  await expect(page.getByRole('dialog', { name: `Rename ${report}` })).toBeVisible();
  await expect(page).toHaveScreenshot('rename-dialog.png', { fullPage: true });
  await expectNoHorizontalOverflow(page);
});

test('@visual upload, storage, and appearance surfaces', async ({ page }) => {
  await installApiFixtures(page, { admin: true });
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles({ name: 'release-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('release notes') });
  const upload = page.getByRole('complementary', { name: 'Upload queue' });
  await expect(upload).toBeVisible();
  await expectInsideViewport(page, upload);
  await expect(page).toHaveScreenshot('upload-panel.png', { fullPage: true });

  await page.getByRole('button', { name: 'Storage settings' }).click();
  await expect(page.getByRole('table', { name: 'Storage mounts' })).toContainText('Production archive');
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot('storage-management.png', { fullPage: true });

  if ((page.viewportSize()?.width ?? 0) <= 760) await page.getByRole('button', { name: 'Admin menu' }).click();
  await page.getByRole('link', { name: 'Appearance' }).click();
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  await expect(page).toHaveScreenshot('appearance-preferences.png', { fullPage: true });
});

test('navigates folders and exposes loading, empty, and retry states', async ({ page }) => {
  await installApiFixtures(page, { admin: true });
  await page.goto('/');
  await page.getByRole('button', { name: /Open 项目资料/ }).click();
  await expect(page).toHaveURL(/%E9%A1%B9%E7%9B%AE%E8%B5%84%E6%96%99/);

  const loadingPage = await page.context().newPage();
  await installApiFixtures(loadingPage, { directoryState: 'loading' });
  await loadingPage.goto('/');
  await expect(loadingPage.getByLabel('Loading files')).toBeVisible();
  await loadingPage.close();

  const emptyPage = await page.context().newPage();
  await installApiFixtures(emptyPage, { directoryState: 'empty' });
  await emptyPage.goto('/');
  await expect(emptyPage.getByText('This folder is empty')).toBeVisible();
  await emptyPage.close();

  const errorPage = await page.context().newPage();
  await installApiFixtures(errorPage, { directoryState: 'error' });
  await errorPage.goto('/');
  await expect(errorPage.getByRole('button', { name: 'Retry' })).toBeVisible();
  await errorPage.close();
});

test('shows a localized login error for guests', async ({ page }) => {
  await installApiFixtures(page, { admin: false });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('incorrect');
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByRole('alert')).toHaveText('Invalid credentials');
});
