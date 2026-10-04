import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import ProfileScreen from '@/app/(app)/profile';
import { THEME_KEY } from '@/lib/theme';
import { getTokens, setTokens } from '@/lib/token-store';
import { calls, meBody, mockApi } from '@/test/fake-api';
import { renderWithAuth } from '@/test/render';
import { resetSecureStore, secureStoreContents } from '@/test/secure-store-mock';

const ME = 'GET /api/v1/me';
const segment = (name: string) => screen.getByRole('button', { name });
const selected = (name: string) => segment(name).props.accessibilityState.selected;

async function renderProfile() {
  await renderWithAuth(<ProfileScreen />);
  await screen.findByText('Asha Rao');
  // The app version line arrives with the device info; wait so nothing updates after the test.
  await screen.findByText(/^WorkTrack version \S+/);
}

// Signing out clears the query cache; wait for the screen to settle so nothing updates after
// the test has ended.
async function signedOut() {
  await waitFor(() => expect(screen.queryByText('Asha Rao')).toBeNull());
  await screen.findByText(/^WorkTrack version \S+/);
}

beforeEach(async () => {
  resetSecureStore();
  await setTokens({ access: 'access-1', refresh: 'refresh-1' });
});

describe('ProfileScreen', () => {
  // Moved from the Home test "shows the profile": the rows now live on this tab.
  it('shows the profile details', async () => {
    mockApi({ [ME]: () => Response.json(meBody()) });
    await renderProfile();
    for (const text of ['EMP-7', 'Technician', 'Employee', 'Service']) {
      expect(screen.getByText(text)).toBeOnTheScreen();
    }
  });

  it('shows Not assigned when the employee has no department', async () => {
    mockApi({ [ME]: () => Response.json(meBody({ department: null })) });
    await renderProfile();
    expect(screen.getByText('Not assigned')).toBeOnTheScreen();
  });

  it('starts on System, switches the theme and stores the choice', async () => {
    mockApi({ [ME]: () => Response.json(meBody()) });
    await renderProfile();
    expect(selected('System')).toBe(true);
    expect(selected('Light')).toBe(false);
    expect(selected('Dark')).toBe(false);

    await fireEvent.press(segment('Dark'));
    expect(selected('Dark')).toBe(true);
    expect(selected('System')).toBe(false);
    await waitFor(() => expect(secureStoreContents()[THEME_KEY]).toBe('dark'));

    await fireEvent.press(segment('Light'));
    expect(selected('Light')).toBe(true);
    expect(selected('Dark')).toBe(false);
    await waitFor(() => expect(secureStoreContents()[THEME_KEY]).toBe('light'));
  });

  it('comes back with the stored theme selected', async () => {
    mockApi({ [ME]: () => Response.json(meBody()) });
    await renderProfile();
    await fireEvent.press(segment('Dark'));
    await waitFor(() => expect(secureStoreContents()[THEME_KEY]).toBe('dark'));
    await screen.unmount();

    await renderProfile();
    await waitFor(() => expect(selected('Dark')).toBe(true));
    expect(selected('System')).toBe(false);
  });

  // The two sign-out tests moved here from the Home test together with the button.
  it('signs out: calls logout with the refresh token, then clears the stored tokens', async () => {
    mockApi({
      [ME]: () => Response.json(meBody()),
      'POST /api/v1/auth/logout': () => new Response(null, { status: 204 }),
    });
    await renderProfile();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(async () => expect(await getTokens()).toBeNull());
    const logout = calls.find((c) => c.url.endsWith('/api/v1/auth/logout'));
    expect(await logout?.json()).toEqual({ refresh_token: 'refresh-1' });
    await signedOut();
  });

  it('still signs out locally when the logout call cannot reach the server', async () => {
    mockApi({
      [ME]: () => Response.json(meBody()),
      'POST /api/v1/auth/logout': () => {
        throw new TypeError('Network request failed');
      },
    });
    await renderProfile();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(async () => expect(await getTokens()).toBeNull());
    await signedOut();
  });
});
