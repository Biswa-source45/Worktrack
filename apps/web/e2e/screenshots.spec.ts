import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  adminToken,
  apiLogin,
  createEmployee,
  stubMapTiles,
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
let planned: Created; // an employee whose schedule and home location page is captured

test.beforeAll(async () => {
  const token = await adminToken();
  fresh = await createEmployee(token, undefined, 'Admin/HR');
  // One phone signed in to by two employees: a pending row with its reason for the devices page.
  const [holder, mover] = [await createEmployee(token), await createEmployee(token)];
  planned = holder;
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
      // Dialogs are captured at viewport size: their overlay covers the viewport, not the page.
      const shot = async (name: string, fullPage = true) => {
        // Let fonts and entrance animations settle so the capture shows the resting state.
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(400);
        await page.screenshot({
          path: path.join(DIR, `${name}-${theme}-${width}.png`),
          fullPage,
        });
      };
      await stubMapTiles(page);
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
      await shot('employee-dialog', false);
      const code = `EMP${uniqueSuffix()}`;
      await form.getByLabel('Employee code').fill(code);
      await form.getByLabel('Full name').fill(`E2E Shot ${code}`);
      await form.getByLabel('Mobile number').fill(uniqueMobile());
      await form.getByLabel('Designation').selectOption({ index: 1 });
      await form.getByLabel('Role').selectOption({ label: 'Office Employee' });
      await form.getByRole('button', { name: 'Save' }).click();
      const shown = page.getByRole('dialog', { name: 'Temporary password' });
      await expect(shown).toBeVisible();
      await shot('temp-password-dialog', false);
      await shown.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(shown).toBeHidden();

      await page.getByRole('button', { name: 'Import employees' }).click();
      const dialog = page.getByRole('dialog', { name: 'Import employees' });
      await expect(dialog).toBeVisible();
      await shot('import-dialog', false);
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

      await page.getByRole('link', { name: 'Sessions' }).click();
      await expect(page.getByRole('tabpanel').getByRole('row').nth(1)).toBeVisible();
      await shot('sessions');

      await page.getByRole('link', { name: 'Branches' }).click();
      await expect(page.getByRole('row').nth(1)).toBeVisible();
      await shot('branches');
      await page.getByRole('button', { name: 'Add branch' }).click();
      const branch = page.getByRole('dialog', { name: 'Add branch' });
      await branch.getByRole('spinbutton', { name: 'Latitude' }).fill('28.6129');
      await branch.getByRole('spinbutton', { name: 'Longitude' }).fill('77.2295');
      await expect(branch.locator('.leaflet-marker-icon')).toBeVisible();
      await shot('branch-dialog', false);
      await page.keyboard.press('Escape');
      await expect(branch).toBeHidden();

      await page.getByRole('link', { name: 'Shifts' }).click();
      await expect(page.getByRole('tabpanel').getByRole('row').nth(1)).toBeVisible();
      await shot('shifts');
      await page.getByRole('button', { name: 'Add shift' }).click();
      const shift = page.getByRole('dialog', { name: 'Add shift' });
      await shift
        .getByLabel('Saturday', { exact: true })
        .selectOption({ label: 'Off on selected weeks' });
      await shot('shift-dialog', false);
      await page.keyboard.press('Escape');
      await expect(shift).toBeHidden();
      await page.getByRole('tab', { name: 'Holidays' }).click();
      await expect(page.getByRole('button', { name: 'Add holiday' })).toBeVisible();
      await shot('holidays');

      await page.getByRole('link', { name: 'Settings' }).click();
      await expect(page.getByLabel('GPS maximum accuracy (m)')).toHaveValue(/\d+/);
      await shot('settings');

      await page.goto(`/employees/${planned.id}`);
      await expect(page.getByRole('region', { name: 'Weekly schedule' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Home work location' })).toBeVisible();
      await shot('employee-schedule-home');

      await page.getByRole('link', { name: 'Employees' }).first().click();
      await page.getByRole('tab', { name: /^Home requests/ }).click();
      await expect(page.getByRole('tabpanel')).toBeVisible();
      await shot('home-requests');
    });
  }
}

async function openEmployees(page: Page) {
  await page.getByRole('link', { name: 'Employees' }).click();
  await expect(page).toHaveURL(/\/employees$/);
  await expect(page.getByRole('row').nth(1)).toBeVisible();
}
