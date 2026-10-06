import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Schemas } from '@/lib/api-client';
import { CANDIDATES, makeMe, makeTaskBrief, TASK_TYPES } from '@/test/fixtures';
import { mockApi, renderWithClient, type Call } from '@/test/render';
import { TasksPage } from './tasks-page';

const ASSIGNER = ['web.access', 'tasks.create', 'team.view'];
const ADMIN = ['web.access', 'tasks.create', 'tasks.view_all', 'team.view'];

const ACCEPTED = makeTaskBrief({
  id: 8,
  code: 'T-00008',
  title: 'Deliver the cheque',
  status: 'accepted',
  priority: 'urgent',
  assignees: [
    {
      user: { id: 3, name: 'Ravi Kumar', emp_code: 'EMP-002' },
      status: 'accepted',
      escalated: false,
      reach_review: 'none',
    },
    {
      user: { id: 4, name: 'Meera Das', emp_code: 'EMP-003' },
      status: 'accepted',
      escalated: false,
      reach_review: 'none',
    },
  ],
});
const LATE = makeTaskBrief({
  id: 9,
  code: 'T-00009',
  title: 'Survey the plot',
  status: 'assigned',
  assignees: [
    {
      user: { id: 2, name: 'Asha Rao', emp_code: 'EMP-001' },
      status: 'assigned',
      escalated: true,
      reach_review: 'none',
    },
  ],
});
const REVIEW = makeTaskBrief({
  id: 10,
  code: 'T-00010',
  title: 'Inspect the lift',
  status: 'reached',
  assignees: [
    {
      user: { id: 2, name: 'Asha Rao', emp_code: 'EMP-001' },
      status: 'reached',
      escalated: false,
      reach_review: 'pending',
    },
  ],
});
const CLOSED = makeTaskBrief({ id: 11, code: 'T-00011', title: 'Old job', status: 'closed' });
const ALL = [makeTaskBrief(), ACCEPTED, LATE, REVIEW, CLOSED];

function setup(permissions = ASSIGNER, list?: (call: Call) => unknown) {
  const calls = mockApi({
    'GET /me': makeMe({ permissions }),
    'GET /task-types': TASK_TYPES,
    'GET /tasks/candidates': { items: CANDIDATES },
    'GET /employees/team': { items: [], next_cursor: null },
    'GET /tasks': (call: Call) => {
      if (list) return list(call);
      const wanted = call.search.getAll('status');
      const items = ALL.filter((t) => wanted.length === 0 || wanted.includes(t.status));
      return { items, next_cursor: null } satisfies Schemas['TaskPage'];
    },
  });
  renderWithClient(<TasksPage />);
  return { calls, user: userEvent.setup() };
}

const column = (name: string) => screen.getByRole('region', { name });
const lastList = (calls: Call[]) => calls.filter((c) => c.path.endsWith('/tasks')).at(-1);

