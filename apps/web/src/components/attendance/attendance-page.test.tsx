import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  ATTENDANCE_ADMIN,
  makeMe,
  makeRegisterRow,
  makeRequest,
  makeReview,
} from '@/test/fixtures';
import { mockApi, renderWithClient, type Call } from '@/test/render';
import { AttendancePage } from './attendance-page';

function setup(permissions: string[]) {
  const calls = mockApi({
    'GET /me': makeMe({ permissions }),
    'GET /branches': [],
    'GET /admin/attendance': { items: [makeRegisterRow()], next_cursor: null },
    'GET /admin/punch-out-requests': { items: [makeRequest()], next_cursor: null },
    'GET /admin/punch-reviews': {
      items: [makeReview(), makeReview({ id: 92 })],
      next_cursor: null,
    },
    'GET /admin/attendance-exceptions': { items: [], next_cursor: null },
  });
  renderWithClient(<AttendancePage />);
  return { calls, user: userEvent.setup() };
}

const tabNames = async () =>
  within(await screen.findByRole('tablist'))
    .getAllByRole('tab')
    .map((tab) => tab.textContent?.replace(/\d+$/, ''));
const asked = (calls: Call[], path: string) => calls.some((c) => c.path.endsWith(path));

describe('Attendance page', () => {
  it('shows all four tabs to someone who holds every permission, Register first', async () => {
    setup(ATTENDANCE_ADMIN);
    expect(await tabNames()).toEqual(['Register', 'Punch-out requests', 'Review', 'Exceptions']);
    expect(screen.getByRole('tab', { name: 'Register' })).toHaveAttribute('aria-selected', 'true');
  });

  it('puts the number waiting on the Requests and Review tabs only', async () => {
    setup(ATTENDANCE_ADMIN);
    expect(await screen.findByTestId('count-requests')).toHaveTextContent('1');
    expect(screen.getByTestId('count-reviews')).toHaveTextContent('2');
    expect(screen.queryByTestId('count-register')).not.toBeInTheDocument();
    expect(screen.queryByTestId('count-exceptions')).not.toBeInTheDocument();
  });

  it('shows a manager the register and the requests, and nothing else', async () => {
    const { calls } = setup(['web.access', 'team.view', 'punchout.approve']);
    expect(await tabNames()).toEqual(['Register', 'Punch-out requests']);
    await screen.findByRole('table');
    expect(asked(calls, '/admin/punch-reviews')).toBe(false);
    expect(asked(calls, '/admin/attendance-exceptions')).toBe(false);
  });

  it('starts on the first tab someone may use when they cannot see the register', async () => {
    const { calls } = setup(['web.access', 'face.review']);
    expect(await tabNames()).toEqual(['Review']);
    expect(await screen.findByRole('tab', { name: /^Review/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(asked(calls, '/admin/attendance')).toBe(false);
  });

  it('lets a Task Assigner with team.view and punchout.approve use both of their tabs', async () => {
    const { user } = setup(['web.access', 'team.view', 'punchout.approve']);
    await user.click(await screen.findByRole('tab', { name: /^Punch-out requests/ }));
    expect(await screen.findByText('Client site visit')).toBeVisible();
  });

  it('shows no access, and asks for nothing, without any attendance permission', async () => {
    const { calls } = setup(['web.access', 'employees.manage']);
    expect(await screen.findByText(/do not have access/)).toBeVisible();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(asked(calls, '/admin/attendance')).toBe(false);
    expect(asked(calls, '/admin/punch-out-requests')).toBe(false);
  });
});
