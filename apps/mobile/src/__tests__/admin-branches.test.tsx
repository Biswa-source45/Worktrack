import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { Href } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import { LocationError, getCurrentFix } from '@/lib/location';
import type { LocationErrorCode } from '@/lib/location';
import { setTokens } from '@/lib/token-store';
import { bodyOf, calls, branchBody, failure, meBody, mockApi } from '@/test/fake-api';
import { resetSecureStore } from '@/test/secure-store-mock';

// The phone's GPS is replaced; the helper itself is covered in src/lib/location.test.ts.
jest.mock('@/lib/location', () => ({
  ...jest.requireActual('@/lib/location'),
  getCurrentFix: jest.fn(),
}));
const locate = jest.mocked(getCurrentFix);

type Branch = ReturnType<typeof branchBody>;
type Routes = Parameters<typeof mockApi>[0];

const LIST = 'GET /api/v1/admin/branches';
const ONE = 'GET /api/v1/admin/branches/7';
const MOVE = 'PATCH /api/v1/admin/branches/7';
const CREATE = 'POST /api/v1/admin/branches';
const USE = 'Use my current location';
const HERE = { lat: 20.3001, lng: 85.8302, accuracyM: 12.4 };

const button = (name: string | RegExp) => screen.getByRole('button', { name });
const dialog = () => within(screen.getByTestId('dialog'));
const sent = (method: string) => calls.filter((call) => call.method === method);
const listCalls = () =>
  sent('GET').filter((call) => new URL(call.url).pathname.endsWith('/branches'));

const DEPOT = branchBody({
  id: 8,
  name: 'Depot',
  address: null,
  radius_m: 60,
  is_active: false,
});

let branches: Branch[];

const page = () => Response.json({ items: branches, next_cursor: null });
const one = () => Response.json(branches.find((branch) => branch.id === 7));

function signIn(routes: Routes = {}, permissions = ['branches.manage']) {
  mockApi({
    'GET /api/v1/me': () => Response.json(meBody({ id: 99, emp_code: 'ADM-1', permissions })),
    'GET /api/v1/me/sessions': () => Response.json([]),
    'POST /api/v1/auth/logout': () => new Response(null, { status: 204 }),
    'GET /api/v1/admin/employees': () => Response.json({ items: [], next_cursor: null }),
    [LIST]: page,
    [ONE]: one,
    ...routes,
  });
}

async function openBranches() {
  await renderRouter('./src/app');
  await screen.findByText('Test Phone');
  await fireEvent.press(screen.getByRole('tab', { name: 'Admin' }));
  await screen.findByRole('header', { name: 'Branches' });
}

async function openHeadOffice() {
  await openBranches();
  await fireEvent.press(await screen.findByRole('button', { name: /^Head Office,/ }));
  await screen.findByText('Centre (latitude, longitude)');
}

async function openNew() {
  await openBranches();
  await fireEvent.press(button('New branch here'));
  await screen.findByLabelText('Branch name');
}

const type = (label: string, text: string) =>
  fireEvent.changeText(screen.getByLabelText(label), text);

