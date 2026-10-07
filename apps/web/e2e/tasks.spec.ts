import { expect, test } from '@playwright/test';
import {
  adminToken,
  createAssigner,
  createFieldWorker,
  createPlace,
  createTaskApi,
  goTo,
  randomSite,
  sendPunch,
  stubMapTiles,
  taskStep,
  uiLogin,
  uiLoginAsReadyAdmin,
  uniqueSuffix,
} from './helpers';

test('an admin creates a task with a pin and two people, and follows it to Closed', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const token = await adminToken();
  const prefix = `E2E Field ${uniqueSuffix()}`;
  const [first, second] = [
    await createFieldWorker(token, `${prefix} One`),
    await createFieldWorker(token, `${prefix} Two`),
  ];
  const site = randomSite();
  const title = `Collect cheque ${uniqueSuffix()}`;
  await stubMapTiles(page);
  await uiLoginAsReadyAdmin(page);
  await goTo(page, 'Tasks');
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();

  // --- create: details, a pin (typed), two people, one brief ---
  await page.getByRole('button', { name: 'New task' }).click();
  const form = page.getByRole('dialog', { name: 'New task' });
  await form.getByLabel('Title').fill(title);
  await form.getByLabel('Task type').selectOption({ index: 1 });
  await form.getByLabel('Client').fill('Acme Traders');
  await form.getByRole('textbox', { name: 'Address', exact: true }).fill('MG Road, test site');
  await form.getByRole('spinbutton', { name: 'Latitude' }).fill(String(site.lat));
  await form.getByRole('spinbutton', { name: 'Longitude' }).fill(String(site.lng));
  await expect(form.locator('.leaflet-marker-icon')).toBeVisible();
  await form.getByRole('textbox', { name: 'Search people by name or code' }).fill(prefix);
  await form.getByRole('checkbox', { name: new RegExp(`${prefix} One`) }).check();
  await form.getByRole('checkbox', { name: new RegExp(`${prefix} Two`) }).check();
  await expect(form.getByText('2 people chosen')).toBeVisible();
  await form.getByLabel('Briefs (optional)').setInputFiles({
    name: 'brief.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% e2e brief\n'),
  });
  await form.getByRole('button', { name: 'Create task' }).click();
  await expect(form).toBeHidden();

  // --- board: in the Assigned column, with both names ---
  const assigned = page.getByRole('region', { name: 'Assigned', exact: true });
  await page.getByRole('textbox', { name: 'Search by title, client or code' }).fill(title);
  const card = assigned.getByRole('listitem').filter({ hasText: title });
  await expect(card).toBeVisible();
  await expect(card).toContainText(`${prefix} One`);

  // --- detail: both people, the brief, the site ---
  await card.getByRole('link', { name: title }).click();
  await expect(page).toHaveURL(/\/tasks\/\d+$/);
  const taskId = Number(page.url().split('/').pop());
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByRole('group', { name: `${prefix} One` })).toBeVisible();
  await expect(page.getByRole('group', { name: `${prefix} Two` })).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Files' }).getByRole('region', { name: 'Briefs' }),
  ).toContainText('brief.pdf');
  await expect(page.locator('.leaflet-marker-icon')).toBeVisible();

  // --- the phones: both accept and reach the site; one finishes ---
  for (const worker of [first, second]) {
    await taskStep(worker.phone, taskId, 'accept');
    await taskStep(worker.phone, taskId, 'reached', { site });
    await taskStep(worker.phone, taskId, 'start');
  }
  await taskStep(first.phone, taskId, 'complete', { remarks: 'Cheque handed over' });
  await page.reload();
  await expect(page.getByTestId('task-status-in_progress').first()).toBeVisible();
  const onSite = page.getByRole('group', { name: `${prefix} Two` });
  await expect(onSite.getByRole('region', { name: 'Reached' })).toContainText('Face verified');
  await expect(onSite.getByRole('img', { name: /Selfie of/ })).toBeVisible();
  // No Close while someone is still working.
  await expect(page.getByRole('button', { name: 'Close task' })).toBeHidden();

  // --- the second finishes: the task is Completed and can be reopened or closed ---
  await taskStep(second.phone, taskId, 'complete', { remarks: 'Signed copy collected' });
  await page.reload();
  await expect(page.getByTestId('task-status-completed').first()).toBeVisible();
  await expect(
    page.getByRole('group', { name: `${prefix} One` }).getByText('Cheque handed over'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Reopen' }).click();
  const reopen = page.getByRole('dialog', { name: 'Reopen this task?' });
  await reopen.getByRole('button', { name: 'Reopen' }).click();
  await expect(reopen.getByText('This field is required.')).toBeVisible();
  await reopen.getByRole('checkbox', { name: `${prefix} Two` }).uncheck();
  await reopen.getByLabel('Why it is reopened').fill('Cheque number missing on the receipt');
  await reopen.getByRole('button', { name: 'Reopen' }).click();
  await expect(reopen).toBeHidden();
  await expect(page.getByTestId('task-status-in_progress').first()).toBeVisible();
  await expect(page.getByRole('group', { name: 'Timeline' })).toContainText('Reopened');

  await taskStep(first.phone, taskId, 'complete', { remarks: 'Number added' });
  await page.reload();
  await page.getByRole('button', { name: 'Close task' }).click();
  const close = page.getByRole('dialog', { name: 'Close this task?' });
  await close.getByLabel(/Closing comment/).fill('Checked and filed');
  await close.getByRole('button', { name: 'Close task' }).click();
  await expect(close).toBeHidden();
  await expect(page.getByTestId('task-status-closed').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeHidden();

  // --- a comment with the thread on the page ---
  await expect(page.getByRole('group', { name: 'Comments' })).toBeVisible();

  // --- back on the board: closed tasks are behind the toggle ---
  await goTo(page, 'Tasks');
  await page.getByRole('textbox', { name: 'Search by title, client or code' }).fill(title);
  await expect(page.getByText(title)).toBeHidden();
  await page.getByRole('checkbox', { name: 'Show closed and cancelled' }).check();
  await expect(
    page.getByRole('region', { name: 'Closed', exact: true }).getByText(title),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'List' }).click();
  await expect(page.getByRole('row', { name: new RegExp(title) })).toBeVisible();
});

