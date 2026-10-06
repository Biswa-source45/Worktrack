import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CANDIDATES, makeTaskAssignee, makeTaskDetail, TASK_TYPES } from '@/test/fixtures';
import { apiError, jsonBody, mockApi, renderWithClient, type Call } from '@/test/render';
import { TaskDialog } from './task-dialog';

vi.mock('@/components/map/geofence-map', () => import('@/test/map-stub'));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function setup(
  task?: Parameters<typeof TaskDialog>[0]['task'],
  routes: Record<string, unknown> = {},
) {
  const onClose = vi.fn();
  const calls = mockApi({
    'GET /task-types': TASK_TYPES,
    'GET /tasks/candidates': { items: CANDIDATES },
    'POST /tasks': { task: makeTaskDetail({ id: 7 }), replayed: false },
    'PATCH /tasks/7': { task: makeTaskDetail(), replayed: false },
    'POST /tasks/7/attachments': { task: makeTaskDetail(), replayed: false },
    ...routes,
  });
  renderWithClient(<TaskDialog task={task} onClose={onClose} />);
  return { calls, onClose, user: userEvent.setup() };
}

const posted = (calls: Call[], path: string) =>
  calls.filter((c) => c.method === 'POST' && c.path.endsWith(path));

type User = ReturnType<typeof userEvent.setup>;

// Pasting is one event where typing is one per key: the long forms stay well inside the time limit.
async function paste(user: User, field: HTMLElement, text: string) {
  await user.click(field);
  await user.paste(text);
}

async function fillValid(user: User) {
  await paste(user, screen.getByLabelText('Title'), 'Collect the contract');
  await user.selectOptions(screen.getByLabelText('Task type'), '1');
  await paste(user, screen.getByLabelText('Client'), 'Acme Traders');
  await paste(user, screen.getByLabelText('Address'), 'MG Road');
  await user.click(screen.getByRole('button', { name: 'move pin' }));
  await user.click(await screen.findByRole('checkbox', { name: /Asha Rao/ }));
  await user.click(screen.getByRole('checkbox', { name: /Ravi Kumar/ }));
}