describe('Admin branches', () => {
  beforeEach(async () => {
    resetSecureStore();
    await setTokens({ access: 'access-1', refresh: 'refresh-1' });
    branches = [branchBody(), DEPOT];
    locate.mockReset();
    locate.mockResolvedValue(HERE);
  });

  // The app keeps one query cache for its whole life; signing out empties it for the next test.
  afterEach(async () => {
    await fireEvent.press(screen.getByRole('tab', { name: 'Profile & Settings' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByLabelText('Employee ID or mobile number');
  });

  describe('Branches section', () => {
    it('lists branches with name, address, radius and status', async () => {
      signIn();
      await openBranches();
      expect(
        await screen.findByRole('button', {
          name: 'Head Office, 12 Station Road, Radius 150 m, Active',
        }),
      ).toBeOnTheScreen();
      expect(button('Depot, No address, Radius 60 m, Inactive')).toBeOnTheScreen();
      for (const text of ['12 Station Road', '150 m', 'Active', 'No address', '60 m', 'Inactive']) {
        expect(screen.getByText(text)).toBeOnTheScreen();
      }
      expect(new URL(listCalls()[0].url).searchParams.get('limit')).toBe('20');
    });

    it('shows a skeleton while the first page loads, then the empty state', async () => {
      let answer: (response: Response) => void = () => undefined;
      signIn({ [LIST]: () => new Promise<Response>((resolve) => (answer = resolve)) });
      await openBranches();
      expect(await screen.findByLabelText('Loading...')).toBeOnTheScreen();
      expect(screen.queryByText('No branches found.')).toBeNull();

      branches = [];
      await act(async () => answer(page()));
      expect(await screen.findByText('No branches found.')).toBeOnTheScreen();
      expect(screen.queryByLabelText('Loading...')).toBeNull();
    });

    it('shows the server message with Retry when the list cannot load', async () => {
      let fail = true;
      signIn({
        [LIST]: () => (fail ? failure(500, 'INTERNAL', 'The server had a problem.') : page()),
      });
      await openBranches();
      expect(await screen.findByText('The server had a problem.')).toBeOnTheScreen();
      fail = false;
      await fireEvent.press(button('Retry'));
      expect(await screen.findByRole('button', { name: /^Head Office,/ })).toBeOnTheScreen();
      expect(screen.queryByText('The server had a problem.')).toBeNull();
    });

    it('reloads on pull to refresh', async () => {
      signIn();
      await openBranches();
      await screen.findByRole('button', { name: /^Head Office,/ });
      const before = listCalls().length;
      branches = [...branches, branchBody({ id: 9, name: 'Warehouse' })];

      const { refreshControl } = screen.getByTestId('admin-list').props;
      await act(async () => refreshControl.props.onRefresh());
      expect(await screen.findByRole('button', { name: /^Warehouse,/ })).toBeOnTheScreen();
      expect(listCalls()).toHaveLength(before + 1);
    });

    it('keeps the branch pages closed without branches.manage', async () => {
      signIn({}, ['employees.manage']);
      await renderRouter('./src/app');
      await screen.findByText('Test Phone');
      await fireEvent.press(screen.getByRole('tab', { name: 'Admin' }));
      await screen.findByText('No employees found.');
      await act(async () => router.navigate('/admin/branches/7' as Href));
      await act(async () => router.navigate('/admin/branches/new' as Href));

      expect(screen.getByRole('header', { name: 'Employees' })).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: USE })).toBeNull();
      expect(calls.some((call) => call.url.includes('/admin/branches'))).toBe(false);
    });
  });

  describe('Branch detail', () => {
    it('opens from the list with the details and goes back', async () => {
      signIn();
      await openHeadOffice();
      expect(screen.getByRole('header', { name: 'Head Office' })).toBeOnTheScreen();
      for (const text of ['12 Station Road', '150 m', 'Active', '20.29610, 85.82450']) {
        expect(screen.getByText(text)).toBeOnTheScreen();
      }
      await fireEvent.press(button('Back'));
      expect(await screen.findByRole('button', { name: 'New branch here' })).toBeOnTheScreen();
    });

    it('moves the centre to the current location after asking, sending only lat and lng', async () => {
      signIn({
        [MOVE]: () => {
          branches = branches.map((branch) =>
            branch.id === 7 ? { ...branch, lat: HERE.lat, lng: HERE.lng } : branch,
          );
          return one();
        },
      });
      await openHeadOffice();
      await fireEvent.press(button(USE));
      expect(
        await dialog().findByText('Move the centre of Head Office here? Accuracy ±12 m'),
      ).toBeOnTheScreen();
      expect(sent('PATCH')).toHaveLength(0);

      await fireEvent.press(dialog().getByRole('button', { name: 'Move centre' }));
      await waitFor(() => expect(screen.queryByTestId('dialog')).toBeNull());
      expect(sent('PATCH')).toHaveLength(1);
      expect(await bodyOf(sent('PATCH')[0])).toEqual({ lat: HERE.lat, lng: HERE.lng });

      expect(
        await screen.findByText('The branch centre was moved to your location.'),
      ).toBeOnTheScreen();
      expect(await screen.findByText('20.30010, 85.83020')).toBeOnTheScreen();
    });

    it('sends nothing on Cancel and asks the phone again the next time', async () => {
      signIn();
      await openHeadOffice();
      await fireEvent.press(button(USE));
      await fireEvent.press(await dialog().findByRole('button', { name: 'Cancel' }));
      expect(screen.queryByTestId('dialog')).toBeNull();
      expect(sent('PATCH')).toHaveLength(0);

      await fireEvent.press(button(USE));
      await screen.findByTestId('dialog');
      expect(locate).toHaveBeenCalledTimes(2);
      await fireEvent.press(dialog().getByRole('button', { name: 'Cancel' }));
    });

    it('keeps the dialog open with the server message when the move is refused', async () => {
      signIn({ [MOVE]: () => failure(403, 'FORBIDDEN', 'You may not manage branches.') });
      await openHeadOffice();
      await fireEvent.press(button(USE));
      await fireEvent.press(await dialog().findByRole('button', { name: 'Move centre' }));
      expect(await dialog().findByText('You may not manage branches.')).toBeOnTheScreen();
      await fireEvent.press(dialog().getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByText('The branch centre was moved to your location.')).toBeNull();
      expect(screen.getByText('20.29610, 85.82450')).toBeOnTheScreen();
    });

    it.each<[LocationErrorCode, string]>([
      [
        'permission_denied',
        "WorkTrack may not use your location. Allow location for WorkTrack in your phone's Settings, then try again.",
      ],
      ['services_off', 'Location is turned off on this phone. Turn it on and try again.'],
      ['timeout', 'Finding your location took too long. Move to an open area and try again.'],
      ['unavailable', 'Could not get your location. Please try again.'],
    ])('explains a %s location failure and asks nothing', async (code, message) => {
      locate.mockRejectedValue(new LocationError(code));
      signIn();
      await openHeadOffice();
      await fireEvent.press(button(USE));
      expect(await screen.findByText(message)).toBeOnTheScreen();
      expect(screen.queryByTestId('dialog')).toBeNull();
      expect(sent('PATCH')).toHaveLength(0);

      // A second try that works clears the message.
      locate.mockResolvedValue(HERE);
      await fireEvent.press(button(USE));
      await screen.findByTestId('dialog');
      expect(screen.queryByText(message)).toBeNull();
      await fireEvent.press(dialog().getByRole('button', { name: 'Cancel' }));
    });

    it('shows the server message with Retry when the branch cannot be loaded', async () => {
      let fail = true;
      signIn({ [ONE]: () => (fail ? failure(404, 'NOT_FOUND', 'Branch not found.') : one()) });
      await openBranches();
      await fireEvent.press(await screen.findByRole('button', { name: /^Head Office,/ }));
      expect(await screen.findByText('Branch not found.')).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: USE })).toBeNull();
      fail = false;
      await fireEvent.press(button('Retry'));
      expect(await screen.findByText('Centre (latitude, longitude)')).toBeOnTheScreen();
    });

    it('gives the location button a 48pt touch target', async () => {
      signIn();
      await openHeadOffice();
      expect(button(USE)).toHaveStyle({ minHeight: 48 });
      expect(button('Back')).toHaveStyle({ width: 48, height: 48 });
    });
  });

  describe('New branch here', () => {
    const created = () => {
      branches = [...branches, branchBody({ id: 9, name: 'Warehouse', address: 'Dock Road' })];
      return Response.json(branches.at(-1), { status: 201 });
    };

    it('keeps Save disabled until the location step has succeeded', async () => {
      signIn({ [CREATE]: created });
      await openNew();
      expect(button('Save branch').props.accessibilityState.disabled).toBe(true);
      await type('Branch name', 'Warehouse');
      await fireEvent.press(button('Save branch'));
      expect(sent('POST')).toHaveLength(0);

      await fireEvent.press(button(USE));
      expect(await screen.findByText('Location captured. Accuracy ±12 m')).toBeOnTheScreen();
      expect(button('Save branch').props.accessibilityState.disabled).toBe(false);
    });

    it('explains a location failure and keeps Save disabled', async () => {
      locate.mockRejectedValue(new LocationError('permission_denied'));
      signIn();
      await openNew();
      await fireEvent.press(button(USE));
      expect(await screen.findByText(/Allow location for WorkTrack/)).toBeOnTheScreen();
      expect(button('Save branch').props.accessibilityState.disabled).toBe(true);
    });

    it('creates the branch with every field and returns to the refreshed list', async () => {
      signIn({ [CREATE]: created });
      await openNew();
      await type('Branch name', '  Warehouse ');
      await type('Address (optional)', 'Dock Road');
      await type('Radius in metres (optional, 30 to 500)', '200');
      await fireEvent.press(button(USE));
      await screen.findByText('Location captured. Accuracy ±12 m');
      await fireEvent.press(button('Save branch'));

      expect(
        await screen.findByRole('button', { name: /^Warehouse, Dock Road/ }),
      ).toBeOnTheScreen();
      expect(sent('POST')).toHaveLength(1);
      expect(await bodyOf(sent('POST')[0])).toEqual({
        name: 'Warehouse',
        address: 'Dock Road',
        lat: HERE.lat,
        lng: HERE.lng,
        radius_m: 200,
      });
      expect(screen.queryByLabelText('Branch name')).toBeNull();
    });

    it('leaves the address and radius out when they are empty, so the server default applies', async () => {
      signIn({ [CREATE]: created });
      await openNew();
      await type('Branch name', 'Warehouse');
      await fireEvent.press(button(USE));
      await screen.findByText('Location captured. Accuracy ±12 m');
      await fireEvent.press(button('Save branch'));
      await screen.findByRole('button', { name: /^Warehouse,/ });
      expect(await bodyOf(sent('POST')[0])).toEqual({
        name: 'Warehouse',
        lat: HERE.lat,
        lng: HERE.lng,
      });
    });

    it.each([
      ['', '100', 'This field is required.'],
      [
        'Warehouse',
        '29',
        'Enter a whole number from 30 to 500, or leave it empty for the default.',
      ],
      [
        'Warehouse',
        '501',
        'Enter a whole number from 30 to 500, or leave it empty for the default.',
      ],
      [
        'Warehouse',
        '12.5',
        'Enter a whole number from 30 to 500, or leave it empty for the default.',
      ],
      ['W'.repeat(121), '', 'Use at most 120 characters.'],
    ])('refuses name "%s" with radius "%s" and sends nothing', async (name, radius, message) => {
      signIn({ [CREATE]: created });
      await openNew();
      await type('Branch name', name);
      await type('Radius in metres (optional, 30 to 500)', radius);
      await fireEvent.press(button(USE));
      await screen.findByText('Location captured. Accuracy ±12 m');
      await fireEvent.press(button('Save branch'));
      expect(await screen.findByText(message)).toBeOnTheScreen();
      expect(sent('POST')).toHaveLength(0);
    });

    it('puts a duplicate name next to the name field and stays on the form', async () => {
      signIn({
        [CREATE]: () => failure(409, 'DUPLICATE', 'A branch with that name already exists.'),
      });
      await openNew();
      await type('Branch name', 'Head Office');
      await fireEvent.press(button(USE));
      await screen.findByText('Location captured. Accuracy ±12 m');
      await fireEvent.press(button('Save branch'));
      const alert = await screen.findByRole('alert', {
        name: 'A branch with that name already exists.',
      });
      expect(alert).toBeOnTheScreen();
      expect(screen.getByLabelText('Branch name')).toBeOnTheScreen();
      // Still ready to save again once the name is changed.
      expect(button('Save branch').props.accessibilityState.disabled).toBe(false);
    });

    it('puts a field the server refused next to that field', async () => {
      signIn({
        [CREATE]: () =>
          Response.json(
            {
              error: {
                code: 'VALIDATION_ERROR',
                message: 'Request validation failed',
                details: [
                  {
                    loc: ['body', 'radius_m'],
                    message: 'Input should be less than or equal to 500',
                    type: 'less_than_equal',
                  },
                ],
              },
            },
            { status: 422 },
          ),
      });
      await openNew();
      await type('Branch name', 'Warehouse');
      await fireEvent.press(button(USE));
      await screen.findByText('Location captured. Accuracy ±12 m');
      await fireEvent.press(button('Save branch'));
      expect(
        await screen.findByText('Input should be less than or equal to 500'),
      ).toBeOnTheScreen();
      expect(screen.queryByText('Request validation failed')).toBeNull();
    });

    it('shows any other refusal as a message on the form', async () => {
      signIn({ [CREATE]: () => failure(403, 'FORBIDDEN', 'You may not manage branches.') });
      await openNew();
      await type('Branch name', 'Warehouse');
      await fireEvent.press(button(USE));
      await screen.findByText('Location captured. Accuracy ±12 m');
      await fireEvent.press(button('Save branch'));
      expect(await screen.findByText('You may not manage branches.')).toBeOnTheScreen();
      expect(screen.getByLabelText('Branch name')).toBeOnTheScreen();
    });

    it('gives every button a 48pt touch target', async () => {
      signIn();
      await openBranches();
      expect(button('New branch here')).toHaveStyle({ minHeight: 48 });
      await fireEvent.press(button('New branch here'));
      await screen.findByLabelText('Branch name');
      for (const name of [USE, 'Save branch']) {
        expect(button(name)).toHaveStyle({ minHeight: 48 });
      }
    });
  });
});
