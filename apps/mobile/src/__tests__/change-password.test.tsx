import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import ChangePasswordScreen from '@/app/(auth)/change-password';
import { getTokens, setTokens } from '@/lib/token-store';
import { calls, errorBody, meBody, mockApi, tokenBody } from '@/test/fake-api';
import { renderWithAuth } from '@/test/render';
import { resetSecureStore } from '@/test/secure-store-mock';

const CHANGE = 'POST /api/v1/auth/change-password';
const me = () => Response.json(meBody({ must_change_password: true }));

async function fill(current: string, next: string, confirm: string) {
  await fireEvent.changeText(screen.getByLabelText('Current password'), current);
  await fireEvent.changeText(screen.getByLabelText('New password'), next);
  await fireEvent.changeText(screen.getByLabelText('Confirm new password'), confirm);
  await fireEvent.press(screen.getByRole('button', { name: 'Change password' }));
}

beforeEach(async () => {
  resetSecureStore();
  await setTokens({ access: 'old-access', refresh: 'old-refresh' });
});

describe('ChangePasswordScreen', () => {
  it('rejects a short password and sends nothing', async () => {
    mockApi({ 'GET /api/v1/me': me });
    await renderWithAuth(<ChangePasswordScreen />);
    await fill('temp-pass-1', 'short', 'short');
    expect(await screen.findByText('Use at least 10 characters.')).toBeOnTheScreen();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('rejects a confirmation that does not match', async () => {
    mockApi({ 'GET /api/v1/me': me });
    await renderWithAuth(<ChangePasswordScreen />);
    await fill('temp-pass-1', 'new-password-1', 'new-password-2');
    expect(await screen.findByText('The passwords do not match.')).toBeOnTheScreen();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('sends the passwords with the bearer and stores the new token pair', async () => {
    mockApi({
      'GET /api/v1/me': me,
      [CHANGE]: () =>
        Response.json(tokenBody({ access_token: 'new-access', refresh_token: 'new-refresh' })),
    });
    await renderWithAuth(<ChangePasswordScreen />);
    await fill('temp-pass-1', 'new-password-1', 'new-password-1');
    await waitFor(async () =>
      expect(await getTokens()).toEqual({ access: 'new-access', refresh: 'new-refresh' }),
    );
    const request = calls.find((c) => c.method === 'POST');
    expect(await request?.json()).toEqual({
      current_password: 'temp-pass-1',
      new_password: 'new-password-1',
    });
    expect(request?.headers.get('Authorization')).toBe('Bearer old-access');
  });

  it('shows the server message for a wrong current password', async () => {
    mockApi({
      'GET /api/v1/me': me,
      [CHANGE]: () => errorBody('INVALID_CURRENT_PASSWORD', null, 400),
    });
    await renderWithAuth(<ChangePasswordScreen />);
    await fill('wrong-pass-1', 'new-password-1', 'new-password-1');
    expect(await screen.findByText('The current password is incorrect.')).toBeOnTheScreen();
    expect(await getTokens()).toEqual({ access: 'old-access', refresh: 'old-refresh' });
  });
});
