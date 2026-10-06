import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Schemas } from '@/lib/api-client';
import { CANDIDATES, makeMe, makeTaskAssignee, makeTaskDetail, TASK_TYPES } from '@/test/fixtures';
import { apiError, jsonBody, mockApi, renderWithClient, type Call } from '@/test/render';
import { TaskDetailPage } from './task-detail-page';

vi.mock('@/components/map/geofence-map', () => import('@/test/map-stub'));

type Task = Schemas['TaskDetail'];
type Reach = NonNullable<Schemas['AssigneeOut']['reach']>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ASSIGNER = ['web.access', 'tasks.create', 'team.view'];

const reached = (overrides: Partial<Reach> = {}): Reach => ({
  at: '2026-02-03T05:10:00Z',
  distance_m: 35,
  flags: [],
  reason: null,
  review: 'none',
  review_remarks: null,
  reviewed_by: null,
  reviewed_at: null,
  lat: 12.9757,
  lng: 77.6068,
  accuracy_m: 9,
  face_decision: 'VERIFIED',
  selfie_url: '/api/v1/files/tok.reach',
  face_score: null,
  ...overrides,
});

const completedPerson = (id: number, name: string, reach: Reach | null = null) =>
  makeTaskAssignee({
    user: { id, name, emp_code: `EMP-00${id}` },
    status: 'completed',
    completed_at: '2026-02-03T08:00:00Z',
    reach,
  });

function setup(
  task: Task,
  { permissions = ASSIGNER, routes = {} as Record<string, unknown> } = {},
) {
  const calls = mockApi({
    'GET /me': makeMe({ permissions }),
    [`GET /tasks/${task.id}`]: task,
    'GET /task-types': TASK_TYPES,
    'GET /tasks/candidates': { items: CANDIDATES },
    ...routes,
  });
  renderWithClient(<TaskDetailPage id={task.id} />);
  return { calls, user: userEvent.setup() };
}

const answer = (task: Task) => ({ task, replayed: false });
const sent = (calls: Call[], method: string, suffix: string) =>
  calls.find((c) => c.method === method && c.path.endsWith(suffix));

