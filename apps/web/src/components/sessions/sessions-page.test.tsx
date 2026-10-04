import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeMe, makeSession } from '@/test/fixtures';
import { apiError, mockApi, renderWithClient, type Call } from '@/test/render';
import { SessionsPage } from './sessions-page';

const web = makeSession();
const mobile = makeSession({
  id: 22,
  user_name: 'Ravi Kumar',
  emp_code: 'EMP-002',
  client: 'mobile',
  browser: null,
  os: 'Android 14',
  device_model: 'Pixel 8',
});
const mine = makeSession({
  id: 23,
  user_id: 1,
  user_name: 'Demo Admin',
  emp_code: 'ADMIN-1',
  browser: 'Firefox 143',
  current: true,
});
const ended = makeSession({
  id: 24,
  user_name: 'Meena Iyer',
  emp_code: 'EMP-003',
  status: 'ended',
  ended_at: '2026-02-01T19:00:00Z',
  end_reason: 'password_reset',
});
// A browser the server could not name, behind a proxy that hid the address.
const bare = makeSession({
  id: 25,
  user_name: 'Kiran Das',
  emp_code: 'EMP-004',
  browser: null,
  os: null,
  ip: null,
  status: 'ended',
  end_reason: 'something_new',
});

const LIST = 'GET /admin/sessions';
const page = (items: (typeof web)[], active: number, endedCount: number, next: string | null) => ({
  items,
  counts: { active, ended: endedCount },
  next_cursor: next,
});

function setup(me = makeMe()) {
  let counts = { active: 3, ended: 1 };
  let active = [web, mobile, mine];
  const calls = mockApi({
    'GET /me': me,
    [LIST]: (call: Call) => {
      const status = call.search.get('status');
      const client = call.search.get('client');
      const all = status === 'active' ? active : status === 'ended' ? [ended] : [...active, ended];
      return {
        items: all.filter((s) => !client || s.client === client),
        counts,
        next_cursor: null,
      };
    },
    'POST /admin/sessions/21/revoke': () => {
      counts = { active: 2, ended: 2 };
      active = [mobile, mine];
      return { ...web, status: 'ended', end_reason: 'revoked_by_admin' };
    },
  });
  renderWithClient(<SessionsPage />);
  return { calls, user: userEvent.setup() };
}

const lists = (calls: Call[]) => calls.filter((c) => c.path.endsWith('/admin/sessions'));
const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST');
const tab = (name: RegExp) => screen.getByRole('tab', { name });

