import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import ProfileScreen from '@/app/(app)/profile';
import { setTokens } from '@/lib/token-store';
import { calls, failure, meBody, mockApi, sessionBody } from '@/test/fake-api';
import { renderWithAuth } from '@/test/render';
import { resetSecureStore } from '@/test/secure-store-mock';

const ME = 'GET /api/v1/me';
const MINE = 'GET /api/v1/me/sessions';
const REVOKE = 'POST /api/v1/me/sessions/revoke-others';
const OTHERS = 'Sign out other sessions';
const row = (id: number) => within(screen.getByTestId(`my-session-${id}`));
const dialog = () => within(screen.getByTestId('dialog'));

const THIS = sessionBody({ current: true });
const WEB = sessionBody({
  id: 22,
  client: 'web',
  browser: 'Chrome 140',
  os: 'Windows 11',
  device_model: null,
  last_seen_at: '2026-10-04T19:00:00Z',
});

async function renderProfile() {
  await renderWithAuth(<ProfileScreen />);
  await screen.findByText('Asha Rao');
  await screen.findByText(/^WorkTrack version \S+/);
}

beforeEach(async () => {
  resetSecureStore();
  await setTokens({ access: 'access-1', refresh: 'refresh-1' });
});

describe('Your sessions (Profile & Settings)', () => {
  it('lists the live sessions and marks the one on this phone', async () => {
    mockApi({ [ME]: () => Response.json(meBody()), [MINE]: () => Response.json([THIS, WEB]) });
    await renderProfile();
    expect(screen.getByRole('header', { name: 'Your sessions' })).toBeOnTheScreen();

    expect(await row(21).findByText('Mobile · iPhone 15')).toBeOnTheScreen();
    expect(row(21).getByText('iOS 27.0.1 · Last seen 4 Oct 2026, 2:42 pm')).toBeOnTheScreen();
    expect(row(21).getByText('This device')).toBeOnTheScreen();

    expect(row(22).getByText('Web · Chrome 140')).toBeOnTheScreen();
    expect(row(22).getByText('Windows 11 · Last seen 5 Oct 2026, 12:30 am')).toBeOnTheScreen();
    expect(row(22).queryByText('This device')).toBeNull();
    expect(screen.getByRole('button', { name: OTHERS })).toBeOnTheScreen();
  });

  it('keeps the rest of the screen working next to the new card', async () => {
    mockApi({ [ME]: () => Response.json(meBody()), [MINE]: () => Response.json([THIS]) });
    await renderProfile();
    await screen.findByTestId('my-session-21');
    expect(screen.getByText('EMP-7')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Appearance' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeOnTheScreen();
  });

  it('has no Sign out other sessions button when this is the only session', async () => {
    mockApi({ [ME]: () => Response.json(meBody()), [MINE]: () => Response.json([THIS]) });
    await renderProfile();
    await screen.findByTestId('my-session-21');
    expect(screen.queryByRole('button', { name: OTHERS })).toBeNull();
  });

  it('signs the other sessions out after asking, reloads the list and says how many', async () => {
    let sessions = [THIS, WEB, sessionBody({ id: 23, device_model: 'Old Phone' })];
    mockApi({
      [ME]: () => Response.json(meBody()),
      [MINE]: () => Response.json(sessions),
      [REVOKE]: () => {
        sessions = [THIS];
        return Response.json({ revoked: 2 });
      },
    });
    await renderProfile();
    await fireEvent.press(await screen.findByRole('button', { name: OTHERS }));
    expect(
      dialog().getByText(
        'Sign out every other session of your account? This phone stays signed in.',
      ),
    ).toBeOnTheScreen();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    await fireEvent.press(dialog().getByRole('button', { name: OTHERS }));
    await waitFor(() => expect(screen.queryByTestId('dialog')).toBeNull());
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);

    expect(await screen.findByText('Signed out 2 other sessions.')).toBeOnTheScreen();
    expect(screen.queryByTestId('my-session-22')).toBeNull();
    expect(screen.queryByTestId('my-session-23')).toBeNull();
    expect(screen.getByTestId('my-session-21')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: OTHERS })).toBeNull();
  });

  it('uses the singular for one session', async () => {
    let sessions = [THIS, WEB];
    mockApi({
      [ME]: () => Response.json(meBody()),
      [MINE]: () => Response.json(sessions),
      [REVOKE]: () => {
        sessions = [THIS];
        return Response.json({ revoked: 1 });
      },
    });
    await renderProfile();
    await fireEvent.press(await screen.findByRole('button', { name: OTHERS }));
    await fireEvent.press(dialog().getByRole('button', { name: OTHERS }));
    expect(await screen.findByText('Signed out 1 other session.')).toBeOnTheScreen();
  });

  it('keeps the dialog open with the server message when signing out fails', async () => {
    mockApi({
      [ME]: () => Response.json(meBody()),
      [MINE]: () => Response.json([THIS, WEB]),
      [REVOKE]: () => failure(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.'),
    });
    await renderProfile();
    await fireEvent.press(await screen.findByRole('button', { name: OTHERS }));
    await fireEvent.press(dialog().getByRole('button', { name: OTHERS }));
    expect(await dialog().findByText('Too many requests. Try again shortly.')).toBeOnTheScreen();
    expect(screen.getByTestId('my-session-22')).toBeOnTheScreen();
  });

  it('shows an error with Retry when the list cannot load', async () => {
    let fail = true;
    mockApi({
      [ME]: () => Response.json(meBody()),
      [MINE]: () =>
        fail ? failure(500, 'INTERNAL', 'The server had a problem.') : Response.json([THIS]),
    });
    await renderProfile();
    expect(await screen.findByText('Could not load your sessions.')).toBeOnTheScreen();
    fail = false;
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('my-session-21')).toBeOnTheScreen();
    expect(screen.queryByText('Could not load your sessions.')).toBeNull();
  });
});