describe('TaskDialog: new task', () => {
  it('names every missing field and sends nothing', async () => {
    const { calls, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    expect((await screen.findAllByText('This field is required.')).length).toBeGreaterThanOrEqual(
      4,
    );
    expect(screen.getByText('Choose at least one person.')).toBeInTheDocument();
    expect(posted(calls, '/tasks')).toHaveLength(0);
  });

  it('shows each candidate with today status, and filters them by name', async () => {
    const { user } = setup();
    const box = await screen.findByRole('checkbox', { name: /Meera Das/ });
    expect(box).toHaveAccessibleName(/On a task/);
    expect(screen.getByRole('checkbox', { name: /Ravi Kumar/ })).toHaveAccessibleName(
      /Not punched in/,
    );
    await user.type(screen.getByRole('textbox', { name: 'Search people by name or code' }), 'ravi');
    expect(screen.queryByRole('checkbox', { name: /Meera Das/ })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Ravi Kumar/ })).toBeInTheDocument();
  });

  it('creates the task with an idempotency key, the pin, IST time and the people chosen', async () => {
    const { calls, onClose, user } = setup();
    await fillValid(user);
    await user.selectOptions(screen.getByLabelText('Priority'), 'high');
    await user.clear(screen.getByLabelText('Scheduled for (IST)'));
    await paste(user, screen.getByLabelText('Scheduled for (IST)'), '2026-03-04T10:30');
    await paste(user, screen.getByLabelText('Contact phone (optional)'), '98765 00000');
    await paste(user, screen.getByLabelText('Expected duration (minutes)'), '45');
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [call] = posted(calls, '/tasks');
    expect(call.headers.get('Idempotency-Key')).toMatch(UUID);
    expect(jsonBody(call)).toEqual({
      title: 'Collect the contract',
      type_id: 1,
      client_name: 'Acme Traders',
      site: { address: 'MG Road', lat: 12.971599, lng: 77.594563 },
      contact_name: null,
      contact_phone: '98765 00000',
      priority: 'high',
      scheduled_at: '2026-03-04T10:30:00+05:30',
      expected_minutes: 45,
      description: null,
      assignee_ids: [2, 3],
    });
  });

  it('sends the radius only when one is typed', async () => {
    const { calls, user } = setup();
    await fillValid(user);
    await paste(user, screen.getByLabelText('Arrival radius (m)'), '150');
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(posted(calls, '/tasks')).toHaveLength(1));
    expect(jsonBody(posted(calls, '/tasks')[0]).site).toMatchObject({ radius_m: 150 });
  });

  it('refuses a radius or phone the server would refuse', async () => {
    const { calls, user } = setup();
    await fillValid(user);
    await paste(user, screen.getByLabelText('Arrival radius (m)'), '5');
    await paste(user, screen.getByLabelText('Contact phone (optional)'), '123');
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    expect(await screen.findByText('Enter a whole number from 30 to 500.')).toBeInTheDocument();
    expect(screen.getByText('Enter a valid mobile number (10 to 15 digits).')).toBeInTheDocument();
    expect(posted(calls, '/tasks')).toHaveLength(0);
  });

  it('keeps the dialog open and says why when the server refuses', async () => {
    const { onClose, user } = setup(undefined, {
      'POST /tasks': () => apiError(422, 'NOT_FIELD_ELIGIBLE'),
    });
    await fillValid(user);
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'One of the people chosen cannot be given field tasks.',
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('uploads each brief after the task exists', async () => {
    const { calls, onClose, user } = setup();
    await fillValid(user);
    const pdf = new File(['%PDF-1.4'], 'brief.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByLabelText('Briefs (optional)'), pdf);
    expect(screen.getByText('brief.pdf')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [upload] = posted(calls, '/tasks/7/attachments');
    expect((upload.body as FormData).get('file')).toBe(pdf);
    expect(upload.headers.get('Idempotency-Key')).toMatch(UUID);
    // The task is created before its files, never after.
    expect(calls.findIndex((c) => c === upload)).toBeGreaterThan(
      calls.findIndex((c) => c === posted(calls, '/tasks')[0]),
    );
  });

  it('retries only the files left when one upload failed, without making a second task', async () => {
    let uploads = 0;
    const { calls, onClose, user } = setup(undefined, {
      'POST /tasks/7/attachments': () => {
        uploads += 1;
        return uploads === 1
          ? apiError(422, 'INVALID_FILE')
          : { task: makeTaskDetail(), replayed: false };
      },
    });
    await fillValid(user);
    await user.upload(
      screen.getByLabelText('Briefs (optional)'),
      new File(['x'], 'plan.png', { type: 'image/png' }),
    );
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The task was saved, but these files could not be uploaded: plan.png.',
    );
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(posted(calls, '/tasks')).toHaveLength(1);
    expect(posted(calls, '/tasks/7/attachments')).toHaveLength(2);
  });

  it('refuses a brief over 10 MB before sending it', async () => {
    const { user } = setup();
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'huge.pdf', {
      type: 'application/pdf',
    });
    await user.upload(screen.getByLabelText('Briefs (optional)'), big);
    expect(await screen.findByText('huge.pdf is larger than 10 MB.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Chosen briefs' })).not.toBeInTheDocument();
  });
});

describe('TaskDialog: edit', () => {
  const existing = makeTaskDetail();

  it('starts from the task, without the assignee list, and sends only what changed', async () => {
    const { calls, onClose, user } = setup(existing);
    expect(screen.getByLabelText('Title')).toHaveValue('Collect the signed contract');
    expect(screen.getByLabelText('Task type')).toHaveValue('1');
    expect(screen.getByLabelText('Scheduled for (IST)')).toHaveValue('2026-02-03T10:30');
    expect(screen.queryByText('Assign to')).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('Client'));
    await paste(user, screen.getByLabelText('Client'), 'Acme Ltd');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(jsonBody(patch as Call)).toEqual({ client_name: 'Acme Ltd' });
    expect(patch?.headers.get('Idempotency-Key')).toMatch(UUID);
  });

  it('sends nothing when nothing changed', async () => {
    const { calls, onClose, user } = setup(existing);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('locks the site once someone has reached it', async () => {
    const reached = makeTaskDetail({
      status: 'reached',
      assignees: [
        makeTaskAssignee({
          status: 'reached',
          reach: {
            at: '2026-02-03T05:10:00Z',
            distance_m: 20,
            flags: [],
            reason: null,
            review: 'none',
            review_remarks: null,
            reviewed_by: null,
            reviewed_at: null,
          },
        }),
      ],
    });
    setup(reached);
    expect(screen.getByText(/can no longer be changed/)).toBeInTheDocument();
    expect(screen.getByLabelText('Address')).toBeDisabled();
    expect(screen.getByLabelText('Latitude')).toBeDisabled();
    expect(screen.getByLabelText('Title')).toBeEnabled();
  });

  it('shows the server refusal when the site was locked meanwhile', async () => {
    const { user } = setup(existing, { 'PATCH /tasks/7': () => apiError(409, 'TASK_SITE_LOCKED') });
    await user.clear(screen.getByLabelText('Address'));
    await paste(user, screen.getByLabelText('Address'), 'Elsewhere');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer be changed/);
  });
});
