import { expect, test } from '@playwright/test';
import {
  adminToken,
  createEmployee,
  dashboard,
  readyAdmin,
  setEmployeeStatus,
  uiLoginAsReadyAdmin,
} from './helpers';

test('dashboard greets the admin, shows the live numbers and follows employee changes', async ({
  page,
}) => {
  const token = await adminToken();
  const start = await dashboard(token);

  await uiLoginAsReadyAdmin(page);
  await expect(page.getByRole('heading', { name: `Welcome, ${readyAdmin().name}` })).toBeVisible();
  await expect(page.getByTestId('health-indicator')).toHaveAttribute('data-state', 'connected');

  const stat = (id: string) => page.getByTestId(id);
  await expect(stat('stat-total')).toHaveText(String(start.employees_total));
  await expect(stat('stat-active')).toHaveText(String(start.employees_active));
  await expect(stat('stat-inactive')).toHaveText(String(start.employees_inactive));
  await expect(stat('stat-pending-devices')).toHaveText(String(start.pending_devices));
  await expect(page.getByRole('group', { name: 'Total employees' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Pending devices' })).toBeVisible();

  // A new employee raises total and active by exactly one.
  const employee = await createEmployee(token);
  await page.reload();
  await expect(stat('stat-total')).toHaveText(String(start.employees_total + 1));
  await expect(stat('stat-active')).toHaveText(String(start.employees_active + 1));
  await expect(stat('stat-inactive')).toHaveText(String(start.employees_inactive));

  // Deactivating moves one from active to inactive; the total stays.
  await setEmployeeStatus(token, employee.id, 'inactive');
  await page.reload();
  await expect(stat('stat-total')).toHaveText(String(start.employees_total + 1));
  await expect(stat('stat-active')).toHaveText(String(start.employees_active));
  await expect(stat('stat-inactive')).toHaveText(String(start.employees_inactive + 1));

  // The page numbers agree with the API at the end.
  const end = await dashboard(token);
  expect(end.employees_total).toBe(start.employees_total + 1);
  expect(end.employees_active).toBe(start.employees_active);
  expect(end.employees_inactive).toBe(start.employees_inactive + 1);
});