describe('TaskDetailPage: what it shows', () => {
  it('shows the task, its status and the people on it', async () => {
    setup(makeTaskDetail());
    expect(
      await screen.findByRole('heading', { name: 'Collect the signed contract' }),
    ).toBeVisible();
    expect(screen.getByText('T-00007')).toBeInTheDocument();
    expect(screen.getAllByTestId('task-status-assigned').length).toBeGreaterThan(0);
    const info = screen.getByRole('group', { name: 'Details' });
    expect(within(info).getByText('Acme Traders')).toBeInTheDocument();
    expect(within(info).getByText('45 min')).toBeInTheDocument();
    expect(within(info).getByRole('link', { name: '+919876500000' })).toHaveAttribute(
      'href',
      'tel:+919876500000',
    );
    const person = screen.getByRole('group', { name: 'Asha Rao' });
    expect(within(person).getByTestId('task-status-assigned')).toBeInTheDocument();
  });

  it('marks the site and a dot for each place someone reached it', async () => {
    setup(
      makeTaskDetail({
        status: 'reached',
        assignees: [makeTaskAssignee({ status: 'reached', reach: reached() })],
      }),
    );
    const map = await screen.findByTestId('map');
    expect(map).toHaveAttribute('data-center', '12.9756,77.6066');
    expect(map).toHaveAttribute('data-radius', '200');
    expect(map).toHaveAttribute('data-points', '12.9757,77.6068');
  });

  it('shows a Reached with its flags, distance, reason and selfie, and the score only when sent', async () => {
    setup(
      makeTaskDetail({
        status: 'reached',
        assignees: [
          makeTaskAssignee({
            status: 'reached',
            reach: reached({
              flags: ['location_mismatch', 'face_review'],
              review: 'pending',
              distance_m: 340,
              reason: 'Gate was on the other road',
              face_score: 0.58,
              face_decision: 'REVIEW',
            }),
          }),
        ],
      }),
    );
    const card = await screen.findByRole('group', { name: 'Asha Rao' });
    const reach = within(card).getByRole('region', { name: 'Reached' });
    expect(within(reach).getByText('Outside the site radius')).toBeInTheDocument();
    expect(within(reach).getByText('Face needs a check')).toBeInTheDocument();
    expect(within(reach).getByText('Waiting for review')).toBeInTheDocument();
    expect(within(reach).getByText('340 m (radius 200 m)')).toBeInTheDocument();
    expect(within(reach).getByText('Gate was on the other road')).toBeInTheDocument();
    expect(within(reach).getByText('0.58')).toBeInTheDocument();
    expect(
      within(reach).getByRole('img', { name: 'Selfie of Asha Rao at the site' }),
    ).toHaveAttribute('src', '/api/proxy/api/v1/files/tok.reach');
  });

  it('shows no score and no coordinates when the server sent none', async () => {
    setup(
      makeTaskDetail({
        status: 'reached',
        assignees: [
          makeTaskAssignee({
            status: 'reached',
            reach: reached({ lat: null, lng: null, selfie_url: null, face_decision: null }),
          }),
        ],
      }),
    );
    const card = await screen.findByRole('group', { name: 'Asha Rao' });
    expect(within(card).queryByText('Face score')).not.toBeInTheDocument();
    expect(within(card).queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByTestId('map')).toHaveAttribute('data-points', '');
  });

  it('labels each metric for what it is', async () => {
    setup(
      makeTaskDetail({
        status: 'completed',
        assignees: [
          {
            ...completedPerson(2, 'Asha Rao'),
            metrics: {
              time_to_accept_min: 4,
              accept_to_reached_min: 52,
              time_on_site_min: 38,
              straight_line_m: 4200,
            },
          },
        ],
      }),
    );
    const card = await screen.findByRole('group', { name: 'Asha Rao' });
    expect(within(card).getByText('Time to accept').nextElementSibling).toHaveTextContent('4 min');
    expect(
      within(card).getByText('Accept to Reached (includes any wait before leaving)')
        .nextElementSibling,
    ).toHaveTextContent('52 min');
    expect(within(card).getByText('Time on site').nextElementSibling).toHaveTextContent('38 min');
    expect(
      within(card).getByText('Straight-line distance to the site (not the road travelled)')
        .nextElementSibling,
    ).toHaveTextContent('4200 m');
  });

  it('flags someone who did not accept in time', async () => {
    setup(
      makeTaskDetail({
        assignees: [makeTaskAssignee({ escalated_at: '2026-02-03T04:45:00Z' })],
      }),
    );
    expect(await screen.findByText('Not accepted')).toBeInTheDocument();
  });

  it('lists files by kind, comments with their photo, and the timeline', async () => {
    const user = { id: 1, name: 'Demo Admin', emp_code: 'ADMIN-1' };
    const file = (id: number, kind: string, content_type: string, filename: string) => ({
      id,
      kind,
      filename,
      content_type,
      size: 1000,
      uploaded_by: user,
      created_at: '2026-02-03T04:10:00Z',
      url: `/api/v1/files/tok.${id}`,
    });
    setup(
      makeTaskDetail({
        attachments: [
          file(1, 'brief', 'application/pdf', 'scope.pdf'),
          file(2, 'proof', 'image/jpeg', 'proof.jpg'),
        ],
        comments: [
          {
            id: 9,
            author: user,
            body: 'Please call first',
            created_at: '2026-02-03T04:20:00Z',
            attachment: file(3, 'comment', 'image/jpeg', 'gate.jpg'),
          },
        ],
        events: [
          {
            id: 1,
            event: 'created',
            at: '2026-02-03T04:00:00Z',
            actor: user,
            subject: null,
            note: null,
            offline: false,
          },
          {
            id: 2,
            event: 'accepted',
            at: '2026-02-03T04:30:00Z',
            actor: { id: 2, name: 'Asha Rao', emp_code: 'EMP-001' },
            subject: { id: 2, name: 'Asha Rao', emp_code: 'EMP-001' },
            note: null,
            offline: true,
          },
        ],
      }),
    );
    const files = await screen.findByRole('group', { name: 'Files' });
    expect(
      within(within(files).getByRole('region', { name: 'Briefs' })).getByText('scope.pdf'),
    ).toBeInTheDocument();
    expect(
      within(within(files).getByRole('region', { name: 'Proof' })).getByRole('img', {
        name: 'proof.jpg',
      }),
    ).toHaveAttribute('src', '/api/proxy/api/v1/files/tok.2');
    expect(within(files).queryByRole('region', { name: 'Receipts' })).not.toBeInTheDocument();

    const comments = screen.getByRole('group', { name: 'Comments' });
    expect(within(comments).getByText('Please call first')).toBeInTheDocument();
    expect(
      within(comments).getByRole('img', { name: 'Photo from Demo Admin' }),
    ).toBeInTheDocument();

    const timeline = screen.getByRole('group', { name: 'Timeline' });
    const items = within(timeline).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Task created');
    expect(items[1]).toHaveTextContent('Accepted: Asha Rao');
    expect(items[1]).toHaveTextContent('Sent offline');
  });

  it('says so for a task that is not there or not theirs', async () => {
    const calls = mockApi({
      'GET /me': makeMe({ permissions: ASSIGNER }),
      'GET /tasks/99': () => apiError(404, 'TASK_NOT_FOUND'),
    });
    renderWithClient(<TaskDetailPage id={99} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This task does not exist, or it is outside your scope.',
    );
    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute('href', '/tasks');
    expect(calls.length).toBeGreaterThan(0);
  });

  it('tells a user with no task permission that there is no access', async () => {
    mockApi({ 'GET /me': makeMe({ permissions: ['web.access', 'employees.manage'] }) });
    renderWithClient(<TaskDetailPage id={7} />);
    expect(await screen.findByText(/do not have access/)).toBeInTheDocument();
  });
});