describe('TasksPage board', () => {
  it('puts each task in its status column, with the count and a link to the task', async () => {
    setup();
    const assigned = await screen.findByRole('region', { name: 'Assigned' });
    expect(
      within(assigned).getByRole('link', { name: 'Collect the signed contract' }),
    ).toHaveAttribute('href', '/tasks/7');
    expect(within(assigned).getByTestId('column-count-assigned')).toHaveTextContent('2');
    expect(within(column('Accepted')).getByText('Deliver the cheque')).toBeInTheDocument();
    expect(within(column('Accepted')).getByText('Ravi Kumar, Meera Das')).toBeInTheDocument();
    expect(within(column('Reached')).getByText('Inspect the lift')).toBeInTheDocument();
    expect(within(column('In progress')).getByText('No tasks')).toBeInTheDocument();
  });

  it('flags a task nobody accepted in time and a Reached that waits for review', async () => {
    setup();
    await screen.findByText('Survey the plot');
    expect(within(column('Assigned')).getByText('Not accepted')).toBeInTheDocument();
    expect(within(column('Reached')).getByText('Reached: review')).toBeInTheDocument();
  });

  it('asks only for the board statuses, and shows closed and cancelled behind a toggle', async () => {
    const { calls, user } = setup();
    await screen.findByText('Survey the plot');
    expect(lastList(calls)?.search.getAll('status')).toEqual([
      'assigned',
      'accepted',
      'reached',
      'in_progress',
      'on_hold',
      'completed',
      'declined',
    ]);
    expect(screen.queryByText('Old job')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Closed' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Show closed and cancelled' }));
    expect(await screen.findByText('Old job')).toBeInTheDocument();
    expect(within(column('Closed')).getByText('Old job')).toBeInTheDocument();
    expect(column('Cancelled')).toBeInTheDocument();
  });

  it('offers the New task button only to someone who may create tasks', async () => {
    setup(ASSIGNER);
    expect(await screen.findByRole('button', { name: 'New task' })).toBeInTheDocument();
  });

  it('hides it from a manager who only views their team, and asks for the team view', async () => {
    const { calls } = setup(['web.access', 'team.view']);
    await screen.findByText('Survey the plot');
    expect(screen.queryByRole('button', { name: 'New task' })).not.toBeInTheDocument();
    expect(lastList(calls)?.search.get('view')).toBe('team');
    // One view only: no selector, and the team list serves the employee filter.
    expect(screen.queryByRole('combobox', { name: 'Show' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/employees/team'))).toBe(true);
    expect(calls.some((c) => c.path.endsWith('/tasks/candidates'))).toBe(false);
  });

  it('tells a user with no task permission that there is no access', async () => {
    setup(['web.access', 'employees.manage']);
    expect(await screen.findByText(/do not have access/)).toBeInTheDocument();
  });
});

describe('TasksPage filters', () => {
  it('starts an admin on all tasks and lets them switch to the ones they assigned or the team', async () => {
    const { calls, user } = setup(ADMIN);
    await screen.findByText('Survey the plot');
    // An admin sees everything by default, as the server does.
    expect(lastList(calls)?.search.get('view')).toBe('all');
    const view = screen.getByRole('combobox', { name: 'Show' });
    expect(
      within(view)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All tasks', 'Assigned by me', "My team's tasks"]);
    await user.selectOptions(view, 'assigned_by_me');
    await waitFor(() => expect(lastList(calls)?.search.get('view')).toBe('assigned_by_me'));
  });

  it('sends the status, employee, type and date range to the server', async () => {
    const { calls, user } = setup();
    await screen.findByText('Survey the plot');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'in_progress');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Employee' }), '3');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), '2');
    await user.type(screen.getByLabelText('From'), '2026-02-01');
    await user.type(screen.getByLabelText('To'), '2026-02-07');
    await waitFor(() => {
      const last = lastList(calls);
      expect(last?.search.getAll('status')).toEqual(['in_progress']);
      expect(last?.search.get('assignee')).toBe('3');
      expect(last?.search.get('type_id')).toBe('2');
      expect(last?.search.get('from')).toBe('2026-02-01');
      expect(last?.search.get('to')).toBe('2026-02-07');
    });
    // One chosen status shows one column, and the closed toggle has nothing left to do.
    const board = screen.getByRole('region', { name: 'Board' });
    expect(board).toHaveAttribute('tabindex', '0');
    expect(within(board).getAllByRole('region')).toHaveLength(1);
    expect(
      screen.queryByRole('checkbox', { name: 'Show closed and cancelled' }),
    ).not.toBeInTheDocument();
  });

  it('waits for a pause in typing before asking the server to search', async () => {
    const { calls, user } = setup();
    await screen.findByText('Survey the plot');
    const before = calls.length;
    await user.type(
      screen.getByRole('textbox', { name: 'Search by title, client or code' }),
      'acme',
    );
    expect(calls.slice(before).some((c) => c.search.get('q'))).toBe(false);
    await waitFor(() => expect(lastList(calls)?.search.get('q')).toBe('acme'));
    expect(calls.filter((c) => c.search.get('q')).length).toBe(1);
  });

  it('loads the next page with the cursor', async () => {
    const { calls, user } = setup(ASSIGNER, (call) =>
      call.search.get('cursor') === 'c1'
        ? { items: [LATE], next_cursor: null }
        : { items: [ACCEPTED], next_cursor: 'c1' },
    );
    await screen.findByText('Deliver the cheque');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Survey the plot')).toBeInTheDocument();
    expect(lastList(calls)?.search.get('cursor')).toBe('c1');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});

describe('TasksPage list', () => {
  it('shows every status in a table, with the assignees and flags', async () => {
    const { calls, user } = setup();
    await screen.findByText('Survey the plot');
    await user.click(screen.getByRole('tab', { name: 'List' }));
    const row = await screen.findByRole('row', { name: /T-00009/ });
    expect(within(row).getByRole('link', { name: 'Survey the plot' })).toHaveAttribute(
      'href',
      '/tasks/9',
    );
    expect(within(row).getByText('Assigned')).toBeInTheDocument();
    expect(within(row).getByText('Not accepted')).toBeInTheDocument();
    expect(within(row).getByText('Asha Rao')).toBeInTheDocument();
    // No status filter in the list: closed tasks are listed too.
    expect(await screen.findByRole('row', { name: /T-00011/ })).toBeInTheDocument();
    expect(lastList(calls)?.search.has('status')).toBe(false);
  });

  it('says so when nothing matches', async () => {
    const { user } = setup(ASSIGNER, () => ({ items: [], next_cursor: null }));
    await user.click(await screen.findByRole('tab', { name: 'List' }));
    expect(await screen.findByText('No tasks match these filters.')).toBeInTheDocument();
  });
});
