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

async function openEntryAction(page: Page, report: string, action: string) {
  await page.getByRole('button', { name: `Actions for ${report}` }).click();
  if ((page.viewportSize()?.width ?? 0) <= 760) await page.getByRole('dialog', { name: `Actions for ${report}` }).getByRole('button', { name: action }).click();
  else await page.getByRole('menu', { name: `Actions for ${report}` }).getByRole('menuitem', { name: action }).click();
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

test('mobile command bar fits and search uses the available left region', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '390px mobile layout contract');
  await installApiFixtures(page, { admin: true });
  await page.goto('/');

  const toolbar = page.getByRole('region', { name: 'File controls' });
  const browser = page.locator('.explorerBrowser');
  const searchButton = page.getByRole('button', { name: 'Search this folder' });
  const sort = page.getByRole('combobox', { name: 'Sort files' });
  const iconControls = [
    searchButton,
    page.getByRole('button', { name: 'Sort ascending' }),
    page.getByRole('button', { name: 'Refresh' }),
    page.getByRole('button', { name: 'Switch to grid view' }),
    page.getByRole('button', { name: 'Administrator menu' }),
  ];
  const sortBefore = await sort.boundingBox();
  const iconBoxes = [];

  expect(page.viewportSize()?.width).toBe(390);
  await expectNoHorizontalOverflow(page);
  await expectInsideViewport(page, toolbar);
  for (const control of iconControls) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(48);
    expect(box!.height).toBeGreaterThanOrEqual(48);
    iconBoxes.push(box!);
  }
  expect((await sort.boundingBox())!.width).toBeLessThanOrEqual(64);
  expect(Math.max(...iconBoxes.map((box) => box.y)) - Math.min(...iconBoxes.map((box) => box.y))).toBeLessThanOrEqual(1);

  await searchButton.click();
  const search = page.getByRole('textbox', { name: 'Search this folder' });
  const searchControl = page.locator('.searchControl');
  const searchBox = await searchControl.boundingBox();
  const browserBox = await browser.boundingBox();
  const sortAfter = await sort.boundingBox();
  expect(searchBox).not.toBeNull();
  expect(browserBox).not.toBeNull();
  expect(sortBefore).not.toBeNull();
  expect(sortAfter).not.toBeNull();
  expect(searchBox!.x).toBeGreaterThanOrEqual(browserBox!.x);
  expect(searchBox!.x + searchBox!.width).toBeLessThanOrEqual(sortAfter!.x + 1);
  expect(searchBox!.width).toBeGreaterThanOrEqual(100);
  expect(Math.abs(sortAfter!.x - sortBefore!.x)).toBeLessThanOrEqual(1);
  await expect(search).toBeFocused();
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
  await expect(page).toHaveScreenshot('selection-toolbar.png', { fullPage: true });
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await page.getByRole('button', { name: `Actions for ${report}` }).click();

  if ((page.viewportSize()?.width ?? 0) <= 760) {
    const sheet = page.getByRole('dialog', { name: `Actions for ${report}` });
    await expect(sheet).toBeVisible();
    await expectInsideViewport(page, sheet);
    await expect(page).toHaveScreenshot('mobile-action-sheet.png', { fullPage: true });
    await sheet.getByRole('button', { name: 'Rename' }).click();
  } else {
    const menu = page.getByRole('menu', { name: `Actions for ${report}` });
    await expect(menu).toBeVisible();
    await expectInsideViewport(page, menu);
    await expect(page).toHaveScreenshot('desktop-context-menu.png', { fullPage: true });
    await menu.getByRole('menuitem', { name: 'Rename' }).click();
  }
  await expect(page.getByRole('dialog', { name: `Rename ${report}` })).toBeVisible();
  await expect(page).toHaveScreenshot('rename-dialog.png', { fullPage: true });
  await page.getByRole('button', { name: 'Close' }).click();

  await openEntryAction(page, report, 'Delete');
  await expect(page.getByRole('dialog', { name: `Delete ${report}` })).toBeVisible();
  await expect(page).toHaveScreenshot('delete-dialog.png', { fullPage: true });
  await page.getByRole('button', { name: 'Cancel' }).click();

  await openEntryAction(page, report, 'Move');
  await expect(page.getByRole('dialog', { name: 'Move selected entries' })).toBeVisible();
  await expect(page).toHaveScreenshot('move-dialog.png', { fullPage: true });
  await page.getByRole('button', { name: 'Cancel' }).click();

  await openEntryAction(page, report, 'Properties');
  await expect(page.getByRole('dialog', { name: `Properties for ${report}` })).toBeVisible();
  await expect(page).toHaveScreenshot('properties-dialog.png', { fullPage: true });
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

  const productionActions = page.getByRole('button', { name: 'Actions for Production archive' });
  const productionMenu = page.locator('details.mountActionMenu').nth(0);
  await productionActions.click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(productionMenu).not.toHaveAttribute('open', '');
  await expect(page.getByRole('dialog', { name: 'Delete storage mount' })).toBeVisible();
  await expect(page).toHaveScreenshot('mount-delete-confirmation.png', { fullPage: true, maxDiffPixelRatio: 0 });
  await page.getByRole('button', { name: 'Cancel' }).click();

  const personalActions = page.getByRole('button', { name: 'Actions for Personal drive' });
  const personalMenu = page.locator('details.mountActionMenu').nth(1);
  await personalActions.click();
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(personalMenu).not.toHaveAttribute('open', '');
  await expect(page.getByRole('dialog', { name: 'Disconnect OneDrive' })).toBeVisible();
  await expect(page).toHaveScreenshot('mount-disconnect-confirmation.png', { fullPage: true, maxDiffPixelRatio: 0 });
  await page.getByRole('button', { name: 'Cancel' }).click();

  if ((page.viewportSize()?.width ?? 0) <= 760) await page.getByRole('button', { name: 'Admin menu' }).click();
  await page.getByRole('link', { name: 'Appearance' }).click();
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  await expect(page).toHaveScreenshot('appearance-preferences.png', { fullPage: true });
});