describe('TaskDetailPage: who can do what', () => {
  const names = () => screen.getAllByRole('button').map((b) => b.textContent);

  it('offers edit, add people and cancel on an open task', async () => {
    setup(makeTaskDetail());
    await screen.findByRole('heading', { name: 'Collect the signed contract' });
    expect(names()).toEqual(expect.arrayContaining(['Edit', 'Add people', 'Cancel task']));
    expect(screen.queryByRole('button', { name: 'Close task' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
  });

  it('offers close and reopen, not edit or cancel, on a completed task', async () => {
    setup(makeTaskDetail({ status: 'completed', assignees: [completedPerson(2, 'Asha Rao')] }));
    await screen.findByRole('button', { name: 'Close task' });
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel task' })).not.toBeInTheDocument();
  });

  it('hides cancel once someone is on site', async () => {
    setup(
      makeTaskDetail({
        status: 'reached',
        assignees: [makeTaskAssignee({ status: 'reached', reach: reached() })],
      }),
    );
    await screen.findByRole('button', { name: 'Edit' });
    expect(screen.queryByRole('button', { name: 'Cancel task' })).not.toBeInTheDocument();
  });

  it('offers nothing on a closed task', async () => {
    setup(makeTaskDetail({ status: 'closed', assignees: [completedPerson(2, 'Asha Rao')] }));
    await screen.findByTestId('task-status-closed');
    expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add people' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Write a comment')).not.toBeInTheDocument();
  });

  it('gives a manager who is not the creator no buttons at all', async () => {
    setup(makeTaskDetail({ can_manage: false }), { permissions: ['web.access', 'team.view'] });
    await screen.findByRole('heading', { name: 'Collect the signed contract' });
    for (const name of ['Edit', 'Add people', 'Cancel task', 'Close task', 'Reopen']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByLabelText('Write a comment')).not.toBeInTheDocument();
  });
});

describe('TaskDetailPage: actions', () => {
  it('cancels with a reason, and not without one', async () => {
    const after = makeTaskDetail({ status: 'cancelled' });
    const { calls, user } = setup(makeTaskDetail(), {
      routes: { 'POST /tasks/7/cancel': answer(after) },
    });
    await user.click(await screen.findByRole('button', { name: 'Cancel task' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this task?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel task' }));
    expect(await within(dialog).findByText('This field is required.')).toBeInTheDocument();
    expect(sent(calls, 'POST', '/cancel')).toBeUndefined();

    await user.type(within(dialog).getByLabelText('Reason'), 'Client postponed');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel task' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const call = sent(calls, 'POST', '/cancel') as Call;
    expect(jsonBody(call)).toEqual({ reason: 'Client postponed' });
    expect(call.headers.get('Idempotency-Key')).toMatch(UUID);
    // The answer is on the page at once.
    expect(await screen.findByTestId('task-status-cancelled')).toBeInTheDocument();
  });

  it('closes a completed task, with the comment optional', async () => {
    const done = makeTaskDetail({
      status: 'completed',
      assignees: [completedPerson(2, 'Asha Rao')],
    });
    const { calls, user } = setup(done, {
      routes: { 'POST /tasks/7/close': answer({ ...done, status: 'closed' }) },
    });
    await user.click(await screen.findByRole('button', { name: 'Close task' }));
    const dialog = await screen.findByRole('dialog', { name: 'Close this task?' });
    await user.click(within(dialog).getByRole('button', { name: 'Close task' }));
    await waitFor(() => expect(sent(calls, 'POST', '/close')).toBeDefined());
    expect(jsonBody(sent(calls, 'POST', '/close') as Call)).toEqual({ remarks: null });
    expect(await screen.findByTestId('task-status-closed')).toBeInTheDocument();
  });

  it('needs a closing comment when a Reached was rejected', async () => {
    const done = makeTaskDetail({
      status: 'completed',
      assignees: [completedPerson(2, 'Asha Rao', reached({ review: 'rejected' }))],
    });
    const { calls, user } = setup(done, {
      routes: { 'POST /tasks/7/close': answer({ ...done, status: 'closed' }) },
    });
    await user.click(await screen.findByRole('button', { name: 'Close task' }));
    const dialog = await screen.findByRole('dialog', { name: 'Close this task?' });
    await user.click(within(dialog).getByRole('button', { name: 'Close task' }));
    expect(await within(dialog).findByText('This field is required.')).toBeInTheDocument();
    expect(sent(calls, 'POST', '/close')).toBeUndefined();
    await user.type(
      within(dialog).getByLabelText(/Closing comment \(required/),
      'Checked by phone',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Close task' }));
    await waitFor(() => expect(sent(calls, 'POST', '/close')).toBeDefined());
    expect(jsonBody(sent(calls, 'POST', '/close') as Call)).toEqual({
      remarks: 'Checked by phone',
    });
  });

  it('will not close while a Reached waits for review', async () => {
    const done = makeTaskDetail({
      status: 'completed',
      assignees: [completedPerson(2, 'Asha Rao', reached({ review: 'pending' }))],
    });
    const { user } = setup(done);
    await user.click(await screen.findByRole('button', { name: 'Close task' }));
    const dialog = await screen.findByRole('dialog', { name: 'Close this task?' });
    expect(within(dialog).getByRole('status')).toHaveTextContent('A Reached is waiting for review');
    expect(within(dialog).getByRole('button', { name: 'Close task' })).toBeDisabled();
  });

  it('shows the server refusal inside the dialog', async () => {
    const done = makeTaskDetail({
      status: 'completed',
      assignees: [completedPerson(2, 'Asha Rao')],
    });
    const { user } = setup(done, {
      routes: { 'POST /tasks/7/close': () => apiError(409, 'REACH_REVIEW_PENDING') },
    });
    await user.click(await screen.findByRole('button', { name: 'Close task' }));
    const dialog = await screen.findByRole('dialog', { name: 'Close this task?' });
    await user.click(within(dialog).getByRole('button', { name: 'Close task' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A Reached is waiting');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('reopens for everyone who completed, or only the people chosen', async () => {
    const done = makeTaskDetail({
      status: 'completed',
      assignees: [completedPerson(2, 'Asha Rao'), completedPerson(3, 'Ravi Kumar')],
    });
    const { calls, user } = setup(done, {
      routes: { 'POST /tasks/7/reopen': answer({ ...done, status: 'in_progress' }) },
    });
    await user.click(await screen.findByRole('button', { name: 'Reopen' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reopen this task?' });
    await user.click(within(dialog).getByRole('button', { name: 'Reopen' }));
    expect(await within(dialog).findByText('This field is required.')).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('Why it is reopened'), 'Signature missing');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Ravi Kumar' }));
    await user.click(within(dialog).getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(sent(calls, 'POST', '/reopen')).toBeDefined());
    expect(jsonBody(sent(calls, 'POST', '/reopen') as Call)).toEqual({
      comment: 'Signature missing',
      user_ids: [2],
    });
  });

  it('reopens without a list when everyone is chosen', async () => {
    const done = makeTaskDetail({
      status: 'completed',
      assignees: [completedPerson(2, 'Asha Rao')],
    });
    const { calls, user } = setup(done, {
      routes: { 'POST /tasks/7/reopen': answer({ ...done, status: 'in_progress' }) },
    });
    await user.click(await screen.findByRole('button', { name: 'Reopen' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reopen this task?' });
    await user.type(within(dialog).getByLabelText('Why it is reopened'), 'Photo was blurred');
    await user.click(within(dialog).getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(sent(calls, 'POST', '/reopen')).toBeDefined());
    expect(jsonBody(sent(calls, 'POST', '/reopen') as Call)).toEqual({
      comment: 'Photo was blurred',
    });
  });

  it('adds people who are not already on the task', async () => {
    const after = makeTaskDetail({
      assignees: [
        makeTaskAssignee(),
        makeTaskAssignee({ user: { id: 3, name: 'Ravi Kumar', emp_code: 'EMP-002' } }),
      ],
    });
    const { calls, user } = setup(makeTaskDetail(), {
      routes: { 'POST /tasks/7/assignees': answer(after) },
    });
    await user.click(await screen.findByRole('button', { name: 'Add people' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add people' });
    // Asha is on the task already.
    await within(dialog).findByRole('checkbox', { name: /Ravi Kumar/ });
    expect(within(dialog).queryByRole('checkbox', { name: /Asha Rao/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: /Ravi Kumar/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(sent(calls, 'POST', '/assignees')).toBeDefined());
    expect(jsonBody(sent(calls, 'POST', '/assignees') as Call)).toEqual({ user_ids: [3] });
    expect(await screen.findByRole('group', { name: 'Ravi Kumar' })).toBeInTheDocument();
  });

  it('removes someone who has not started, after a confirmation', async () => {
    const two = makeTaskDetail({
      assignees: [
        makeTaskAssignee(),
        makeTaskAssignee({
          user: { id: 3, name: 'Ravi Kumar', emp_code: 'EMP-002' },
          status: 'accepted',
        }),
      ],
    });
    const after = makeTaskDetail({ assignees: [makeTaskAssignee()] });
    const { calls, user } = setup(two, {
      routes: { 'DELETE /tasks/7/assignees/3': answer(after) },
    });
    await user.click(await screen.findByRole('button', { name: 'Remove Ravi Kumar' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.find((c) => c.method === 'DELETE')?.headers.get('Idempotency-Key')).toMatch(UUID);
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Ravi Kumar' })).not.toBeInTheDocument(),
    );
  });

  it('offers no removal for someone who is on site', async () => {
    setup(
      makeTaskDetail({
        status: 'reached',
        assignees: [makeTaskAssignee({ status: 'reached', reach: reached() })],
      }),
    );
    await screen.findByRole('group', { name: 'Asha Rao' });
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
  });

  it('sends a comment with a photo as one multipart request', async () => {
    const { calls, user } = setup(makeTaskDetail(), {
      routes: { 'POST /tasks/7/comments': answer(makeTaskDetail()) },
    });
    await user.type(await screen.findByLabelText('Write a comment'), 'Call before you go');
    const photo = new File(['x'], 'gate.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText('Add a photo (optional)'), photo);
    await user.click(screen.getByRole('button', { name: 'Send comment' }));
    await waitFor(() => expect(sent(calls, 'POST', '/comments')).toBeDefined());
    const call = sent(calls, 'POST', '/comments') as Call;
    expect((call.body as FormData).get('body')).toBe('Call before you go');
    expect((call.body as FormData).get('photo')).toBe(photo);
    expect(call.headers.get('Idempotency-Key')).toMatch(UUID);
    await waitFor(() => expect(screen.getByLabelText('Write a comment')).toHaveValue(''));
  });

  it('refuses an empty comment', async () => {
    const { calls, user } = setup(makeTaskDetail());
    await user.click(await screen.findByRole('button', { name: 'Send comment' }));
    expect(await screen.findByText('Write a comment or add a photo.')).toBeInTheDocument();
    expect(sent(calls, 'POST', '/comments')).toBeUndefined();
  });

  it('adds a brief', async () => {
    const { calls, user } = setup(makeTaskDetail(), {
      routes: { 'POST /tasks/7/attachments': answer(makeTaskDetail()) },
    });
    const pdf = new File(['%PDF'], 'scope.pdf', { type: 'application/pdf' });
    await user.upload(await screen.findByLabelText(/Add a brief/), pdf);
    await waitFor(() => expect(sent(calls, 'POST', '/attachments')).toBeDefined());
    expect(((sent(calls, 'POST', '/attachments') as Call).body as FormData).get('file')).toBe(pdf);
  });

  it('opens the edit dialog on this task', async () => {
    const { user } = setup(makeTaskDetail());
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Collect the signed contract');
  });
});

describe('TaskDetailPage: reviewing a Reached', () => {
  const pending = () =>
    makeTaskDetail({
      status: 'reached',
      assignees: [
        makeTaskAssignee({
          status: 'reached',
          reach: reached({
            flags: ['location_mismatch'],
            review: 'pending',
            reason: 'Wrong gate',
            distance_m: 340,
            face_score: 0.61,
          }),
        }),
      ],
    });

  it('shows the selfie, distance and score to the reviewer', async () => {
    const { user } = setup(pending());
    await user.click(await screen.findByRole('button', { name: 'Review Reached' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review Reached' });
    expect(
      within(dialog).getByRole('img', { name: 'Selfie of Asha Rao at the site' }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('340 m (radius 200 m)')).toBeInTheDocument();
    expect(within(dialog).getByText('0.61')).toBeInTheDocument();
    expect(within(dialog).getByText('Wrong gate')).toBeInTheDocument();
  });

  it('approves without remarks', async () => {
    const { calls, user } = setup(pending(), {
      routes: {
        'POST /tasks/7/assignees/2/reach-review': answer(
          makeTaskDetail({
            status: 'reached',
            assignees: [
              makeTaskAssignee({ status: 'reached', reach: reached({ review: 'approved' }) }),
            ],
          }),
        ),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Review Reached' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review Reached' });
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const call = sent(calls, 'POST', '/reach-review') as Call;
    expect(jsonBody(call)).toEqual({ decision: 'approve', remarks: null });
    expect(call.headers.get('Idempotency-Key')).toMatch(UUID);
    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review Reached' })).not.toBeInTheDocument();
  });

  it('rejects only with a reason', async () => {
    const { calls, user } = setup(pending(), {
      routes: { 'POST /tasks/7/assignees/2/reach-review': answer(pending()) },
    });
    await user.click(await screen.findByRole('button', { name: 'Review Reached' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review Reached' });
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await within(dialog).findByText('Give a reason for rejecting.')).toBeInTheDocument();
    expect(sent(calls, 'POST', '/reach-review')).toBeUndefined();
    await user.type(
      within(dialog).getByLabelText('Remarks (required to reject)'),
      'Not at the site',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(sent(calls, 'POST', '/reach-review')).toBeDefined());
    expect(jsonBody(sent(calls, 'POST', '/reach-review') as Call)).toEqual({
      decision: 'reject',
      remarks: 'Not at the site',
    });
  });

  it('hides the review button on your own Reached', async () => {
    // The signed-in user is 1; this Reached is theirs.
    const own = makeTaskDetail({
      status: 'reached',
      assignees: [
        makeTaskAssignee({
          user: { id: 1, name: 'Demo Admin', emp_code: 'ADMIN-1' },
          status: 'reached',
          reach: reached({ review: 'pending' }),
        }),
      ],
    });
    setup(own);
    await screen.findByRole('group', { name: 'Demo Admin' });
    expect(screen.queryByRole('button', { name: 'Review Reached' })).not.toBeInTheDocument();
  });

  it('shows the server refusal, for example a decision already made', async () => {
    const { user } = setup(pending(), {
      routes: { 'POST /tasks/7/assignees/2/reach-review': () => apiError(409, 'ALREADY_DECIDED') },
    });
    await user.click(await screen.findByRole('button', { name: 'Review Reached' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review Reached' });
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already decided');
  });
});
