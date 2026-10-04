import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  adminToken,
  apiLogin,
  createEmployee,
  deviceCounts,
  uiLoginAsReadyAdmin,
  type Device,
} from './helpers';

// The e2e database keeps devices across runs and the list pages 50 at a time (oldest first),
// so a fresh phone may sit behind "Load more".
async function reveal(row: Locator, page: Page) {
  const more = page.getByRole('button', { name: 'Load more' });
  await expect(async () => {
    if ((await row.count()) === 0 && (await more.count()) > 0 && (await more.isEnabled())) {
      await more.click();
    }
    expect(await row.count()).toBeGreaterThan(0);
  }).toPass({ timeout: 30_000 });
}

async function expectCounts(
  page: Page,
  token: string,
  expected: Awaited<ReturnType<typeof deviceCounts>>,
) {
  expect(await deviceCounts(token)).toEqual(expected);
  await expect(page.getByTestId('count-pending')).toHaveText(String(expected.pending));
  await expect(page.getByTestId('count-active')).toHaveText(String(expected.active));
  await expect(page.getByTestId('count-revoked')).toHaveText(String(expected.revoked));
  await expect(page.getByTestId('count-all')).toHaveText(
    String(expected.pending + expected.active + expected.revoked),
  );
}

test('admin approves and revokes phones from the devices page', async ({ page }) => {
  const token = await adminToken();
  const employee = await createEmployee(token);
  const suffix = employee.code;
  const phone = (label: string): Device => ({
    device_id: `e2e-${label}-${suffix}`.toLowerCase(),
    model: `Phone ${label} ${suffix}`,
    os: 'Android 14',
    app_version: '1.0.0',
  });
  const [a, b] = [phone('A'), phone('B')];
  // The first phone becomes active at once, the second waits for approval; both sign in even
  // though the temporary password still has to be changed.
  await apiLogin(employee.code, employee.password, 'mobile', a);
  await apiLogin(employee.code, employee.password, 'mobile', b);
  const start = await deviceCounts(token);

  await uiLoginAsReadyAdmin(page);
  await page.getByRole('link', { name: 'Devices' }).click();
  await expect(page).toHaveURL(/\/devices$/);

  const tab = (name: RegExp) => page.getByRole('tab', { name });
  await expect(tab(/^All/)).toHaveAttribute('aria-selected', 'true');
  await expectCounts(page, token, start);

  const rowOf = (device: Device) =>
    page.getByRole('tabpanel').getByRole('row').filter({ hasText: device.model });

  // All tab: the first phone is Active, the second Pending.
  await reveal(rowOf(a), page);
  await reveal(rowOf(b), page);
  await expect(rowOf(a).getByTestId('status-active')).toBeVisible();
  await expect(rowOf(b).getByTestId('status-pending')).toBeVisible();
  await expect(rowOf(a)).toContainText(`${employee.name} (${employee.code})`);

  // Pending tab: only pending phones, including the new one.
  await tab(/^Pending/).click();
  await expect(tab(/^Pending/)).toHaveAttribute('aria-selected', 'true');
  await reveal(rowOf(b), page);
  await expect(rowOf(a)).toHaveCount(0);
  const panel = page.getByRole('tabpanel');
  await expect(panel.getByTestId('status-active')).toHaveCount(0);
  await expect(panel.getByTestId('status-revoked')).toHaveCount(0);

  // Approve (with confirmation): the new phone is Active, the old one Revoked.
  await rowOf(b).getByRole('button', { name: 'Approve' }).click();
  const approve = page.getByRole('dialog', { name: 'Approve' });
  await expect(approve).toContainText(b.model);
  await approve.getByRole('button', { name: 'Approve' }).click();
  await expect(approve).toBeHidden();
  await expect(rowOf(b)).toHaveCount(0);
  const approved = { pending: start.pending - 1, active: start.active, revoked: start.revoked + 1 };
  await expectCounts(page, token, approved);

  await tab(/^All/).click();
  await reveal(rowOf(a), page);
  await reveal(rowOf(b), page);
  await expect(rowOf(a).getByTestId('status-revoked')).toBeVisible();
  await expect(rowOf(b).getByTestId('status-active')).toBeVisible();

  // Revoke the now-active phone.
  await rowOf(b).getByRole('button', { name: 'Revoke' }).click();
  const revoke = page.getByRole('dialog', { name: 'Revoke' });
  await revoke.getByRole('button', { name: 'Revoke' }).click();
  await expect(revoke).toBeHidden();
  await expect(rowOf(b).getByTestId('status-revoked')).toBeVisible();
  await expectCounts(page, token, {
    pending: approved.pending,
    active: approved.active - 1,
    revoked: approved.revoked + 1,
  });
  await expect(rowOf(b).getByRole('button', { name: 'Revoke' })).toHaveCount(0);
});

test('a phone that is active for another employee waits with the reason until approved', async ({
  page,
}) => {
  const token = await adminToken();
  const [holder, mover] = [await createEmployee(token), await createEmployee(token)];
  const shared: Device = {
    device_id: `e2e-shared-${holder.code}`.toLowerCase(),
    model: `Shared phone ${holder.code}`,
    os: 'Android 14',
    app_version: '1.0.0',
  };
  // The holder's first sign-in makes the phone Active; the second employee must wait.
  await apiLogin(holder.code, holder.password, 'mobile', shared);
  await apiLogin(mover.code, mover.password, 'mobile', shared);
  const start = await deviceCounts(token);

  await uiLoginAsReadyAdmin(page);
  await page.getByRole('link', { name: 'Devices' }).click();
  const rowOf = (name: string) =>
    page.getByRole('tabpanel').getByRole('row').filter({ hasText: name });

  await reveal(rowOf(mover.name), page);
  await expect(rowOf(holder.name).getByTestId('status-active')).toBeVisible();
  await expect(rowOf(mover.name).getByTestId('status-pending')).toBeVisible();
  await expect(rowOf(mover.name)).toContainText(
    `This phone is already active for ${holder.name} (${holder.code})`,
  );

  await rowOf(mover.name).getByRole('button', { name: 'Approve' }).click();
  const approve = page.getByRole('dialog', { name: 'Approve' });
  await expect(approve).toContainText(`This phone is active for ${holder.name} (${holder.code})`);
  await approve.getByRole('button', { name: 'Approve' }).click();
  await expect(approve).toBeHidden();

  // The phone moved: the new employee is Active, the previous holder Revoked, reason gone.
  await expect(rowOf(mover.name).getByTestId('status-active')).toBeVisible();
  await expect(rowOf(holder.name).getByTestId('status-revoked')).toBeVisible();
  await expect(rowOf(mover.name)).not.toContainText('already active for');
  await expectCounts(page, token, {
    pending: start.pending - 1,
    active: start.active,
    revoked: start.revoked + 1,
  });
});
