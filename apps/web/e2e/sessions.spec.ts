import { expect, test } from '@playwright/test';
import {
  adminToken,
  apiLogin,
  createEmployee,
  readyAdmin,
  refreshStatus,
  sessionCounts,
  uiLoginAsReadyAdmin,
} from './helpers';

test('admin sees web sessions with their browser and signs one out', async ({ page }) => {
  const token = await adminToken();
  // Another admin signed in to the portal from somewhere else (no browser: a plain API client).
  const other = await createEmployee(token, undefined, 'Admin/HR');
  const theirs = await apiLogin(other.code, other.password, 'web');

  await uiLoginAsReadyAdmin(page);
  const start = await sessionCounts(token);
  await page.getByRole('link', { name: 'Sessions' }).click();
  await expect(page).toHaveURL(/\/sessions$/);
  await expect(page.getByRole('heading', { name: 'Sessions', level: 1 })).toBeVisible();

  const tab = (name: RegExp) => page.getByRole('tab', { name });
  const rowOf = (name: string) =>
    page.getByRole('tabpanel').getByRole('row').filter({ hasText: name });
  await expect(tab(/^Active/)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('count-active')).toHaveText(String(start.active));
  await expect(page.getByTestId('count-ended')).toHaveText(String(start.ended));
  await expect(page.getByTestId('count-all')).toHaveText(String(start.active + start.ended));

  // This browser's own sign-in: named browser and OS, marked as the current session.
  const mine = rowOf(readyAdmin().name).filter({ has: page.getByTestId('current-session') });
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText(/Chrome \d+/);
  await expect(mine.getByTestId('status-active')).toBeVisible();

  // The other admin's sign-in is a web session, not a phone.
  const row = rowOf(other.name);
  await expect(row).toContainText(`${other.name} (${other.code})`);
  await expect(row).toContainText('Web');
  await expect(row.getByTestId('status-active')).toBeVisible();
  await page.getByLabel('Type').selectOption({ label: 'Mobile' });
  await expect(row).toHaveCount(0);
  await page.getByLabel('Type').selectOption({ label: 'All types' });
  await expect(row).toHaveCount(1);
  await page.getByRole('link', { name: 'Devices' }).click();
  await expect(page.getByRole('tabpanel')).toBeVisible();
  await expect(page.getByRole('tabpanel').getByText(other.code)).toHaveCount(0);
  await page.getByRole('link', { name: 'Sessions' }).click();

  // Sign it out (with confirmation): it leaves the Active tab and its token stops working.
  await row.getByRole('button', { name: `Sign out session of ${other.name}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign out this session' });
  await expect(dialog).toContainText(other.name);
  await dialog.getByRole('button', { name: 'Sign out this session' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId('count-active')).toHaveText(String(start.active - 1));
  await expect(page.getByTestId('count-ended')).toHaveText(String(start.ended + 1));
  expect(await refreshStatus(theirs.refresh_token)).toBe(401);

  await tab(/^Ended/).click();
  await expect(row.getByTestId('status-ended')).toBeVisible();
  await expect(row).toContainText('Signed out by an admin');
  await expect(row.getByRole('button', { name: /Sign out session/ })).toHaveCount(0);

  // The admin's own session was not touched.
  await tab(/^Active/).click();
  await expect(mine).toHaveCount(1);
});
