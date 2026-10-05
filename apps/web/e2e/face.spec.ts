import { expect, test, type Page } from '@playwright/test';
import {
  adminToken,
  api,
  createEmployee,
  employeeOnPhone,
  enrollFace,
  myFaceEnrollment,
  uiLoginAsReadyAdmin,
  uniqueSuffix,
} from './helpers';

// The photos are public-domain computer-generated faces; no real person is involved.

async function employeeWithEnrollment() {
  const token = await adminToken();
  const employee = await createEmployee(token, `Face E2E ${uniqueSuffix()}`);
  const phone = await employeeOnPhone(employee);
  await enrollFace(phone);
  return { employee, phone, token };
}

async function openReview(page: Page, name: string, status?: string) {
  await uiLoginAsReadyAdmin(page);
  await page.getByRole('link', { name: 'Employees' }).click();
  await page.getByRole('tab', { name: /^Face enrollments/ }).click();
  if (status) await page.getByLabel('Show').selectOption({ label: status });
  await page.getByRole('button', { name: `Review the face enrollment of ${name}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Face enrollment' });
  await expect(dialog.getByRole('img')).toHaveCount(3);
  // The photos come through the web portal's own proxy, with the signed link: they must load.
  await expect
    .poll(() =>
      dialog
        .getByRole('img')
        .evaluateAll((imgs) => imgs.every((i) => (i as HTMLImageElement).naturalWidth > 0)),
    )
    .toBe(true);
  return dialog;
}

test('admin sees the three photos, approves, and the employee is enrolled', async ({ page }) => {
  const { employee, phone } = await employeeWithEnrollment();
  expect((await myFaceEnrollment(phone)).status).toBe('pending');

  const dialog = await openReview(page, employee.name);
  await expect(dialog.getByText(/recorded in the audit log/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('button', { name: `Review the face enrollment of ${employee.name}` }),
  ).toBeHidden();

  expect((await myFaceEnrollment(phone)).status).toBe('approved');
  // The admin's look at the photos is in the audit trail of the enrollment.
  await page.getByLabel('Show').selectOption({ label: 'Approved' });
  await expect(page.getByRole('tabpanel').getByText(employee.name)).toBeVisible();
});

test('admin rejects with a reason, the photos are deleted and the employee is told why', async ({
  page,
}) => {
  const { employee, phone, token } = await employeeWithEnrollment();
  const dialog = await openReview(page, employee.name);

  await dialog.getByRole('button', { name: 'Reject' }).click();
  await expect(dialog.getByText('Give a reason for rejecting.')).toBeVisible();
  await dialog
    .getByLabel('Reason for rejecting (the employee sees it)')
    .fill('Your face is partly covered');
  await dialog.getByRole('button', { name: 'Reject' }).click();
  await expect(dialog).toBeHidden();

  expect(await myFaceEnrollment(phone)).toMatchObject({
    status: 'rejected',
    reason: 'Your face is partly covered',
  });
  // Nothing is left to look at: the closed enrollment has no photos.
  const list = await api<{ items: { id: number; employee: { id: number } }[] }>(
    'GET',
    '/admin/face-enrollments?status=rejected&limit=200',
    token,
  );
  const mine = list.items.find((item) => item.employee.id === employee.id);
  expect(mine).toBeDefined();
  const detail = await api<{ photos: string[] }>(
    'GET',
    `/admin/face-enrollments/${mine?.id}`,
    token,
  );
  expect(detail.photos).toEqual([]);
});

test('admin resets an approved enrollment, and the employee must enroll again', async ({
  page,
}) => {
  const { employee, phone, token } = await employeeWithEnrollment();
  const list = await api<{
    items: { id: number; submitted_at: string; employee: { id: number } }[];
  }>('GET', '/admin/face-enrollments?limit=200', token);
  const mine = list.items.find((item) => item.employee.id === employee.id);
  await api('POST', `/admin/face-enrollments/${mine?.id}/approve`, token, {
    submitted_at: mine?.submitted_at,
  });

  const dialog = await openReview(page, employee.name, 'Approved');
  await expect(dialog.getByRole('button', { name: 'Approve' })).toBeHidden();
  await dialog.getByRole('button', { name: 'Reset enrollment' }).click();
  await expect(dialog.getByText('Give a reason for rejecting.')).toBeVisible();
  await dialog.getByLabel(/Reason for resetting/).fill('Grew a beard');
  await dialog.getByRole('button', { name: 'Reset enrollment' }).click();
  await expect(dialog).toBeHidden();

  expect(await myFaceEnrollment(phone)).toMatchObject({ status: 'reset', reason: 'Grew a beard' });
});

test('the face matching settings can be read and are validated before saving', async ({ page }) => {
  await uiLoginAsReadyAdmin(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  const face = page.getByRole('group', { name: 'Face matching' });
  await expect(face.getByLabel('Verify threshold')).toHaveValue(/^0\.\d+$/);
  await face.getByLabel('Review threshold').fill('0.95');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(face.getByText('Enter a number within the allowed range.')).toBeVisible();
});
