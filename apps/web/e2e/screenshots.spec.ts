import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  adminToken,
  apiLogin,
  createEmployee,
  uiLoginAsReadyAdmin,
  uniqueMobile,
  uniqueSuffix,
  type Created,
} from './helpers';

// Captures every page in every theme and width for review (docs/DESIGN.md); it compares nothing.
// SHOTS_DIR / SHOTS_THEMES let a run save elsewhere or capture one theme only.
const DIR = path.resolve(process.env.SHOTS_DIR ?? path.join(__dirname, 'screenshots'));
const THEMES = (process.env.SHOTS_THEMES ?? 'light,dark').split(',') as ('light' | 'dark')[];
const WIDTHS = [1280, 768];

let fresh: Created; // an Admin/HR account still on its temporary password

test.beforeAll(async () => {
  const token = await adminToken();
  fresh = await createEmployee(token, undefined, 'Admin/HR');
  // One phone signed in to by two employees: a pending row with its reason for the devices page.
  const [holder, mover] = [await createEmployee(token), await createEmployee(token)];
  const phone = {
    device_id: `e2e-shot-${holder.code}`.toLowerCase(),
    model: 'Pixel 8',
    os: 'Android 14',
    app_version: '1.0.0',
  };
  await apiLogin(holder.code, holder.password, 'mobile', phone);
  await apiLogin(mover.code, mover.password, 'mobile', phone);
});

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`screenshots: ${theme} at ${width}px`, async ({ page, context }) => {
      test.setTimeout(120_000);
      const shot = async (name: string) => {
        // Let fonts and entrance animations settle so the capture shows the resting state.
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(400);
        await page.screenshot({
          path: path.join(DIR, `${name}-${theme}-${width}.png`),
          fullPage: true,
        });
      };
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((value) => localStorage.setItem('wt-theme', value), theme);

      await page.goto('/login');
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
      await shot('login');

      await page.getByLabel('Employee ID or mobile number').fill(fresh.code);
      await page.getByLabel('Password', { exact: true }).fill(fresh.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page).toHaveURL(/\/change-password$/);
      await expect(page.getByRole('button', { name: 'Change password' })).toBeVisible();
      await shot('change-password');
      await context.clearCookies();

      await uiLoginAsReadyAdmin(page);
      await expect(page.getByText('Pending devices')).toBeVisible();
      await shot('dashboard');

      await openEmployees(page);
      await shot('employees');

      await page.getByRole('button', { name: 'New employee' }).click();
      const form = page.getByRole('dialog', { name: 'New employee' });
      await expect(form.getByLabel('Employee code')).toBeVisible();
      await shot('employee-dialog');
      const code = `EMP${uniqueSuffix()}`;
      await form.getByLabel('Employee code').fill(code);
      await form.getByLabel('Full name').fill(`E2E Shot ${code}`);
      await form.getByLabel('Mobile number').fill(uniqueMobile());
      await form.getByLabel('Designation').selectOption({ index: 1 });
      await form.getByLabel('Role').selectOption({ label: 'Office Employee' });
      await form.getByRole('button', { name: 'Save' }).click();
      const shown = page.getByRole('dialog', { name: 'Temporary password' });
      await expect(shown).toBeVisible();
      await shot('temp-password-dialog');
      await shown.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(shown).toBeHidden();

      await page.getByRole('button', { name: 'Import employees' }).click();
      const dialog = page.getByRole('dialog', { name: 'Import employees' });
      await expect(dialog).toBeVisible();
      await shot('import-dialog');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();

      await page
        .getByRole('textbox', { name: 'Search by name, code or mobile' })
        .fill('no-such-employee-zzz');
      await expect(page.getByRole('row')).toHaveCount(2); // the header and the empty-state row
      await shot('employees-empty');

      await page.getByRole('link', { name: 'Devices' }).click();
      await expect(page.getByRole('tabpanel').getByRole('row').nth(1)).toBeVisible();
      await shot('devices');
      await page.getByRole('tab', { name: /^Pending/ }).click();
      await expect(page.getByText(/already active for/).first()).toBeVisible();
      await shot('devices-pending');
    });
  }
}

async function openEmployees(page: Page) {
  await page.getByRole('link', { name: 'Employees' }).click();
  await expect(page).toHaveURL(/\/employees$/);
  await expect(page.getByRole('row').nth(1)).toBeVisible();
}
