import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';
import { THEME_KEY } from '@/lib/theme';
import { getTokens, setTokens } from '@/lib/token-store';
import { meBody, mockApi } from '@/test/fake-api';
import { resetSecureStore, secureStoreContents } from '@/test/secure-store-mock';

const tab = (name: string) => screen.getByRole('button', { name });
const selected = (name: string) => tab(name).props.accessibilityState.selected;

// Renders the real root layout, so this covers the tab shell as the app mounts it.
describe('tab shell', () => {
  beforeEach(async () => {
    resetSecureStore();
    await setTokens({ access: 'access-1', refresh: 'refresh-1' });
    mockApi({
      'GET /api/v1/me': () => Response.json(meBody()),
      'POST /api/v1/auth/logout': () => new Response(null, { status: 204 }),
    });
  });

  it('has exactly two tabs, Home and Profile & Settings, and opens on Home', async () => {
    await renderRouter('./src/app');
    expect(await screen.findByText('Welcome back')).toBeOnTheScreen();
    await screen.findByText('Test Phone');
    // With an active device Home has no other button, so every button here is a tab.
    const names = screen.getAllByRole('button').map((button) => button.props.accessibilityLabel);
    expect(names).toEqual(['Home', 'Profile & Settings']);
    expect(selected('Home')).toBe(true);
    expect(selected('Profile & Settings')).toBe(false);
  });

  it('opens Profile with the details, switches the theme there and signs out', async () => {
    await renderRouter('./src/app');
    await screen.findByText('Test Phone');
    await fireEvent.press(tab('Profile & Settings'));

    expect(await screen.findByText('EMP-7')).toBeOnTheScreen();
    expect(selected('Profile & Settings')).toBe(true);
    expect(selected('Home')).toBe(false);

    await fireEvent.press(screen.getByRole('button', { name: 'Dark' }));
    expect(selected('Dark')).toBe(true);
    await waitFor(() => expect(secureStoreContents()[THEME_KEY]).toBe('dark'));

    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByLabelText('Employee ID or mobile number')).toBeOnTheScreen();
    expect(await getTokens()).toBeNull();
  });
});
