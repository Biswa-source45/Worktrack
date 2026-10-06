import { expect, test, type Page } from '@playwright/test';
import {
  adminToken,
  api,
  atBranch,
  awayFrom,
  createPlace,
  createWorker,
  expectImagesLoaded,
  punchOk,
  sendPunch,
  uiLoginAsReadyAdmin,
  type Place,
} from './helpers';

// A selfie of person B against an enrolled person A is a mismatch: the punch is kept, but waits
// for a person to decide whether it counts.
let place: Place;
let token: string;

async function mismatch() {
  const worker = await createWorker(token, place);
  const { punch, result } = await punchOk(worker.phone, 'punch-in', atBranch(place), { face: 'b' });
  expect(result).toBe('in_review');
  return { worker, eventId: punch.id };
}

test.beforeAll(async () => {
  token = await adminToken();
  place = await createPlace(token);
});

const reviewStatus = async (eventId: number) =>
  (
    await api<{ review_status: string; review_remarks: string | null }>(
      'GET',
      `/admin/punch-reviews/${eventId}`,
      token,
    )
  ).review_status;

async function openReview(page: Page, name: string) {
  await uiLoginAsReadyAdmin(page);
  await page.getByRole('link', { name: 'Attendance' }).click();
  await page.getByRole('tab', { name: /^Review/ }).click();
  await page.getByRole('button', { name: `Review the punch of ${name}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Punch review' });
  await expect(dialog.getByText(/recorded in the audit log/)).toBeVisible();
  return dialog;
}

test('a face mismatch waits in the review queue, and an admin approves it', async ({ page }) => {
  const { worker, eventId } = await mismatch();
  const dialog = await openReview(page, worker.employee.name);
  await expectImagesLoaded(dialog.getByRole('img'));
  // Two places say it: the reason it waits, and the server's verdict on the selfie.
  await expect(dialog.getByText('Face mismatch')).toHaveCount(2);
  await expect(dialog.getByText(/accepted from \d\.\d+, review from \d\.\d+/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(dialog).toBeHidden();
  expect(await reviewStatus(eventId)).toBe('approved');
});

test('a punch is rejected only with a reason', async ({ page }) => {
  const { worker, eventId } = await mismatch();
  const dialog = await openReview(page, worker.employee.name);
  await dialog.getByRole('button', { name: 'Reject' }).click();
  await expect(dialog.getByText('Give a reason for rejecting.')).toBeVisible();
  expect(await reviewStatus(eventId)).toBe('pending');

  await dialog.getByLabel('Remarks (required to reject)').fill('Not the employee');
  await dialog.getByRole('button', { name: 'Reject' }).click();
  await expect(dialog).toBeHidden();
  expect(await reviewStatus(eventId)).toBe('rejected');
});

test('the exceptions feed shows an attempt outside the geofence', async ({ page }) => {
  const worker = await createWorker(token, place);
  const refused = await sendPunch(worker.phone, 'punch-in', awayFrom(place));
  expect(refused.status).toBe(422);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
    'OUTSIDE_GEOFENCE',
  );

  await uiLoginAsReadyAdmin(page);
  await page.getByRole('link', { name: 'Attendance' }).click();
  await page.getByRole('tab', { name: 'Exceptions' }).click();
  await page.getByLabel('Kind').selectOption({ label: 'Outside the geofence' });
  const row = page.getByRole('table').getByRole('row').filter({ hasText: worker.employee.name });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Outside the geofence');
  await expect(row).toContainText(place.name);
});