test('@visual navigates folders and exposes loading, empty, and retry states', async ({ page }) => {
  await installApiFixtures(page, { admin: true });
  await page.goto('/');
  await page.getByRole('button', { name: /Open 项目资料/ }).click();
  await expect(page).toHaveURL(/%E9%A1%B9%E7%9B%AE%E8%B5%84%E6%96%99/);

  const loadingPage = await page.context().newPage();
  await installApiFixtures(loadingPage, { directoryState: 'loading' });
  await loadingPage.goto('/');
  await expect(loadingPage.getByLabel('Loading files')).toBeVisible();
  await expect(loadingPage).toHaveScreenshot('loading-state.png', { fullPage: true });
  await loadingPage.close();

  const emptyPage = await page.context().newPage();
  await installApiFixtures(emptyPage, { directoryState: 'empty' });
  await emptyPage.goto('/');
  await expect(emptyPage.getByText('This folder is empty')).toBeVisible();
  await expect(emptyPage).toHaveScreenshot('empty-state.png', { fullPage: true });
  await emptyPage.close();

  const errorPage = await page.context().newPage();
  await installApiFixtures(errorPage, { directoryState: 'error' });
  await errorPage.goto('/');
  await expect(errorPage.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(errorPage).toHaveScreenshot('retry-state.png', { fullPage: true });
  await errorPage.close();
});

test('@visual shows a localized login error for guests', async ({ page }) => {
  await installApiFixtures(page, { admin: false });
  await page.goto('/');
  await page.getByRole('button', { name: 'Change theme' }).click();
  await page.getByRole('button', { name: 'Change language' }).click();
  await page.getByRole('button', { name: '管理员登录' }).click();
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('incorrect');
  await page.getByRole('button', { name: '登录', exact: true }).last().click();
  await expect(page.getByRole('alert')).toHaveText('用户名或密码无效。');
  await expect(page).toHaveScreenshot('login-error-dark-zh.png', { fullPage: true });
});
