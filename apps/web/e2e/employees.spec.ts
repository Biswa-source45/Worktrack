import { expect, test, type Page } from '@playwright/test';
import {
  adminToken,
  createEmployee,
  listEmployees,
  uiLoginAsReadyAdmin,
  uniqueMobile,
  uniqueSuffix,
} from './helpers';

const searchBox = (page: Page) =>
  page.getByRole('textbox', { name: 'Search by name, code or mobile' });
const trigger = (page: Page, name: string) =>
  page.getByRole('button', { name: `Actions for ${name}`, exact: true });

// The e2e database keeps employees across runs, so every row is found through the search box.
async function openEmployees(page: Page, query?: string) {
  await uiLoginAsReadyAdmin(page);
  await page.getByRole('link', { name: 'Employees' }).click();
  await expect(page).toHaveURL(/\/employees$/);
  if (query) {
    await searchBox(page).fill(query);
    // The list is replaced by "Loading..." once the debounced search starts, so wait for the
    // filtered table (the header and the one match) before touching any row.
    await expect(page.getByRole('row')).toHaveCount(2);
  }
}

async function fillNewEmployee(page: Page, code: string, name: string, mobile: string) {
  await page.getByRole('button', { name: 'New employee' }).click();
  const form = page.getByRole('dialog', { name: 'New employee' });
  await form.getByLabel('Employee code').fill(code);
  await form.getByLabel('Full name').fill(name);
  await form.getByLabel('Mobile number').fill(mobile);
  await form.getByLabel('Designation').selectOption({ index: 1 });
  await form.getByLabel('Role').selectOption({ label: 'Office Employee' });
  await form.getByRole('button', { name: 'Save' }).click();
  return form;
}

async function confirm(page: Page, title: string) {
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await dialog.getByRole('button', { name: title, exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('admin creates, finds, edits, deactivates, reactivates and resets an employee', async ({
  page,
}) => {
  const suffix = uniqueSuffix();
  const code = `EMP${suffix}`;
  const name = `E2E Person ${suffix}`;
  const digits = uniqueMobile();
  const typed = `${digits.slice(0, 5)} ${digits.slice(5)}`;

  await openEmployees(page);

  // Create with a spaced mobile number; the one-time password is shown, then gone.
  const form = await fillNewEmployee(page, code, name, typed);
  const shown = page.getByRole('dialog', { name: 'Temporary password' });
  await expect(shown.getByText(/shown only once and cannot be retrieved later/)).toBeVisible();
  await shown.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(shown).toBeHidden();
  await expect(form).toBeHidden();

  // Search by code finds exactly this employee.
  await searchBox(page).fill(code);
  await expect(page.getByRole('row')).toHaveCount(2); // the header and the one match
  const row = page.getByRole('row', { name: new RegExp(code) });
  await expect(row).toContainText(name);
  await expect(row.getByTestId('status-active')).toBeVisible();

  // Search by the canonical mobile number works too.
  await searchBox(page).fill(`+91${digits}`);
  await expect(row).toBeVisible();
  await searchBox(page).fill(code);
  await expect(page.getByRole('row')).toHaveCount(2);

  // The stored number is the canonical +91 form.
  await trigger(page, name).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit employee' });
  await expect(edit.getByLabel('Mobile number')).toHaveValue(`+91${digits}`);

  // Edit through the menu: the name changes and the table follows.
  const renamed = `${name} Renamed`;
  await edit.getByLabel('Full name').fill(renamed);
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeHidden();
  await expect(row).toContainText(renamed);

  // Deactivate -> inactive badge, Reactivate -> active badge.
  await trigger(page, renamed).click();
  await page.getByRole('menuitem', { name: 'Deactivate' }).click();
  await confirm(page, 'Deactivate');
  await expect(row.getByTestId('status-inactive')).toBeVisible();
  await expect(row.getByTestId('status-active')).toHaveCount(0);

  await trigger(page, renamed).click();
  await expect(page.getByRole('menuitem', { name: 'Deactivate' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Reactivate' }).click();
  await confirm(page, 'Reactivate');
  await expect(row.getByTestId('status-active')).toBeVisible();

  // Reset password -> one-time temporary password with its warning, gone after Close.
  await trigger(page, renamed).click();
  await page.getByRole('menuitem', { name: 'Reset password' }).click();
  const reset = page.getByRole('dialog', { name: 'Reset password', exact: true });
  await reset.getByRole('button', { name: 'Reset password', exact: true }).click();
  const fresh = page.getByRole('dialog', { name: 'Temporary password' });
  await expect(fresh.getByText(/shown only once and cannot be retrieved later/)).toBeVisible();
  const password = (await fresh.locator('code').textContent()) ?? '';
  expect(password).toHaveLength(12);
  await fresh.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(fresh).toBeHidden();
  await expect(page.getByText(password)).toHaveCount(0);

  // Unlock only shows for locked accounts.
  await trigger(page, renamed).click();
  await expect(page.getByRole('menuitem', { name: 'Unlock' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('a second employee with the same number in another format is refused', async ({ page }) => {
  const token = await adminToken();
  const existing = await createEmployee(token);
  const suffix = uniqueSuffix();
  const code = `EMP${suffix}`;

  await openEmployees(page);
  const form = await fillNewEmployee(
    page,
    code,
    `E2E Twin ${suffix}`,
    `+91-${existing.mobile.slice(3)}`,
  );
  await expect(form.getByRole('alert')).toHaveText(
    'That employee code, mobile number or email is already in use.',
  );
  await expect(form).toBeVisible();
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toBeHidden();

  await searchBox(page).fill(code);
  await expect(page.getByText('No employees found.')).toBeVisible();
  expect((await listEmployees(token, code)).items).toHaveLength(0);
});

test('the row menu works from the keyboard and has an exact accessible name', async ({ page }) => {
  const token = await adminToken();
  const employee = await createEmployee(token);
  await openEmployees(page, employee.code);

  const button = trigger(page, employee.name);
  await expect(button).toBeVisible();
  const menu = page.getByRole('menu');

  await button.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Deactivate' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Reset password' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();

  await page.keyboard.press('Space');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();
});

test.describe('layout', () => {
  test('at 1280px the table fits without horizontal scroll', async ({ page }) => {
    const token = await adminToken();
    const longName = `E2E Layout ${'Very Long Name '.repeat(6)}${uniqueSuffix()}`.slice(0, 120);
    const employee = await createEmployee(token, longName);
    await page.setViewportSize({ width: 1280, height: 800 });
    await openEmployees(page, employee.code);

    const button = trigger(page, employee.name);
    await expect(button).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Mobile' })).toBeHidden();
    await expect(page.getByRole('columnheader', { name: 'Status' })).toBeVisible();

    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      const container = document.querySelector('table')?.parentElement as HTMLElement;
      return {
        page: root.scrollWidth - root.clientWidth,
        table: container.scrollWidth - container.clientWidth,
      };
    });
    expect(overflow.page).toBeLessThanOrEqual(0);
    expect(overflow.table).toBeLessThanOrEqual(0);

    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
  });

  test('from 2xl the Mobile column appears with the canonical number', async ({ page }) => {
    const token = await adminToken();
    const employee = await createEmployee(token);
    await page.setViewportSize({ width: 1700, height: 900 });
    await openEmployees(page, employee.code);

    await expect(page.getByRole('columnheader', { name: 'Mobile' })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(employee.code) })).toContainText(
      employee.mobile,
    );
    expect(employee.mobile).toMatch(/^\+91\d{10}$/);
  });
});
