import { randomInt } from 'node:crypto';
import { expect, test } from '@playwright/test';

const NEW_PASSWORD = 'E2e-Changed-Pass-2';

test('admin signs in, changes the password, creates an employee and signs out', async ({
  page,
}) => {
  const adminCode = process.env.E2E_ADMIN_CODE as string;
  const suffix = Date.now().toString(36).toUpperCase();
  const empCode = `EMP${suffix}`;
  const empName = `E2E Employee ${suffix}`;
  const mobile = `8${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

  // Route protection: no session, so /employees sends us to the login screen.
  await page.goto('/employees');
  await expect(page).toHaveURL(/\/login$/);

  // First sign-in with the bootstrap password forces the change.
  await page.getByLabel('Employee ID or mobile number').fill(adminCode);
  await page.getByLabel('Password').fill(process.env.E2E_ADMIN_PASSWORD as string);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/change-password$/);

  await page.getByLabel('Current password').fill(process.env.E2E_ADMIN_PASSWORD as string);
  await page.getByLabel(/^New password/).fill(NEW_PASSWORD);
  await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page).toHaveURL(/localhost:3100\/$/);

  // The tokens never reach page JavaScript.
  expect(await page.evaluate(() => document.cookie)).toBe('');
  expect(
    JSON.stringify(await page.evaluate(() => ({ ...localStorage, ...sessionStorage }))),
  ).not.toMatch(/eyJ/);

  await page.getByRole('link', { name: 'Employees' }).click();
  // The test database accumulates employees across runs, so find rows through the search box.
  const search = page.getByRole('textbox', { name: 'Search by name, code or mobile' });
  await search.fill(adminCode);
  await expect(page.getByRole('row', { name: new RegExp(adminCode) })).toBeVisible();

  // Create an employee with a generated password; it is shown once, with a warning.
  await page.getByRole('button', { name: 'New employee' }).click();
  const form = page.getByRole('dialog', { name: 'New employee' });
  await form.getByLabel('Employee code').fill(empCode);
  await form.getByLabel('Full name').fill(empName);
  await form.getByLabel('Mobile number').fill(mobile);
  await form.getByLabel('Designation').selectOption({ index: 1 });
  await form.getByLabel('Role').selectOption({ label: 'Office Employee' });
  await form.getByRole('button', { name: 'Save' }).click();

  const shown = page.getByRole('dialog', { name: 'Temporary password' });
  await expect(shown.getByText(/shown only once and cannot be retrieved later/)).toBeVisible();
  const temporaryPassword = (await shown.locator('code').textContent()) ?? '';
  expect(temporaryPassword).toHaveLength(12);
  await shown.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(shown).toBeHidden();
  await expect(page.getByText(temporaryPassword)).toHaveCount(0);

  await search.fill(empCode);
  await expect(page.getByRole('row', { name: new RegExp(empCode) })).toContainText(empName);

  // Sign out; the session is gone and protected pages redirect again.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/employees');
  await expect(page).toHaveURL(/\/login$/);

  // Office Employee has no web.access, so the temporary password gets the generic error.
  await page.getByLabel('Employee ID or mobile number').fill(empCode);
  await page.getByLabel('Password').fill(temporaryPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Invalid employee ID or password.')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});
