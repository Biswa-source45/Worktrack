import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { SessionsSection } from '@/components/admin/sessions-section';
import { calls, failure, mockApi, sessionBody } from '@/test/fake-api';
import { renderWithTheme } from '@/test/render';
import { resetSecureStore } from '@/test/secure-store-mock';

type Session = ReturnType<typeof sessionBody>;

const LIST = 'GET /api/v1/admin/sessions';
const button = (name: string) => screen.getByRole('button', { name });
const row = (id: number) => within(screen.getByTestId(`session-${id}`));
const dialog = () => within(screen.getByTestId('dialog'));
const listCalls = () => calls.filter((call) => call.method === 'GET');
const lastQuery = () => new URL(listCalls().at(-1)!.url).searchParams;

const WEB = sessionBody({
  id: 22,
  user_id: 2,
  emp_code: 'EMP-9',
  user_name: 'Ravi Kumar',
  client: 'web',
  browser: 'Chrome 140',
  os: 'Windows 11',
  device_model: null,
});
const ENDED = sessionBody({
  id: 23,
  status: 'ended',
  ended_at: '2026-10-04T10:00:00Z',
  end_reason: 'revoked_by_admin',
});

let sessions: Session[];

function page(request: Request) {
  const status = new URL(request.url).searchParams.get('status');
  const count = (wanted: string) => sessions.filter((session) => session.status === wanted).length;
  return Response.json({
    items: status ? sessions.filter((session) => session.status === status) : sessions,
    counts: { active: count('active'), ended: count('ended') },
    next_cursor: null,
  });
}

function revoke(id: number) {
  return () => {
    sessions = sessions.map((session) =>
      session.id === id ? { ...session, status: 'ended', end_reason: 'revoked_by_admin' } : session,
    );
    return Response.json(sessions.find((session) => session.id === id));
  };
}

async function renderSessions() {
  await renderWithTheme(<SessionsSection top={null} />);
  await screen.findByRole('button', { name: /^Active: / });
}

beforeEach(() => {
  resetSecureStore();
  sessions = [sessionBody(), WEB, ENDED];
});

describe('Sessions section', () => {
  it('opens on Active, asks the server for active sessions and shows the counts', async () => {
    mockApi({ [LIST]: page });
    await renderSessions();
    expect(lastQuery().get('status')).toBe('active');
    for (const name of ['Active: 2', 'Ended: 1', 'All: 3']) {
      expect(button(name)).toBeOnTheScreen();
    }
    expect(button('Active: 2').props.accessibilityState.selected).toBe(true);
    expect(screen.queryByTestId('session-23')).toBeNull();
  });

  it('shows a mobile session with its phone and a web session with its browser', async () => {
    mockApi({ [LIST]: page });
    await renderSessions();
    for (const text of [
      'Asha Rao',
      'EMP-7',
      'Mobile · iPhone 15',
      'iOS 27.0.1',
      '203.0.113.7',
      '3 Oct 2026, 10:00 am',
      '4 Oct 2026, 2:42 pm',
      'Active',
    ]) {
      expect(row(21).getByText(text)).toBeOnTheScreen();
    }
    for (const text of ['Ravi Kumar', 'EMP-9', 'Web · Chrome 140', 'Windows 11']) {
      expect(row(22).getByText(text)).toBeOnTheScreen();
    }
  });

  it('says so when the browser, the phone or the IP is not known', async () => {
    sessions = [
      sessionBody({ id: 31, client: 'web', browser: null, device_model: null, os: null, ip: null }),
      sessionBody({ id: 32, device_model: null }),
    ];
    mockApi({ [LIST]: page });
    await renderSessions();
    expect(row(31).getByText('Web · Unknown browser')).toBeOnTheScreen();
    expect(row(31).getAllByText('Not recorded')).toHaveLength(2);
    expect(row(32).getByText('Mobile · Unknown phone')).toBeOnTheScreen();
  });

  it('shows why a session ended, and Ended for a reason it does not know', async () => {
    sessions = [
      ENDED,
      sessionBody({ id: 24, status: 'ended', end_reason: 'password_changed' }),
      sessionBody({ id: 25, status: 'ended', end_reason: 'expired' }),
      sessionBody({ id: 26, status: 'ended', end_reason: 'something_new' }),
      sessionBody({ id: 27, status: 'ended', end_reason: null }),
    ];
    mockApi({ [LIST]: page });
    await renderSessions();
    await fireEvent.press(button('Ended: 5'));
    await waitFor(() => expect(lastQuery().get('status')).toBe('ended'));

    expect(await row(23).findByText('Signed out by an admin')).toBeOnTheScreen();
    expect(row(24).getByText('Password changed')).toBeOnTheScreen();
    expect(row(25).getByText('Expired')).toBeOnTheScreen();
    expect(row(26).getByText('Ended')).toBeOnTheScreen();
    expect(row(27).getByText('Ended')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Sign out session of/ })).toBeNull();
  });

  it('sends no status for All', async () => {
    mockApi({ [LIST]: page });
    await renderSessions();
    await fireEvent.press(button('All: 3'));
    expect(await screen.findByTestId('session-23')).toBeOnTheScreen();
    expect(lastQuery().get('status')).toBeNull();
  });

  it('signs a session out after asking, then refreshes the list and the counts', async () => {
    mockApi({ [LIST]: page, 'POST /api/v1/admin/sessions/22/revoke': revoke(22) });
    await renderSessions();
    await fireEvent.press(button('Sign out session of Ravi Kumar'));

    expect(dialog().getByRole('header', { name: 'Sign out this session' })).toBeOnTheScreen();
    expect(
      dialog().getByText('Sign out Ravi Kumar on Chrome 140? They must sign in again to continue.'),
    ).toBeOnTheScreen();
    expect(dialog().queryByRole('alert')).toBeNull();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    await fireEvent.press(dialog().getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.queryByTestId('dialog')).toBeNull());
    const post = calls.find((call) => call.method === 'POST');
    expect(new URL(post!.url).pathname).toBe('/api/v1/admin/sessions/22/revoke');

    expect(await screen.findByRole('button', { name: 'Active: 1' })).toBeOnTheScreen();
    expect(button('Ended: 2')).toBeOnTheScreen();
    await waitFor(() => expect(screen.queryByTestId('session-22')).toBeNull());
  });

  it('marks the session in use and warns that this phone will be signed out', async () => {
    sessions = [sessionBody({ current: true }), WEB];
    mockApi({ [LIST]: page });
    await renderSessions();
    expect(row(21).getByText('This session')).toBeOnTheScreen();
    expect(row(22).queryByText('This session')).toBeNull();

    await fireEvent.press(button('Sign out session of Asha Rao'));
    expect(dialog().getByRole('alert')).toHaveTextContent(
      'This is the session you are using now: this phone will be signed out.',
    );
  });

  it('keeps the dialog open with the server message when the session already ended', async () => {
    mockApi({
      [LIST]: page,
      'POST /api/v1/admin/sessions/22/revoke': () =>
        failure(409, 'CONFLICT', 'This session has already ended.'),
    });
    await renderSessions();
    const before = listCalls().length;
    await fireEvent.press(button('Sign out session of Ravi Kumar'));
    await fireEvent.press(dialog().getByRole('button', { name: 'Sign out' }));
    expect(await dialog().findByText('This session has already ended.')).toBeOnTheScreen();
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(before));
  });

  it('shows the empty state', async () => {
    sessions = [];
    mockApi({ [LIST]: page });
    await renderSessions();
    expect(await screen.findByText('No active sessions found.')).toBeOnTheScreen();
  });
});
