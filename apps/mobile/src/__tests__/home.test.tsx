import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import HomeScreen from '@/app/(app)/index';
import { getDeviceInfo, getTokens, setTokens } from '@/lib/token-store';
import { calls, meBody, mockApi } from '@/test/fake-api';
import { renderWithAuth } from '@/test/render';
import { resetSecureStore } from '@/test/secure-store-mock';

const ME = 'GET /api/v1/me';
const PENDING_TEXT =
  'Waiting for admin approval of this phone. You cannot punch in until it is approved.';

beforeEach(async () => {
  resetSecureStore();
  await setTokens({ access: 'access-1', refresh: 'refresh-1' });
});

describe('HomeScreen', () => {
  it('shows the profile', async () => {
    mockApi({ [ME]: () => Response.json(meBody()) });
    await renderWithAuth(<HomeScreen />);
    expect(await screen.findByText('Asha Rao')).toBeOnTheScreen();
    for (const text of ['EMP-7', 'Technician', 'Employee', 'Service']) {
      expect(screen.getByText(text)).toBeOnTheScreen();
    }
    expect(screen.queryByText(PENDING_TEXT)).toBeNull();
  });

  it('shows the pending banner and clears it after Check again finds the phone approved', async () => {
    let status = 'pending';
    mockApi({ [ME]: () => Response.json(meBody({ device: { id: 9, status } })) });
    await renderWithAuth(<HomeScreen />);
    expect(await screen.findByText(PENDING_TEXT)).toBeOnTheScreen();

    status = 'active';
    await fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.queryByText(PENDING_TEXT)).toBeNull());
    expect(calls.filter((c) => c.url.endsWith('/api/v1/me'))).toHaveLength(2);
  });

  it('shows the revoked message', async () => {
    mockApi({ [ME]: () => Response.json(meBody({ device: { id: 9, status: 'revoked' } })) });
    await renderWithAuth(<HomeScreen />);
    expect(
      await screen.findByText(
        'This phone is no longer approved for your account. Sign out and contact your admin.',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeOnTheScreen();
  });

  it('signs out: calls logout with the refresh token, then clears the stored tokens', async () => {
    mockApi({
      [ME]: () => Response.json(meBody()),
      'POST /api/v1/auth/logout': () => new Response(null, { status: 204 }),
    });
    await renderWithAuth(<HomeScreen />);
    await screen.findByText('Asha Rao');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(async () => expect(await getTokens()).toBeNull());
    const logout = calls.find((c) => c.url.endsWith('/api/v1/auth/logout'));
    expect(await logout?.json()).toEqual({ refresh_token: 'refresh-1' });
  });

  it('still signs out locally when the logout call cannot reach the server', async () => {
    mockApi({
      [ME]: () => Response.json(meBody()),
      'POST /api/v1/auth/logout': () => {
        throw new TypeError('Network request failed');
      },
    });
    await renderWithAuth(<HomeScreen />);
    await screen.findByText('Asha Rao');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(async () => expect(await getTokens()).toBeNull());
  });

  describe('This device card', () => {
    const status = () => screen.getByTestId('device-status');

    it('shows Active with the local model, OS and app version, and not the device id', async () => {
      mockApi({ [ME]: () => Response.json(meBody()) });
      await renderWithAuth(<HomeScreen />);
      const info = await getDeviceInfo();
      expect(await screen.findByText(info.os)).toBeOnTheScreen();
      expect(screen.getByTestId('device-card')).toBeOnTheScreen();
      expect(screen.getByText('This device')).toBeOnTheScreen();
      expect(screen.getByText('Test Phone')).toBeOnTheScreen();
      expect(screen.getByText(info.app_version)).toBeOnTheScreen();
      expect(status()).toHaveTextContent('✓ Active');
      expect(status().props.accessibilityLabel).toBe('Device status: Active');
      expect(screen.queryByText(info.device_id)).toBeNull();
    });

    it('shows Pending approval next to the banner and updates after Check again', async () => {
      let state = 'pending';
      mockApi({ [ME]: () => Response.json(meBody({ device: { id: 9, status: state } })) });
      await renderWithAuth(<HomeScreen />);
      expect(await screen.findByText(PENDING_TEXT)).toBeOnTheScreen();
      expect(status()).toHaveTextContent('⏳ Pending approval');
      expect(status().props.accessibilityLabel).toBe('Device status: Pending approval');
      expect(
        screen.getByText('You cannot punch in until an admin approves this phone.'),
      ).toBeOnTheScreen();

      state = 'active';
      await fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
      await waitFor(() => expect(status()).toHaveTextContent('✓ Active'));
      expect(screen.queryByText(PENDING_TEXT)).toBeNull();
    });

    it('shows Revoked', async () => {
      mockApi({ [ME]: () => Response.json(meBody({ device: { id: 9, status: 'revoked' } })) });
      await renderWithAuth(<HomeScreen />);
      await screen.findByText('Test Phone');
      expect(status()).toHaveTextContent('✕ Revoked');
      expect(status().props.accessibilityLabel).toBe('Device status: Revoked');
    });

    it('shows Not registered when the server returns no device', async () => {
      mockApi({ [ME]: () => Response.json(meBody({ device: null })) });
      await renderWithAuth(<HomeScreen />);
      await screen.findByText('Test Phone');
      expect(status()).toHaveTextContent('Not registered');
    });
  });
});
