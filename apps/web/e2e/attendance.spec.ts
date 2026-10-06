import { expect, test, type Page } from '@playwright/test';
import {
  adminToken,
  atBranch,
  createPlace,
  createWorker,
  expectImagesLoaded,
  punchOk,
  uiLoginAsReadyAdmin,
  type Place,
  type Worker,
} from './helpers';

// The selfies are public-domain computer-generated faces; no real person is involved.

let place: Place;
let punched: Worker; // punched in at the branch
let idle: Worker; // nobody punched: a day with no record

test.beforeAll(async () => {
  const token = await adminToken();
  place = await createPlace(token);
  [punched, idle] = [await createWorker(token, place), await createWorker(token, place)];
  await punchOk(punched.phone, 'punch-in', atBranch(place));
});

async function openRegister(page: Page, search: string) {
  await uiLoginAsReadyAdmin(page);
  await page.getByRole('link', { name: 'Attendance' }).click();
  await page.getByRole('textbox', { name: 'Search by name or code' }).fill(search);
}

const rowOf = (page: Page, name: string) =>
  page.getByRole('table').getByRole('row').filter({ hasText: name });

test('the register shows the punch, and the filters narrow it', async ({ page }) => {
  await openRegister(page, punched.employee.code);
  const row = rowOf(page, punched.employee.name);
  await expect(row).toBeVisible();
  await expect(row).toContainText('On the job');
  await expect(row).toContainText(place.name);

  // The branch and status filters keep the row while it matches, and drop it when it does not.
  await page.getByLabel('Branch').selectOption({ label: place.name });
  await expect(row).toBeVisible();
  await page.getByLabel('Status').selectOption({ label: 'Absent' });
  await expect(page.getByText('No employees match.')).toBeVisible();
  await page.getByLabel('Status').selectOption({ label: 'On the job' });
  await expect(row).toBeVisible();
});

test('the details dialog shows the punch with a selfie that loads', async ({ page }) => {
  await openRegister(page, punched.employee.code);
  await page.getByRole('button', { name: `Actions for ${punched.employee.name}` }).click();
  await page.getByRole('menuitem', { name: 'Details' }).click();
  const dialog = page.getByRole('dialog', { name: 'Attendance day' });
  await expect(dialog.getByText(/recorded in the audit log/)).toBeVisible();
  await expect(dialog.getByRole('img')).toHaveCount(1);
  await expectImagesLoaded(dialog.getByRole('img'));
  await expect(dialog.getByText('Face verified')).toBeVisible();
  await expect(dialog.getByText(new RegExp(`${place.name}, \\d+ m from the centre`))).toBeVisible();
  await expect(dialog.getByText('Phone time (not trusted)')).toBeVisible();
});

test('an override needs a reason, and the day then shows the new status', async ({ page }) => {
  await openRegister(page, idle.employee.code);
  const row = rowOf(page, idle.employee.name);
  await expect(row).toContainText('No record');

  await page.getByRole('button', { name: `Actions for ${idle.employee.name}` }).click();
  await page.getByRole('menuitem', { name: 'Override' }).click();
  const dialog = page.getByRole('dialog', { name: 'Override this day' });
  await dialog.getByLabel('Mark the day as').selectOption({ label: 'Work from home' });
  await dialog.getByRole('button', { name: 'Save override' }).click();
  await expect(dialog.getByText('Give a reason of at least 5 characters.')).toBeVisible();

  await dialog.getByLabel('Reason (required)').fill('Power cut at the branch');
  await dialog.getByRole('button', { name: 'Save override' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toContainText('Work from home');
});
