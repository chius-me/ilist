import { expect, test, type Page } from '@playwright/test';
import { installApiFixtures } from './fixtures';

async function openEntryAction(page: Page, entry: string, action: string) {
  await page.getByRole('button', { name: `Actions for ${entry}` }).click();
  if ((page.viewportSize()?.width ?? 0) <= 760) {
    await page.getByRole('dialog', { name: `Actions for ${entry}` }).getByRole('button', { name: action }).click();
  } else {
    await page.getByRole('menu', { name: `Actions for ${entry}` }).getByRole('menuitem', { name: action }).click();
  }
}

async function openShareManager(page: Page) {
  await page.getByRole('button', { name: 'Storage settings' }).click();
  if ((page.viewportSize()?.width ?? 0) <= 760) await page.getByRole('button', { name: 'Admin menu' }).click();
  await page.getByRole('link', { name: 'Shares' }).click();
}

test('administrator creates a one-time share then edits, disables, and deletes it', async ({ page }) => {
  await installApiFixtures(page, { admin: true });
  await page.goto('/');
  const entry = 'Quarterly report 2026 with an exceptionally long filename.txt';
  await openEntryAction(page, entry, 'Share');
  await expect(page.getByRole('dialog', { name: 'Create share' })).toBeVisible();
  await page.getByLabel('Require password').check();
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('share-passphrase');
  await page.getByRole('button', { name: 'Create share' }).click();
  const oneTimeLink = page.getByRole('textbox', { name: 'Share link' });
  await expect(oneTimeLink).toHaveValue('http://127.0.0.1:4173/s/e2e-share-token');
  await page.getByRole('dialog', { name: 'Share created' }).getByRole('button', { name: 'Close' }).last().click();

  await openShareManager(page);
  const table = page.getByRole('table', { name: 'Shares' });
  await expect(table).toContainText(entry);
  await expect(page.getByRole('textbox', { name: 'Share link' })).toHaveCount(0);

  await page.getByRole('button', { name: `Edit ${entry}` }).click();
  await page.getByLabel('Allow downloads').uncheck();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(table).toContainText('Downloads blocked');
  await page.getByRole('button', { name: `Disable ${entry}` }).click();
  await expect(table).toContainText('Disabled');
  await page.getByRole('button', { name: `Delete ${entry}` }).click();
  await page.getByRole('dialog', { name: 'Delete share' }).getByRole('button', { name: 'Delete share' }).click();
  await expect(table.getByRole('row', { name: new RegExp(entry) })).toHaveCount(0);
});

test('visitor unlocks a folder share, navigates, previews, and cannot download', async ({ page }) => {
  await installApiFixtures(page, { admin: false });
  await page.goto('/s/e2e-share-token');
  await expect(page.getByRole('heading', { name: 'Protected share' })).toBeVisible();
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Open share' }).click();
  await expect(page.getByRole('alert')).toHaveText('The share password is incorrect.');
  await page.getByLabel('Password').fill('share-passphrase');
  await page.getByRole('button', { name: 'Open share' }).click();
  await page.getByRole('button', { name: 'Open Nested' }).click();
  await page.getByRole('button', { name: 'Open shared-notes.txt' }).click();
  const preview = page.getByRole('dialog', { name: 'Preview shared-notes.txt' });
  await expect(preview).toContainText('Shared preview fixture');
  await expect(preview.getByRole('link', { name: /download/i })).toHaveCount(0);
  const deniedStatus = await page.evaluate(async () => (await fetch('/s/e2e-share-token/file/sealed-file/shared-notes.txt?download=1')).status);
  expect(deniedStatus).toBe(403);
});

test('Workspace export actions use controlled-share URLs and preview PDF', async ({ page }) => {
  await installApiFixtures(page, { admin: false, workspaceExports: true });
  await page.goto('/s/e2e-share-token');
  await page.getByLabel('Password').fill('share-passphrase');
  await page.getByRole('button', { name: 'Open share' }).click();
  await page.getByRole('button', { name: 'Open Nested' }).click();
  const name = 'Project brief';
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  const actions = (page.viewportSize()?.width ?? 0) <= 760
    ? page.getByRole('dialog', { name: `Actions for ${name}` })
    : page.getByRole('menu', { name: `Actions for ${name}` });
  const actionRole = (page.viewportSize()?.width ?? 0) <= 760 ? 'link' : 'menuitem';
  await expect(actions.getByRole(actionRole, { name: 'Export DOCX' })).toHaveAttribute('href', /\/s\/e2e-share-token\/file\/sealed-workspace-doc\/Project%20brief\?download=1&export=docx/);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: `Open ${name}` }).click();
  await expect(page.getByRole('dialog', { name: `Preview ${name}` }).getByTitle('PDF preview')).toHaveAttribute('src', /\/s\/e2e-share-token\/file\/sealed-workspace-doc\/Project%20brief\?export=pdf/);
});

test('@visual share creation, management, and public states', async ({ page }) => {
  await installApiFixtures(page, { admin: true });
  await page.goto('/');
  const entry = 'Quarterly report 2026 with an exceptionally long filename.txt';
  await openEntryAction(page, entry, 'Share');
  await expect(page.getByRole('dialog', { name: 'Create share' })).toBeVisible();
  await expect(page).toHaveScreenshot('share-create-dialog.png', { fullPage: true });
  await page.getByRole('button', { name: 'Cancel' }).click();
  await openShareManager(page);
  await expect(page.getByRole('heading', { name: 'Shares' })).toBeVisible();
  await expect(page).toHaveScreenshot('share-manager.png', { fullPage: true });

  await page.goto('/s/e2e-share-token');
  await expect(page.getByRole('heading', { name: 'Protected share' })).toBeVisible();
  await expect(page).toHaveScreenshot('share-password.png', { fullPage: true });
  await page.getByLabel('Password').fill('share-passphrase');
  await page.getByRole('button', { name: 'Open share' }).click();
  await expect(page.getByText('Nested')).toBeVisible();
  await expect(page).toHaveScreenshot('shared-folder.png', { fullPage: true });
  await page.getByRole('button', { name: 'Grid view' }).click();
  await expect(page).toHaveScreenshot('shared-folder-grid.png', { fullPage: true });
  await page.getByRole('button', { name: 'List view' }).click();
  await page.getByRole('button', { name: 'Open Nested' }).click();
  await page.getByRole('button', { name: 'Open shared-notes.txt' }).click();
  await expect(page.getByRole('dialog', { name: 'Preview shared-notes.txt' })).toContainText('Shared preview fixture');
  await expect(page).toHaveScreenshot('shared-file-preview.png', { fullPage: true });
});

test('@visual share unavailable state', async ({ page }) => {
  await installApiFixtures(page, { admin: false });
  await page.goto('/s/disabled-share-token');
  await expect(page.getByRole('heading', { name: 'Share disabled' })).toBeVisible();
  await expect(page).toHaveScreenshot('share-disabled.png', { fullPage: true });
});
