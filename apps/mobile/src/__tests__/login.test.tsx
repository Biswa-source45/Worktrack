import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import LoginScreen from '@/app/(auth)/login';
import { getTokens } from '@/lib/token-store';
import { calls, errorBody, meBody, mockApi, tokenBody } from '@/test/fake-api';
import { renderWithAuth } from '@/test/render';
import { resetSecureStore } from '@/test/secure-store-mock';

const login = (response: () => Response) => ({
  'POST /api/v1/auth/login': response,
  'GET /api/v1/me': () => Response.json(meBody()),
});

async function submit(identifier = 'EMP-7', password = 'secret-pass-1') {
  await fireEvent.changeText(screen.getByLabelText('Employee ID or mobile number'), identifier);
  await fireEvent.changeText(screen.getByLabelText('Password'), password);
  await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
}

// A sign-in reloads /me in the background; let that land so nothing updates after the test.
async function profileLoaded() {
  await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/v1/me'))).toBe(true));
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

beforeEach(() => resetSecureStore());

describe('LoginScreen', () => {
  it('requires both fields and sends nothing', async () => {
    mockApi({});
    await renderWithAuth(<LoginScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findAllByText('This field is required.')).toHaveLength(2);
    expect(calls).toHaveLength(0);
  });

  it('sends client mobile with the device info, then stores the tokens', async () => {
    mockApi(login(() => Response.json(tokenBody())));
    await renderWithAuth(<LoginScreen />);
    await submit();
    await waitFor(async () =>
      expect(await getTokens()).toEqual({ access: 'access-1', refresh: 'refresh-1' }),
    );
    const request = calls.find((c) => c.url.endsWith('/api/v1/auth/login'));
    const body = await request?.json();
    expect(body).toMatchObject({
      identifier: 'EMP-7',
      password: 'secret-pass-1',
      client: 'mobile',
    });
    expect(body.device).toEqual({
      device_id: '11111111-2222-3333-4444-555555555555',
      model: 'Test Phone',
      os: expect.stringMatching(/^(iOS|Android) \S+/),
      app_version: expect.stringMatching(/\S/),
    });
    expect(request?.headers.get('Authorization')).toBeNull();
    await profileLoaded();
  });

  it('hides the password until Show password is pressed, and keeps what was typed', async () => {
    mockApi({});
    await renderWithAuth(<LoginScreen />);
    const input = () => screen.getByLabelText('Password');
    await fireEvent.changeText(input(), 'secret-pass-1');
    expect(input().props.secureTextEntry).toBe(true);
    expect(input().props.textContentType).toBe('password');
    expect(input().props.autoComplete).toBe('password');

    await fireEvent.press(screen.getByRole('button', { name: 'Show password' }));
    expect(input().props.secureTextEntry).toBe(false);
    expect(input().props.value).toBe('secret-pass-1');
    expect(screen.getByRole('button', { name: 'Hide password' })).toBeOnTheScreen();
  });

  it('shows one generic message for invalid credentials', async () => {
    mockApi(login(() => errorBody('INVALID_CREDENTIALS', null, 401)));
    await renderWithAuth(<LoginScreen />);
    await submit();
    expect(await screen.findByText('Invalid employee ID or password.')).toBeOnTheScreen();
    expect(await getTokens()).toBeNull();
  });

  it('shows the lockout in minutes, rounded up', async () => {
    mockApi(login(() => errorBody('ACCOUNT_LOCKED', { retry_after_seconds: 601 }, 423)));
    await renderWithAuth(<LoginScreen />);
    await submit();
    expect(
      await screen.findByText('Too many failed attempts. Try again in 11 minutes.'),
    ).toBeOnTheScreen();
  });

  it('uses the singular for a one minute lockout', async () => {
    mockApi(login(() => errorBody('ACCOUNT_LOCKED', { retry_after_seconds: 20 }, 423)));
    await renderWithAuth(<LoginScreen />);
    await submit();
    expect(
      await screen.findByText('Too many failed attempts. Try again in 1 minute.'),
    ).toBeOnTheScreen();
  });

  it('shows the rate limit message', async () => {
    mockApi(login(() => errorBody('RATE_LIMITED', { retry_after_seconds: 30 }, 429)));
    await renderWithAuth(<LoginScreen />);
    await submit();
    expect(
      await screen.findByText('Too many attempts. Please wait a moment and try again.'),
    ).toBeOnTheScreen();
  });

  it('shows a generic message for any other error', async () => {
    mockApi(login(() => errorBody('SOMETHING_NEW', null, 500)));
    await renderWithAuth(<LoginScreen />);
    await submit();
    expect(await screen.findByText('Something went wrong. Please try again.')).toBeOnTheScreen();
  });

  it('offers a retry after a network error, and signs in on the retry', async () => {
    mockApi({
      ...login(() => Response.json(tokenBody())),
      'POST /api/v1/auth/login': (() => {
        let attempt = 0;
        return () => {
          if (attempt++ === 0) throw new TypeError('Network request failed');
          return Response.json(tokenBody());
        };
      })(),
    });
    await renderWithAuth(<LoginScreen />);
    await submit();
    expect(
      await screen.findByText('Cannot reach the server. Check your connection and try again.'),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(async () => expect(await getTokens()).not.toBeNull());
    expect(screen.queryByText(/Cannot reach the server/)).toBeNull();
    await profileLoaded();
  });
});
