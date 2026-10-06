import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  adminToken,
  api,
  apiLogin,
  atBranch,
  awayFrom,
  createEmployee,
  createPlace,
  createWaitingRequest,
  createWorker,
  employeeOnPhone,
  enrollFace,
  expectImagesLoaded,
  punchOk,
  sendPunch,
  stubMapTiles,
  uiLoginAsReadyAdmin,
  uniqueMobile,
  uniqueSuffix,
  type Asker,
  type Created,
} from './helpers';

// Captures every page in every theme and width for review (docs/DESIGN.md); it compares nothing.
// SHOTS_DIR / SHOTS_THEMES let a run save elsewhere or capture one theme only.
const DIR = path.resolve(process.env.SHOTS_DIR ?? path.join(__dirname, 'screenshots'));
const THEMES = (process.env.SHOTS_THEMES ?? 'light,dark').split(',') as ('light' | 'dark')[];
const WIDTHS = [1280, 768];

let fresh: Created; // an Admin/HR account still on its temporary password
let planned: Created; // an employee whose schedule and home location page is captured
let enrolled: Created; // an employee whose face enrollment waits for review
// Attendance: the names share a prefix, so one search shows the whole register of the shots.
const WORKERS = `Shots ${uniqueSuffix()}`;
let asking: Asker; // punched in, then asked to punch out from far away
let reviewing: { name: string; eventId: number }; // a selfie of a stranger, waiting for review

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

  enrolled = await createEmployee(token, `Face Review ${uniqueSuffix()}`);
  await enrollFace(await employeeOnPhone(enrolled));

  const place = await createPlace(token);
  const worked = await createWorker(token, place, `${WORKERS} Worked`);
  await punchOk(worked.phone, 'punch-in', atBranch(place));
  asking = await createWaitingRequest(token, place, `${WORKERS} Asking`);
  const stranger = await createWorker(token, place, `${WORKERS} Stranger`);
  const mismatch = await punchOk(stranger.phone, 'punch-in', atBranch(place), { face: 'b' });
  reviewing = { name: stranger.employee.name, eventId: mismatch.punch.id };
  // A refused attempt for the exceptions feed.
  await sendPunch(
    (await createWorker(token, place, `${WORKERS} Lost`)).phone,
    'punch-in',
    awayFrom(place),
  );
});

// The queues are oldest first and the e2e database keeps its rows: leave nothing waiting behind.
test.afterAll(async () => {
  const token = await adminToken();
  const remarks = 'Screenshots done';
  await api('PATCH', `/admin/punch-out-requests/${asking.requestId}/decision`, token, {
    decision: 'reject',
    remarks,
  });
  await api('POST', `/admin/punch-reviews/${reviewing.eventId}/decision`, token, {
    decision: 'reject',
    remarks,
  });
});

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`screenshots: ${theme} at ${width}px`, async ({ page, context }) => {
      test.setTimeout(180_000);
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

      await page.getByRole('tab', { name: /^Face enrollments/ }).click();
      await expect(page.getByRole('tabpanel').getByText(enrolled.name)).toBeVisible();
      await shot('face-enrollments');
      await page
        .getByRole('button', { name: `Review the face enrollment of ${enrolled.name}` })
        .click();
      const review = page.getByRole('dialog', { name: 'Face enrollment' });
      await expect(review.getByRole('img')).toHaveCount(3);
      await expect
        .poll(() =>
          review
            .getByRole('img')
            .evaluateAll((imgs) => imgs.every((i) => (i as HTMLImageElement).naturalWidth > 0)),
        )
        .toBe(true);
      await shot('face-review-dialog', false);
      await page.keyboard.press('Escape');

      await page.getByRole('link', { name: 'Attendance' }).click();
      await page.getByRole('textbox', { name: 'Search by name or code' }).fill(WORKERS);
      await expect(page.getByRole('table').getByRole('row')).toHaveCount(5);
      await shot('attendance');
      await page.getByRole('button', { name: `Actions for ${WORKERS} Worked` }).click();
      await page.getByRole('menuitem', { name: 'Details' }).click();
      const day = page.getByRole('dialog', { name: 'Attendance day' });
      await expectImagesLoaded(day.getByRole('img'));
      await shot('attendance-day-dialog', false);
      await page.keyboard.press('Escape');
      await expect(day).toBeHidden();
      await page.getByRole('button', { name: `Actions for ${WORKERS} Asking` }).click();
      await page.getByRole('menuitem', { name: 'Override' }).click();
      const override = page.getByRole('dialog', { name: 'Override this day' });
      await expect(override.getByLabel('Reason (required)')).toBeVisible();
      await shot('attendance-override-dialog', false);
      await page.keyboard.press('Escape');
      await expect(override).toBeHidden();

      // These dialogs hold a selfie, a map and a list of facts: give them room to show it all.
      await page.setViewportSize({ width, height: 1100 });
      await page.getByRole('tab', { name: /^Punch-out requests/ }).click();
      await expect(page.getByRole('table').getByText(asking.worker.employee.name)).toBeVisible();
      await shot('attendance-requests');
      await page
        .getByRole('button', {
          name: `Open the punch-out request of ${asking.worker.employee.name}`,
        })
        .click();
      const request = page.getByRole('dialog', { name: 'Punch-out request' });
      await expect(request.locator('.leaflet-marker-icon')).toBeVisible();
      await expectImagesLoaded(request.getByRole('img'));
      await shot('attendance-request-dialog', false);
      await page.keyboard.press('Escape');
      await expect(request).toBeHidden();

      await page.getByRole('tab', { name: /^Review/ }).click();
      await expect(page.getByRole('table').getByText(reviewing.name)).toBeVisible();
      await shot('attendance-reviews');
      await page.getByRole('button', { name: `Review the punch of ${reviewing.name}` }).click();
      const punchReview = page.getByRole('dialog', { name: 'Punch review' });
      await expectImagesLoaded(punchReview.getByRole('img'));
      await shot('attendance-review-dialog', false);
      await page.keyboard.press('Escape');
      await expect(punchReview).toBeHidden();

      await page.getByRole('tab', { name: 'Exceptions' }).click();
      await expect(
        page
          .getByRole('table')
          .getByRole('row')
          .filter({ hasText: `${WORKERS} Lost` }),
      ).toBeVisible();
      await shot('attendance-exceptions');
    });
  }
}

async function openEmployees(page: Page) {
  await page.getByRole('link', { name: 'Employees' }).click();
  await expect(page).toHaveURL(/\/employees$/);
  await expect(page.getByRole('row').nth(1)).toBeVisible();
}
