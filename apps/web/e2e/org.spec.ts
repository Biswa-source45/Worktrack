import { expect, test, type Page } from '@playwright/test';
import {
  adminToken,
  api,
  apiLogin,
  changePassword,
  createEmployee,
  stubMapTiles,
  uiLoginAsReadyAdmin,
  uniqueSuffix,
} from './helpers';

// A full Google Maps link is read by the backend without any network call.
const PLACE = { lat: 28.612912, lng: 77.2295097 };
const LINK = `https://www.google.com/maps/place/India+Gate/@28.61,77.22,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d${PLACE.lat}!4d${PLACE.lng}`;

const menu = (page: Page, name: string) =>
  page.getByRole('button', { name: `Actions for ${name}`, exact: true });

test.beforeEach(async ({ page }) => {
  await stubMapTiles(page);
  await uiLoginAsReadyAdmin(page);
});

test('admin adds a branch from a pasted link, moves the pin on the map and deactivates it', async ({
  page,
}) => {
  const name = `E2E Branch ${uniqueSuffix()}`;
  await page.getByRole('link', { name: 'Branches' }).click();
  await page.getByRole('button', { name: 'Add branch' }).click();
  const form = page.getByRole('dialog', { name: 'Add branch' });

  await form.getByLabel('Paste a Google Maps link').fill(LINK);
  await form.getByRole('button', { name: 'Use link' }).click();
  await expect(form.getByRole('spinbutton', { name: 'Latitude' })).toHaveValue(String(PLACE.lat));
  await expect(form.getByRole('spinbutton', { name: 'Longitude' })).toHaveValue('77.22951');
  // The place name of the link fills the empty name field; the real map shows pin and circle.
  await expect(form.getByLabel('Branch name')).toHaveValue('India Gate');
  const map = form.getByRole('region', { name: /^Map: click to place the pin/ });
  await expect(map.locator('.leaflet-marker-icon')).toBeVisible();
  await expect(map.locator('path.fill-primary')).toBeVisible();

  // A click on the map moves the pin, and the typed coordinates follow.
  // Away from the zoom buttons in the top-left corner.
  await map.click({ position: { x: 220, y: 60 } });
  await expect(form.getByRole('spinbutton', { name: 'Latitude' })).not.toHaveValue(
    String(PLACE.lat),
  );

  await form.getByLabel('Branch name').fill(name);
  await form.getByLabel('Geofence radius (30 to 500 m)').fill('29');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByRole('alert').first()).toBeVisible();
  await form.getByLabel('Geofence radius (30 to 500 m)').fill('150');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toBeHidden();

  const row = page.getByRole('row', { name: new RegExp(name) });
  await expect(row).toContainText('150 m');
  await expect(row.getByTestId('status-active')).toBeVisible();

  await menu(page, name).click();
  await page.getByRole('menuitem', { name: 'Deactivate' }).click();
  const confirm = page.getByRole('dialog', { name: 'Deactivate', exact: true });
  await confirm.getByRole('button', { name: 'Deactivate', exact: true }).click();
  await expect(row.getByTestId('status-inactive')).toBeVisible();
});

test('the map tiles are dimmed in the dark theme and left alone in the light theme', async ({
  page,
}) => {
  await page.getByRole('link', { name: 'Branches' }).click();
  await page.getByRole('button', { name: 'Add branch' }).click();
  const tiles = page.getByRole('dialog', { name: 'Add branch' }).locator('.leaflet-tile-pane');
  const filter = () => tiles.evaluate((el) => getComputedStyle(el).filter);

  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(filter).toBe('none');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(filter).toContain('invert');
  // Only the tiles: the pin keeps its own colour.
  const pin = page.getByRole('dialog', { name: 'Add branch' }).locator('.leaflet-marker-pane');
  await expect(pin).toHaveCSS('filter', 'none');
});

test('a link that is not a Google Maps link is refused with a clear message', async ({ page }) => {
  await page.getByRole('link', { name: 'Branches' }).click();
  await page.getByRole('button', { name: 'Add branch' }).click();
  const form = page.getByRole('dialog', { name: 'Add branch' });
  await form.getByLabel('Paste a Google Maps link').fill('https://example.com/maps/@1,2');
  await form.getByRole('button', { name: 'Use link' }).click();
  await expect(form.getByText(/No location could be read from that link/)).toBeVisible();
});

