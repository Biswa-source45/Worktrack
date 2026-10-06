import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import HomeScreen from '@/app/(app)/index';
import { getDeviceInfo, getTokens, setTokens } from '@/lib/token-store';
import { calls, errorBody, meBody, mockApi } from '@/test/fake-api';
import { renderWithAuth } from '@/test/render';
import { resetSecureStore } from '@/test/secure-store-mock';

// Home is rendered without a navigator here, which useFocusEffect needs; the focus refetch is
// tested in punch-card.test.tsx.
jest.mock('@/lib/use-refetch-on-focus', () => ({ useRefetchOnFocus: jest.fn() }));

const ME = 'GET /api/v1/me';
// Status icons are decorative for screen readers (the badge carries the label), so the default
// queries skip them.
const HIDDEN = { includeHiddenElements: true };
const PENDING_TEXT =
  'Waiting for admin approval of this phone. You cannot punch in until it is approved.';

beforeEach(async () => {
  resetSecureStore();
  await setTokens({ access: 'access-1', refresh: 'refresh-1' });
});

describe('HomeScreen', () => {
  // The Employee ID, Designation, Role and Department rows moved to the Profile tab
  // (profile.test.tsx asserts them there).
  it('greets the employee by name', async () => {
    mockApi({ [ME]: () => Response.json(meBody()) });
    await renderWithAuth(<HomeScreen />);
    expect(await screen.findByText('Asha Rao')).toBeOnTheScreen();
    expect(screen.getByText('Welcome back')).toBeOnTheScreen();
    expect(screen.queryByText(PENDING_TEXT)).toBeNull();
    await screen.findByText('Test Phone');
  });

  it('shows the pending banner and clears it after Check again finds the phone approved', async () => {
    let status = 'pending';
    mockApi({ [ME]: () => Response.json(meBody({ device: { id: 9, status } })) });
    await renderWithAuth(<HomeScreen />);
    expect(await screen.findByText(PENDING_TEXT)).toBeOnTheScreen();
    expect(screen.getByRole('alert')).toHaveTextContent(PENDING_TEXT);

    status = 'active';
    await fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.queryByText(PENDING_TEXT)).toBeNull());
    expect(calls.filter((c) => c.url.endsWith('/api/v1/me'))).toHaveLength(2);
  });

  it('tells the employee what to do when the phone belongs to another employee', async () => {
    const device = { id: 9, status: 'pending', pending_reason: 'phone_in_use' };
    mockApi({ [ME]: () => Response.json(meBody({ device })) });
    await renderWithAuth(<HomeScreen />);
    expect(
      await screen.findByText(
        'This phone is registered to another employee. Ask your admin to approve this phone. You cannot punch in until it is approved.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText(PENDING_TEXT)).toBeNull();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeOnTheScreen();
    await screen.findByText('Test Phone');
  });

  it('shows the revoked message and signs out from its button', async () => {
    mockApi({
      [ME]: () => Response.json(meBody({ device: { id: 9, status: 'revoked' } })),
      'POST /api/v1/auth/logout': () => new Response(null, { status: 204 }),
    });
    await renderWithAuth(<HomeScreen />);
    expect(
      await screen.findByText(
        'This phone is no longer approved for your account. Sign out and contact your admin.',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(async () => expect(await getTokens()).toBeNull());
    const logout = calls.find((c) => c.url.endsWith('/api/v1/auth/logout'));
    expect(await logout?.json()).toEqual({ refresh_token: 'refresh-1' });
    // Signed out, the screen falls back to its not-loaded state; wait for it to settle.
    await waitFor(() => expect(screen.queryByText('Asha Rao')).toBeNull());
  });

  it('offers Retry and Sign out when the profile cannot be loaded', async () => {
    let fail = true;
    mockApi({
      [ME]: () => (fail ? errorBody('SOMETHING_NEW', null, 500) : Response.json(meBody())),
    });
    await renderWithAuth(<HomeScreen />);
    expect(await screen.findByText('Could not load your profile.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeOnTheScreen();

    fail = false;
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Asha Rao')).toBeOnTheScreen();
    await screen.findByText('Test Phone');
  });

  it('shows a labelled placeholder, not a blank screen, while the profile loads', async () => {
    let answer: (response: Response) => void = () => {};
    mockApi({ [ME]: () => new Promise<Response>((resolve) => (answer = resolve)) });
    await renderWithAuth(<HomeScreen />);
    expect(await screen.findByLabelText('Loading...')).toBeOnTheScreen();

    answer(Response.json(meBody()));
    expect(await screen.findByText('Asha Rao')).toBeOnTheScreen();
    await screen.findByText('Test Phone');
  });

  describe('This device card', () => {
    const status = () => screen.getByTestId('device-status');

    it('shows Active with the local model, OS and app version, and not the device id', async () => {
      mockApi({ [ME]: () => Response.json(meBody()) });
      await renderWithAuth(<HomeScreen />);
      const info = await getDeviceInfo();
      expect(await screen.findByText(info.os)).toBeOnTheScreen();
      expect(info.os).toBe('iOS 27.0.1');
      expect(screen.getByTestId('device-card')).toBeOnTheScreen();
      expect(screen.getByText('This device')).toBeOnTheScreen();
      expect(screen.getByText('Test Phone')).toBeOnTheScreen();
      expect(screen.getByText(info.app_version)).toBeOnTheScreen();
      // The "✓" glyph became an icon: the status is the icon plus the label.
      expect(screen.getByTestId('device-status-icon-active', HIDDEN)).toBeOnTheScreen();
      expect(status()).toHaveTextContent('Active');
      expect(status().props.accessibilityLabel).toBe('Device status: Active');
      expect(screen.queryByText(info.device_id)).toBeNull();
    });

    it('shows Pending approval next to the banner and updates after Check again', async () => {
      let state = 'pending';
      mockApi({ [ME]: () => Response.json(meBody({ device: { id: 9, status: state } })) });
      await renderWithAuth(<HomeScreen />);
      expect(await screen.findByText(PENDING_TEXT)).toBeOnTheScreen();
      expect(screen.getByTestId('device-status-icon-pending', HIDDEN)).toBeOnTheScreen();
      expect(status()).toHaveTextContent('Pending approval');
      expect(status().props.accessibilityLabel).toBe('Device status: Pending approval');
      expect(
        screen.getByText('You cannot punch in until an admin approves this phone.'),
      ).toBeOnTheScreen();

      state = 'active';
      await fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
      await waitFor(() => expect(status()).toHaveTextContent('Active'));
      expect(screen.getByTestId('device-status-icon-active', HIDDEN)).toBeOnTheScreen();
      expect(screen.queryByTestId('device-status-icon-pending', HIDDEN)).toBeNull();
      expect(screen.queryByText(PENDING_TEXT)).toBeNull();
    });

    it('shows Revoked', async () => {
      mockApi({ [ME]: () => Response.json(meBody({ device: { id: 9, status: 'revoked' } })) });
      await renderWithAuth(<HomeScreen />);
      await screen.findByText('Test Phone');
      expect(screen.getByTestId('device-status-icon-revoked', HIDDEN)).toBeOnTheScreen();
      expect(status()).toHaveTextContent('Revoked');
      expect(status().props.accessibilityLabel).toBe('Device status: Revoked');
    });

    it('shows Not registered when the server returns no device', async () => {
      mockApi({ [ME]: () => Response.json(meBody({ device: null })) });
      await renderWithAuth(<HomeScreen />);
      await screen.findByText('Test Phone');
      expect(screen.getByTestId('device-status-icon-unregistered', HIDDEN)).toBeOnTheScreen();
      expect(status()).toHaveTextContent('Not registered');
    });
  });
});