describe('SessionsPage', () => {
  it('opens on the Active tab and asks only for active sessions', async () => {
    const { calls } = setup();
    expect(await screen.findByRole('row', { name: /Asha Rao/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Sessions' })).toBeInTheDocument();
    expect(tab(/^Active/)).toHaveAttribute('aria-selected', 'true');
    expect(lists(calls)[0].search.get('status')).toBe('active');
    expect(lists(calls)[0].search.has('client')).toBe(false);
    expect(screen.queryByRole('row', { name: /Meena Iyer/ })).not.toBeInTheDocument();
  });

  it('shows the counts on every tab, whichever tab is open', async () => {
    const { calls, user } = setup();
    await screen.findByRole('row', { name: /Asha Rao/ });
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\s*\d+$/, ''))).toEqual([
      'All',
      'Active',
      'Ended',
    ]);
    expect(screen.getByTestId('count-all')).toHaveTextContent('4');
    expect(screen.getByTestId('count-active')).toHaveTextContent('3');
    expect(screen.getByTestId('count-ended')).toHaveTextContent('1');

    await user.click(tab(/^Ended/));
    expect(await screen.findByRole('row', { name: /Meena Iyer/ })).toBeInTheDocument();
    expect(tab(/^Ended/)).toHaveAttribute('aria-selected', 'true');
    expect(lists(calls).at(-1)?.search.get('status')).toBe('ended');
    expect(screen.getByTestId('count-all')).toHaveTextContent('4');

    await user.click(tab(/^All/));
    await screen.findByRole('row', { name: /Asha Rao/ });
    expect(screen.getByRole('row', { name: /Meena Iyer/ })).toBeInTheDocument();
    expect(lists(calls).at(-1)?.search.has('status')).toBe(false);
  });

  it('filters by type and sends client=web', async () => {
    const { calls, user } = setup();
    await screen.findByRole('row', { name: /Ravi Kumar/ });
    const type = screen.getByRole('combobox', { name: 'Type' });
    expect(
      within(type)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All types', 'Web', 'Mobile']);
    await user.selectOptions(type, 'Web');
    await waitFor(() =>
      expect(screen.queryByRole('row', { name: /Ravi Kumar/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('row', { name: /Asha Rao/ })).toBeInTheDocument();
    expect(lists(calls).at(-1)?.search.get('client')).toBe('web');
    expect(lists(calls).at(-1)?.search.get('status')).toBe('active');
  });

  it('shows browser, OS, IP, IST times and the type label with an icon for a web session', async () => {
    setup();
    const row = await screen.findByRole('row', { name: /Asha Rao/ });
    expect(
      within(screen.getByRole('tabpanel')).getByText('Asha Rao (EMP-001)'),
    ).toBeInTheDocument();
    expect(within(row).getByText('Chrome 141')).toBeInTheDocument();
    expect(within(row).getByText('Windows')).toBeInTheDocument();
    expect(within(row).getByText('203.0.113.7')).toBeInTheDocument();
    // 04:30 UTC is 10:00 am IST; 18:45 UTC on 1 Feb is 12:15 am on 2 Feb in Asia/Kolkata.
    expect(within(row).getByText(/1 Feb 2026.*10:00/i)).toBeInTheDocument();
    expect(within(row).getByText(/2 Feb 2026.*12:15/i)).toBeInTheDocument();
    const type = within(row).getByText('Web');
    expect(type.querySelector('svg')).not.toBeNull();
    const status = within(row).getByTestId('status-active');
    expect(status).toHaveTextContent('Active');
    expect(status.querySelector('svg')).not.toBeNull();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Employee',
      'Type',
      'Browser / phone',
      'OS',
      'IP',
      'Signed in (IST)',
      'Last seen (IST)',
      'Status',
      'Actions',
    ]);
  });

  it('shows the phone model and the Mobile label with an icon for a mobile session', async () => {
    setup();
    const row = await screen.findByRole('row', { name: /Ravi Kumar/ });
    expect(within(row).getByText('Pixel 8')).toBeInTheDocument();
    expect(within(row).getByText('Android 14')).toBeInTheDocument();
    expect(within(row).getByText('Mobile').querySelector('svg')).not.toBeNull();
  });

  it('marks only the session the admin is using', async () => {
    setup();
    const row = await screen.findByRole('row', { name: /Demo Admin/ });
    expect(within(row).getByTestId('current-session')).toHaveTextContent('This session');
    expect(screen.getAllByTestId('current-session')).toHaveLength(1);
  });

  it('shows why an ended session ended and offers no sign-out for it', async () => {
    mockApi({ 'GET /me': makeMe(), [LIST]: page([ended, bare], 0, 2, null) });
    renderWithClient(<SessionsPage />);
    const row = await screen.findByRole('row', { name: /Meena Iyer/ });
    expect(within(row).getByTestId('status-ended')).toHaveTextContent('Ended');
    expect(within(row).getByText('Password reset by an admin')).toBeInTheDocument();
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();

    // Missing details and a reason this build does not know still read clearly.
    const other = screen.getByRole('row', { name: /Kiran Das/ });
    expect(within(other).getByText('Unknown browser')).toBeInTheDocument();
    expect(within(other).getAllByText('Not recorded')).toHaveLength(2);
    expect(within(other).getAllByText('Ended')).toHaveLength(2);
    expect(other).not.toHaveTextContent('something_new');
  });

  it('confirms, sends the revoke and refreshes the counts and rows', async () => {
    const { calls, user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out session of Asha Rao' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign out this session' });
    expect(dialog).toHaveTextContent('Sign out Asha Rao on Chrome 141?');
    expect(dialog).not.toHaveTextContent('you will be signed out yourself');
    expect(posts(calls)).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Sign out this session' }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].path).toBe('/api/proxy/api/v1/admin/sessions/21/revoke');
    await waitFor(() => expect(screen.getByTestId('count-active')).toHaveTextContent('2'));
    expect(screen.getByTestId('count-ended')).toHaveTextContent('2');
    expect(screen.queryByRole('row', { name: /Asha Rao/ })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('names the phone for a mobile session and warns before signing out the current one', async () => {
    const { user } = setup();
    const row = await screen.findByRole('row', { name: /Ravi Kumar/ });
    const button = within(row).getByRole('button', { name: 'Sign out session of Ravi Kumar' });
    expect(button).toHaveTextContent(/^Sign out$/);
    await user.click(button);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Sign out Ravi Kumar on Pixel 8?');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Sign out session of Demo Admin' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'Sign out Demo Admin on Firefox 143? They must sign in again to continue. This is the session you are using now: you will be signed out yourself.',
    );
  });

  it('keeps the dialog open and shows the reason when the sign-out fails', async () => {
    mockApi({
      'GET /me': makeMe(),
      [LIST]: page([web], 1, 0, null),
      'POST /admin/sessions/21/revoke': () => apiError(409, 'CONFLICT'),
    });
    renderWithClient(<SessionsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out session of Asha Rao' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Sign out this session' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('no longer possible');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows a clear empty state for each tab', async () => {
    mockApi({ 'GET /me': makeMe(), [LIST]: page([], 0, 0, null) });
    renderWithClient(<SessionsPage />);
    const user = userEvent.setup();
    expect(await screen.findByText('No active sessions found.')).toBeInTheDocument();
    await user.click(tab(/^Ended/));
    expect(await screen.findByText('No ended sessions found.')).toBeInTheDocument();
    await user.click(tab(/^All/));
    expect(await screen.findByText('No sessions found.')).toBeInTheDocument();
  });

  it('loads the next page with the cursor the server gave', async () => {
    const calls = mockApi({
      'GET /me': makeMe(),
      [LIST]: (call: Call) =>
        call.search.get('cursor') === 'next-1'
          ? page([mobile], 2, 0, null)
          : page([web], 2, 0, 'next-1'),
    });
    renderWithClient(<SessionsPage />);
    await screen.findByRole('row', { name: /Asha Rao/ });
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('row', { name: /Ravi Kumar/ })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Asha Rao/ })).toBeInTheDocument();
    expect(lists(calls).at(-1)?.search.get('cursor')).toBe('next-1');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows no-access without the devices.manage permission and sends no request', async () => {
    const { calls } = setup(makeMe({ permissions: ['web.access', 'employees.manage'] }));
    expect(await screen.findByText(/do not have access/)).toBeInTheDocument();
    expect(lists(calls)).toHaveLength(0);
  });
});