test('a task nobody has accepted can be edited, given another person and cancelled', async ({
  page,
}) => {
  const token = await adminToken();
  const [one, two] = [await createFieldWorker(token), await createFieldWorker(token)];
  const task = await createTaskApi(token, [one.employee.id]);
  await uiLoginAsReadyAdmin(page);
  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByRole('heading', { name: task.title })).toBeVisible();

  await page.getByRole('button', { name: 'Add people' }).click();
  const add = page.getByRole('dialog', { name: 'Add people' });
  await add.getByRole('textbox', { name: 'Search people by name or code' }).fill(two.employee.name);
  await add.getByRole('checkbox', { name: new RegExp(two.employee.name) }).check();
  await add.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('group', { name: two.employee.name })).toBeVisible();

  await page.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit task' });
  await edit.getByLabel('Client').fill('Acme Ltd');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeHidden();
  await expect(page.getByRole('group', { name: 'Details' })).toContainText('Acme Ltd');

  await page.getByRole('button', { name: 'Remove ' + two.employee.name }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('group', { name: two.employee.name })).toBeHidden();

  await page.getByRole('button', { name: 'Cancel task' }).click();
  const cancel = page.getByRole('dialog', { name: 'Cancel this task?' });
  await cancel.getByRole('button', { name: 'Cancel task' }).click();
  await expect(cancel.getByText('This field is required.')).toBeVisible();
  await cancel.getByLabel('Reason').fill('Client postponed the visit');
  await cancel.getByRole('button', { name: 'Cancel task' }).click();
  await expect(page.getByTestId('task-status-cancelled').first()).toBeVisible();
  await expect(page.getByRole('group', { name: 'Details' })).toContainText(
    'Client postponed the visit',
  );
});

