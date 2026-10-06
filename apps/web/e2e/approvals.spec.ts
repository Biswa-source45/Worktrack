import { expect, test, type Page } from '@playwright/test';
import {
  adminToken,
  api,
  createPlace,
  createWaitingRequest,
  expectImagesLoaded,
  nextIstMinute,
  stubMapTiles,
  uiLoginAsReadyAdmin,
  type Asker,
  type Place,
} from './helpers';

// Two employees who punched in at the branch and then asked to punch out from 5.5 km away.
let place: Place;
let approve: Asker;
let reject: Asker;
let token: string;

test.beforeAll(async () => {
  token = await adminToken();
  place = await createPlace(token);
  [approve, reject] = [
    await createWaitingRequest(token, place),
    await createWaitingRequest(token, place),
  ];
});

async function openRequest(page: Page, who: Asker) {
  await stubMapTiles(page);
  await uiLoginAsReadyAdmin(page);
  await page.getByRole('link', { name: 'Attendance' }).click();
  await page.getByRole('tab', { name: /^Punch-out requests/ }).click();
  await page
    .getByRole('button', { name: `Open the punch-out request of ${who.worker.employee.name}` })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Punch-out request' });
  await expect(dialog.getByText(/recorded in the audit log/)).toBeVisible();
  return dialog;
}

const decision = (id: number) =>
  api<{ status: string; approved_time: string | null; remarks: string | null }>(
    'GET',
    `/admin/punch-out-requests/${id}`,
    token,
  );

test('a waiting request shows where it was made and its selfie, and is approved with another time', async ({
  page,
}) => {
  const dialog = await openRequest(page, approve);
  // The pin map and the typed coordinates are both there; the selfie loads through the proxy.
  await expect(
    dialog.getByRole('region', { name: 'Map of the location and its geofence circle' }),
  ).toBeVisible();
  await expect(
    dialog.getByText(/Where the request was made: \d+\.\d{6}, \d+\.\d{6}/),
  ).toBeVisible();
  await expect(dialog.getByText(new RegExp(`${place.name}, \\d+ m away`))).toBeVisible();
  await expectImagesLoaded(dialog.getByRole('img'));
  await expect(dialog.getByText('Client site visit')).toBeVisible();

  // The edited time has to fall between the punch-in and now, on a whole minute: wait for one.
  const minute = nextIstMinute(approve.punchedInAt);
  await expect.poll(() => Date.now() >= minute.at + 1000, { timeout: 70_000 }).toBe(true);
  await dialog.getByRole('button', { name: 'Approve with a different time' }).click();
  await dialog.getByLabel('Approved time (IST)').fill(minute.local);
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(dialog).toBeHidden();

  const after = await decision(approve.requestId);
  expect(after.status).toBe('approved');
  expect(Date.parse(after.approved_time as string)).toBe(minute.at);
  await expect(
    page.getByRole('button', {
      name: `Open the punch-out request of ${approve.worker.employee.name}`,
    }),
  ).toBeHidden();
});

test('a request is rejected only with a reason', async ({ page }) => {
  const dialog = await openRequest(page, reject);
  await dialog.getByRole('button', { name: 'Reject' }).click();
  await expect(dialog.getByText('Give a reason for rejecting.')).toBeVisible();
  expect((await decision(reject.requestId)).status).toBe('pending');

  await dialog.getByLabel('Remarks (required to reject)').fill('Not on the visit list');
  await dialog.getByRole('button', { name: 'Reject' }).click();
  await expect(dialog).toBeHidden();
  expect(await decision(reject.requestId)).toMatchObject({
    status: 'rejected',
    remarks: 'Not on the visit list',
  });
});