test('admin adds a shift with 2nd and 4th Saturday off, and a holiday', async ({ page }) => {
  const suffix = uniqueSuffix();
  const shift = `E2E Shift ${suffix}`;
  await page.getByRole('link', { name: 'Shifts' }).click();
  await page.getByRole('button', { name: 'Add shift' }).click();
  const form = page.getByRole('dialog', { name: 'Add shift' });
  await form.getByLabel('Shift name').fill(shift);
  await form.getByLabel('Starts at').fill('10:00');
  await form.getByLabel('Ends at').fill('18:00');
  await form.getByLabel('Grace period (0 to 120 minutes)').fill('10');
  await form.getByLabel('Half-day hours').fill('4');
  await form.getByLabel('Full-day hours').fill('8');
  await form.getByLabel('Sunday', { exact: true }).selectOption({ label: 'Off every week' });
  await form
    .getByLabel('Saturday', { exact: true })
    .selectOption({ label: 'Off on selected weeks' });
  const weeks = form.getByRole('group', { name: 'Weeks of the month off on Saturday' });
  await weeks.getByLabel('2nd').check();
  await weeks.getByLabel('4th').check();
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toBeHidden();
  await expect(page.getByRole('row', { name: new RegExp(shift) })).toContainText(
    'Sunday; 2nd and 4th Saturday',
  );

  // Holidays live in the e2e database across runs, so each run takes a fresh day next year.
  const holiday = `E2E Holiday ${suffix}`;
  const next = new Date().getFullYear() + 1;
  const day = new Date(Date.UTC(next, 0, 1 + (Date.now() % 360))).toISOString().slice(0, 10);
  await page.getByRole('tab', { name: 'Holidays' }).click();
  await page.getByRole('combobox', { name: 'Year' }).selectOption(String(next));
  await page.getByRole('button', { name: 'Add holiday' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add holiday' });
  await dialog.getByLabel('Date').fill(day);
  await dialog.getByLabel('Holiday name').fill(holiday);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row', { name: new RegExp(holiday) })).toContainText('All branches');

  await page.getByRole('button', { name: `Delete ${holiday}` }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete holiday' });
  await confirm.getByRole('button', { name: /^Delete/ }).click();
  await expect(page.getByRole('row', { name: new RegExp(holiday) })).toHaveCount(0);
});

test('a setting is changed, survives a reload and is put back', async ({ page }) => {
  await page.getByRole('link', { name: 'Settings' }).click();
  const field = page.getByLabel('GPS maximum accuracy (m)');
  await expect(field).toHaveValue(/\d+/);
  const original = await field.inputValue();
  const save = page.getByRole('button', { name: 'Save' });
  await expect(save).toBeDisabled();

  await field.fill('9999');
  await save.click();
  await expect(page.getByRole('alert').first()).toBeVisible();

  await field.fill(original === '60' ? '55' : '60');
  await save.click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('GPS maximum accuracy (m)')).toHaveValue(
    original === '60' ? '55' : '60',
  );

  await page.getByLabel('GPS maximum accuracy (m)').fill(original);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
});

test('an employee gets a branch, a shift, an own weekly schedule and a home work location', async ({
  page,
}) => {
  const token = await adminToken();
  const suffix = uniqueSuffix();
  const branch = `E2E Office ${suffix}`;
  const shift = `E2E Hours ${suffix}`;
  await api('POST', '/admin/branches', token, { name: branch, lat: 12.9716, lng: 77.5946 });
  await api('POST', '/admin/shifts', token, {
    name: shift,
    start_time: '10:00',
    end_time: '18:00',
    grace_min: 10,
    half_day_hours: 4,
    full_day_hours: 8,
    weekly_offs: [{ weekday: 6, weeks: null }],
  });
  const employee = await createEmployee(token);

  await page.getByRole('link', { name: 'Employees' }).click();
  await page.getByRole('textbox', { name: 'Search by name, code or mobile' }).fill(employee.code);
  await expect(page.getByRole('row')).toHaveCount(2);
  await menu(page, employee.name).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: /Edit/ });
  await expect(edit.getByLabel('Can punch only at the home branch')).toBeDisabled();
  await edit.getByLabel('Home branch (optional)').selectOption({ label: branch });
  await edit.getByLabel('Shift (optional)').selectOption({ label: shift });
  await edit.getByLabel('Can punch only at the home branch').check();
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeHidden();

  await menu(page, employee.name).click();
  await page.getByRole('menuitem', { name: 'Schedule and home location' }).click();
  await expect(page).toHaveURL(new RegExp(`/employees/${employee.id}$`));
  await expect(page.getByRole('heading', { level: 1, name: employee.name })).toBeVisible();

  // From the shift alone: six office days and Sunday off in any 14 days.
  const schedule = page.getByRole('region', { name: 'Weekly schedule' });
  await expect(schedule.getByTestId('kind-off')).toHaveCount(2);
  await expect(schedule.getByTestId('kind-home')).toHaveCount(0);

  // Saturday and Sunday from home: the own schedule beats the shift's weekly off.
  await schedule.getByLabel('Saturday', { exact: true }).selectOption({ label: 'Home' });
  await schedule.getByLabel('Sunday', { exact: true }).selectOption({ label: 'Home' });
  await schedule.getByRole('button', { name: 'Save schedule' }).click();
  await expect(schedule.getByText('Schedule saved.')).toBeVisible();
  await expect(schedule.getByTestId('kind-home')).toHaveCount(4);
  await expect(schedule.getByTestId('kind-off')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Schedule history' })).toContainText(
    'Home: Sat, Sun',
  );

  const home = page.getByRole('region', { name: 'Home work location' });
  await home.getByRole('button', { name: 'Set location' }).click();
  const dialog = page.getByRole('dialog', { name: 'Set home work location' });
  await dialog.getByRole('spinbutton', { name: 'Latitude' }).fill('12.98');
  await dialog.getByRole('spinbutton', { name: 'Longitude' }).fill('77.6');
  await expect(dialog.locator('.leaflet-marker-icon')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(home.getByTestId('home-approved')).toBeVisible();
  await expect(
    home.getByRole('region', { name: 'Map of the location and its geofence circle' }),
  ).toBeVisible();

  await home.getByRole('button', { name: 'Remove' }).click();
  const confirm = page.getByRole('dialog').filter({ hasText: 'Remove the home work location' });
  await confirm.getByRole('button', { name: 'Remove' }).click();
  await expect(home.getByTestId('home-approved')).toHaveCount(0);
});

test('a home location request from the phone is listed without coordinates and approved on a map', async ({
  page,
}) => {
  const token = await adminToken();
  const employee = await createEmployee(token);
  // The employee's first phone is approved at once; the request must come from that phone.
  const phone = {
    device_id: `e2e-home-${employee.code}`.toLowerCase(),
    model: 'Pixel 8',
    os: 'Android 14',
    app_version: '1.0.0',
  };
  const first = await apiLogin(employee.code, employee.password, 'mobile', phone);
  const ready = await changePassword(first.access_token, employee.password, 'E2e-Home-Pass-7');
  await api('POST', '/me/home-location-requests', ready.access_token, {
    lat: 13.0827,
    lng: 80.2707,
    accuracy_m: 12,
  });

  await page.getByRole('link', { name: 'Employees' }).click();
  await page.getByRole('tab', { name: /^Home requests/ }).click();
  const row = page.getByRole('row', { name: new RegExp(employee.code) });
  await expect(row).toBeVisible();
  await expect(page.getByRole('tabpanel')).not.toContainText('13.0827');
  await expect(page.getByRole('tabpanel')).not.toContainText('80.2707');

  await page.getByRole('button', { name: `Review the request of ${employee.name}` }).click();
  const review = page.getByRole('dialog', { name: 'Home location request' });
  await expect(review.locator('.leaflet-marker-icon')).toBeVisible();
  await review.getByLabel('Radius (30 to 500 m)').fill('120');
  await review.getByRole('button', { name: 'Approve' }).click();
  await expect(review).toBeHidden();
  await expect(row).toHaveCount(0);

  const mine = await api<{ approved: { radius_m: number } | null; pending: unknown }>(
    'GET',
    '/me/home-location',
    ready.access_token,
  );
  expect(mine.approved?.radius_m).toBe(120);
  expect(mine.pending).toBeNull();
});