test('a Task Assigner sees only their own tasks, and no other admin screens', async ({ page }) => {
  const token = await adminToken();
  const worker = await createFieldWorker(token);
  const others = await createTaskApi(token, [worker.employee.id]);
  const assigner = await createAssigner(token);
  const mine = await createTaskApi(assigner.token, [worker.employee.id]);

  await stubMapTiles(page);
  await uiLogin(page, assigner.code, assigner.password);
  await expect(
    page.getByRole('navigation').getByRole('link', { name: 'Tasks', exact: true }),
  ).toBeVisible();
  for (const name of ['Employees', 'Branches', 'Settings', 'Devices']) {
    await expect(page.getByRole('navigation').getByRole('link', { name })).toBeHidden();
  }

  await goTo(page, 'Tasks');
  await page.getByRole('textbox', { name: 'Search by title, client or code' }).fill('E2E Task');
  await expect(page.getByRole('link', { name: mine.title })).toBeVisible();
  await expect(page.getByRole('link', { name: others.title })).toBeHidden();

  // Someone else's task is not found, not forbidden: its existence is not revealed.
  await page.goto(`/tasks/${others.id}`);
  await expect(
    page.getByText('This task does not exist, or it is outside your scope.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit' })).toBeHidden();

  // Their own task, with every manager action.
  await page.goto(`/tasks/${mine.id}`);
  await expect(page.getByRole('button', { name: 'Cancel task' })).toBeVisible();
  // Nothing else of the admin portal opens either.
  await page.goto('/employees');
  await expect(page.getByText(/do not have access/)).toBeVisible();
});

test('the landing page counts the tasks I assigned and names the ones that need me', async ({
  page,
}) => {
  const token = await adminToken();
  const worker = await createFieldWorker(token);
  const assigner = await createAssigner(token);
  await createTaskApi(assigner.token, [worker.employee.id], { title: 'Waiting job' });
  const site = randomSite();
  const finished = await createTaskApi(assigner.token, [worker.employee.id], {
    title: 'Finished job',
    site,
  });
  for (const step of ['accept', 'reached', 'start', 'complete'] as const) {
    await taskStep(worker.phone, finished.id, step, { site });
  }

  await uiLogin(page, assigner.code, assigner.password);
  const card = page.getByRole('group', { name: 'Tasks I assigned' });
  await expect(card.getByTestId('count-assigned')).toHaveText('1');
  await expect(card.getByTestId('count-completed')).toHaveText('1');
  await expect(card.getByTestId('count-accepted')).toHaveText('0');
  const attention = card.getByRole('region', { name: 'Needs your attention' });
  await expect(attention.getByRole('listitem')).toHaveCount(1);
  await expect(attention).toContainText('Finished job');
  await expect(attention).toContainText('Done, waiting to be closed');
  await attention.getByRole('link', { name: 'Finished job' }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${finished.id}$`));
});

test('with the switch on, a field punch-in at an accepted task site shows in the register and the day', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const token = await adminToken();
  // A punch needs a shift; the place makes one that is a working day every day.
  const place = await createPlace(token);
  const worker = await createFieldWorker(token, undefined, { shift_id: place.shiftId });
  const site = randomSite();
  const task = await createTaskApi(token, [worker.employee.id], { site });
  await taskStep(worker.phone, task.id, 'accept');

  await stubMapTiles(page);
  await uiLoginAsReadyAdmin(page);
  await goTo(page, 'Employees');
  await page
    .getByRole('textbox', { name: 'Search by name, code or mobile' })
    .fill(worker.employee.code);
  await page.getByRole('button', { name: `Actions for ${worker.employee.name}` }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit employee' });
  await edit.getByRole('checkbox', { name: 'Field punch-in allowed' }).check();
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeHidden();

  const punched = await sendPunch(worker.phone, 'punch-in', site);
  expect(punched.status, await punched.clone().text()).toBeLessThan(300);

  await goTo(page, 'Attendance');
  await page.getByRole('textbox', { name: 'Search by name or code' }).fill(worker.employee.code);
  const row = page.getByRole('row', { name: new RegExp(worker.employee.name) });
  await expect(row.getByRole('img', { name: 'Field punch-in at a task site' })).toBeVisible();
  await page.getByRole('button', { name: `Actions for ${worker.employee.name}` }).click();
  await page.getByRole('menuitem', { name: 'Details' }).click();
  const day = page.getByRole('dialog', { name: 'Attendance day' });
  await expect(day.getByRole('region', { name: 'Tasks that day' })).toContainText(task.code);
  await expect(day).toContainText(`At the site of ${task.code}`);
});
