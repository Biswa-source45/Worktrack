import { fireEvent, screen } from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';
import { sessionGuards } from '@/lib/auth';
import type { Me } from '@/lib/auth';
import { getTokens, setTokens } from '@/lib/token-store';
import { errorBody, meBody, mockApi, tokenBody } from '@/test/fake-api';
import { resetSecureStore } from '@/test/secure-store-mock';

const ME = 'GET /api/v1/me';
const LOGIN_FIELD = 'Employee ID or mobile number';

describe('sessionGuards', () => {
  const me = meBody() as Me;
  const mustChange = meBody({ must_change_password: true }) as Me;

  it.each([
    ['loading', undefined, { loading: true, signedOut: false, mustChange: false, ready: false }],
    ['signedOut', undefined, { loading: false, signedOut: true, mustChange: false, ready: false }],
    ['signedIn', me, { loading: false, signedOut: false, mustChange: false, ready: true }],
    ['signedIn', mustChange, { loading: false, signedOut: false, mustChange: true, ready: false }],
    // /me failed (offline): home shows the retry state rather than trapping the user on a gate.
    ['signedIn', undefined, { loading: false, signedOut: false, mustChange: false, ready: true }],
  ] as const)('%s with %#', (status, user, expected) => {
    expect(sessionGuards(status, user)).toEqual(expected);
  });
});

// Renders the real root layout and screens (src/app), so these also prove the redirects work.
describe('route gate', () => {
  beforeEach(() => resetSecureStore());

  it('shows login when there are no stored tokens', async () => {
    mockApi({});
    await renderRouter('./src/app');
    expect(await screen.findByLabelText(LOGIN_FIELD)).toBeOnTheScreen();
  });

  it('goes to home after a successful sign in', async () => {
    mockApi({
      'POST /api/v1/auth/login': () => Response.json(tokenBody()),
      [ME]: () => Response.json(meBody()),
    });
    await renderRouter('./src/app');
    await fireEvent.changeText(await screen.findByLabelText(LOGIN_FIELD), 'EMP-7');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'secret-pass-1');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Asha Rao')).toBeOnTheScreen();
    expect(screen.queryByLabelText(LOGIN_FIELD)).toBeNull();
  });

  it('opens straight on home when tokens are already stored', async () => {
    await setTokens({ access: 'access-1', refresh: 'refresh-1' });
    mockApi({ [ME]: () => Response.json(meBody()) });
    await renderRouter('./src/app');
    expect(await screen.findByText('Asha Rao')).toBeOnTheScreen();
  });

  it('forces the password change first, then lets the user in', async () => {
    // /me reports the flag until the password has been changed.
    let changed = false;
    mockApi({
      'POST /api/v1/auth/login': () => Response.json(tokenBody({ must_change_password: true })),
      'POST /api/v1/auth/change-password': () => {
        changed = true;
        return Response.json(
          tokenBody({ access_token: 'new-access', refresh_token: 'new-refresh' }),
        );
      },
      [ME]: () => Response.json(meBody({ must_change_password: !changed })),
    });
    await renderRouter('./src/app');
    await fireEvent.changeText(await screen.findByLabelText(LOGIN_FIELD), 'ADMIN-1');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'temp-pass-1234');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Set a new password')).toBeOnTheScreen();
    expect(screen.queryByText('Asha Rao')).toBeNull();

    await fireEvent.changeText(screen.getByLabelText('Current password'), 'temp-pass-1234');
    await fireEvent.changeText(screen.getByLabelText('New password'), 'brand-new-pass-1');
    await fireEvent.changeText(screen.getByLabelText('Confirm new password'), 'brand-new-pass-1');
    await fireEvent.press(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText('Asha Rao')).toBeOnTheScreen();
    expect(await getTokens()).toEqual({ access: 'new-access', refresh: 'new-refresh' });
  });

  it('returns to login when the session cannot be refreshed', async () => {
    await setTokens({ access: 'stale', refresh: 'revoked' });
    mockApi({
      [ME]: () => errorBody('INVALID_TOKEN', null, 401),
      'POST /api/v1/auth/refresh': () => errorBody('INVALID_TOKEN', null, 401),
    });
    await renderRouter('./src/app');
    expect(await screen.findByLabelText(LOGIN_FIELD)).toBeOnTheScreen();
    expect(await getTokens()).toBeNull();
  });
});
