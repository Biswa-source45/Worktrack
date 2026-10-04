import { act, fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { Href } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import { setTokens } from '@/lib/token-store';
import { calls, meBody, mockApi } from '@/test/fake-api';
import { resetSecureStore } from '@/test/secure-store-mock';

const tab = (name: string) => screen.getByRole('button', { name });
const selected = (name: string) => tab(name).props.accessibilityState.selected;
const adminCalls = () => calls.filter((call) => call.url.includes('/api/v1/admin/'));

const EMPTY = { items: [], next_cursor: null };

function signInWith(permissions: string[]) {
  mockApi({
    'GET /api/v1/me': () => Response.json(meBody({ permissions })),
    'GET /api/v1/admin/devices': () =>
      Response.json({ ...EMPTY, counts: { pending: 0, active: 0, revoked: 0 } }),
    'GET /api/v1/admin/sessions': () =>
      Response.json({ ...EMPTY, counts: { active: 0, ended: 0 } }),
    'GET /api/v1/admin/employees': () => Response.json(EMPTY),
    'GET /api/v1/me/sessions': () => Response.json([]),
    'POST /api/v1/auth/logout': () => new Response(null, { status: 204 }),
  });
}

async function openApp(initialUrl = '/') {
  await renderRouter('./src/app', { initialUrl });
  await screen.findByText('Welcome back');
  await screen.findByText('Test Phone');
}

// Renders the real root layout, so this covers the tab shell and the route guard as the app
// mounts them.
describe('Admin tab', () => {
  beforeEach(async () => {
    resetSecureStore();
    await setTokens({ access: 'access-1', refresh: 'refresh-1' });
  });

  // The app keeps one query cache for its whole life. Signing out empties it, as on a real
  // phone, so the next test does not start with this user's permissions.
  afterEach(async () => {
    await fireEvent.press(tab('Profile & Settings'));
    await fireEvent.press(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByLabelText('Employee ID or mobile number');
  });

  it('does not exist for an employee without admin permissions', async () => {
    signInWith([]);
    await openApp();
    const names = screen.getAllByRole('button').map((button) => button.props.accessibilityLabel);
    expect(names).toEqual(['Home', 'Profile & Settings']);
    expect(screen.queryByText('Admin')).toBeNull();
  });

  it('lands on Home when the admin route is opened without permission', async () => {
    signInWith([]);
    await openApp();
    await act(async () => router.navigate('/admin' as Href));
    await act(async () => router.navigate('/admin/employees/1' as Href));

    expect(screen.getByText('Welcome back')).toBeOnTheScreen();
    expect(selected('Home')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Admin' })).toBeNull();
    expect(screen.queryByRole('header', { name: 'Admin' })).toBeNull();
    expect(adminCalls()).toEqual([]);
  });

  // The control for the test above: the same navigation does open Admin with the permission.
  it('opens the admin route with permission', async () => {
    signInWith(['devices.manage']);
    await openApp();
    await act(async () => router.navigate('/admin' as Href));
    expect(await screen.findByRole('header', { name: 'Admin' })).toBeOnTheScreen();
    expect(selected('Admin')).toBe(true);
    expect(await screen.findByText('No devices found.')).toBeOnTheScreen();
  });

  it('offers Devices and Sessions, not Employees, with devices.manage', async () => {
    signInWith(['devices.manage']);
    await openApp();
    expect(screen.getAllByRole('button').map((button) => button.props.accessibilityLabel)).toEqual([
      'Home',
      'Profile & Settings',
      'Admin',
    ]);
    await fireEvent.press(tab('Admin'));

    expect(await screen.findByRole('header', { name: 'Admin' })).toBeOnTheScreen();
    expect(selected('Admin')).toBe(true);
    expect(selected('Home')).toBe(false);
    expect(selected('Devices')).toBe(true);
    expect(selected('Sessions')).toBe(false);
    expect(screen.queryByRole('button', { name: 'Employees' })).toBeNull();
    expect(await screen.findByText('No devices found.')).toBeOnTheScreen();

    await fireEvent.press(tab('Sessions'));
    expect(await screen.findByText('No active sessions found.')).toBeOnTheScreen();
    expect(selected('Sessions')).toBe(true);
    expect(adminCalls().some((call) => call.url.includes('/admin/employees'))).toBe(false);
  });

  it('offers only Employees with employees.manage', async () => {
    signInWith(['employees.manage']);
    await openApp();
    await fireEvent.press(tab('Admin'));

    expect(await screen.findByRole('header', { name: 'Employees' })).toBeOnTheScreen();
    expect(await screen.findByText('No employees found.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Devices' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sessions' })).toBeNull();
    expect(adminCalls().every((call) => call.url.includes('/admin/employees'))).toBe(true);
  });

  it('offers all three sections with both permissions', async () => {
    signInWith(['devices.manage', 'employees.manage']);
    await openApp();
    await fireEvent.press(tab('Admin'));

    expect(await screen.findByRole('header', { name: 'Admin' })).toBeOnTheScreen();
    for (const name of ['Devices', 'Employees', 'Sessions']) {
      expect(tab(name)).toBeOnTheScreen();
    }
    expect(await screen.findByText('No devices found.')).toBeOnTheScreen();

    await fireEvent.press(tab('Employees'));
    expect(await screen.findByText('No employees found.')).toBeOnTheScreen();
    expect(selected('Employees')).toBe(true);
    expect(screen.getByLabelText('Search by name, code or mobile')).toBeOnTheScreen();
  });

  it('keeps an employee page closed to an admin who only manages devices', async () => {
    signInWith(['devices.manage']);
    await openApp();
    await fireEvent.press(tab('Admin'));
    await screen.findByText('No devices found.');
    await act(async () => router.navigate('/admin/employees/1' as Href));

    expect(screen.getByRole('header', { name: 'Admin' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(adminCalls().some((call) => call.url.includes('/admin/employees'))).toBe(false);
  });
});
