import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as Device from 'expo-device';
import { FACE_KEY, FaceEnrollmentCard } from '@/components/face-enrollment-card';
import { PunchCard } from '@/components/punch-card';
import { LocationError, getCurrentFix } from '@/lib/location';
import { currentFlow, endFlow } from '@/lib/punch-flow';
import {
  calls,
  dayBody,
  errorBody,
  failure,
  mockApi,
  precheckBody,
  punchBody,
  todayBody,
} from '@/test/fake-api';
import { renderWithTheme } from '@/test/render';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
const mockFocus: { effect: (() => void) | null } = { effect: null };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useFocusEffect: (effect: () => void) => {
    mockFocus.effect = effect;
  },
}));
jest.mock('@/lib/location', () => ({
  ...jest.requireActual('@/lib/location'),
  getCurrentFix: jest.fn(),
}));

const locate = jest.mocked(getCurrentFix);
const FIX = { lat: 20.2961, lng: 85.8245, accuracyM: 12.5, mocked: false };
const TODAY = 'GET /api/v1/attendance/today';
const PRECHECK = 'POST /api/v1/attendance/precheck';
const today =
  (over: Parameters<typeof todayBody>[0] = {}) =>
  () =>
    Response.json(todayBody(over));
const tap = (name: string) => fireEvent.press(screen.getByRole('button', { name }));

beforeEach(() => {
  jest.clearAllMocks();
  endFlow();
  locate.mockResolvedValue(FIX);
  jest.mocked(Device.isRootedExperimentalAsync).mockResolvedValue(false);
  (Device as { isDevice: boolean }).isDevice = true;
});

describe('PunchCard states', () => {
  it('shows the server clock in IST, the shift, and Punch in before the first punch', async () => {
    mockApi({ [TODAY]: today() });
    await renderWithTheme(<PunchCard />);
    expect(await screen.findByRole('button', { name: 'Punch in' })).toBeEnabled();
    // The server said 04:30 UTC: 10:00 IST, whatever the phone's own clock says.
    expect(screen.getByTestId('server-clock')).toHaveTextContent(/^10:00:0\d am$/);
    expect(screen.getByText('General, 09:00 to 18:00')).toBeOnTheScreen();
    expect(screen.getByTestId('punch-status')).toHaveTextContent('Not punched in yet');
  });

  it('shows Punch out, the status, the hours so far and the punches already made', async () => {
    mockApi({
      [TODAY]: today({
        action: 'punch_out',
        day: dayBody({ status: 'working' }),
        punches: [punchBody()],
        minutes_so_far: 192,
      }),
    });
    await renderWithTheme(<PunchCard />);
    expect(await screen.findByRole('button', { name: 'Punch out' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Punch in' })).toBeNull();
    expect(screen.getByTestId('punch-status')).toHaveTextContent('Working');
    expect(screen.getByTestId('punch-hours')).toHaveTextContent('Worked so far: 3 h 12 min');
    expect(screen.getByText('Punch in 9:05 am')).toBeOnTheScreen();
  });

  it('marks a punch that is waiting for review', async () => {
    mockApi({
      [TODAY]: today({
        action: 'punch_out',
        punches: [punchBody({ in_review: true, review_status: 'pending' })],
      }),
    });
    await renderWithTheme(<PunchCard />);
    expect(await screen.findByText('Punch in 9:05 am (under review)')).toBeOnTheScreen();
  });

  it.each([
    ['off_day', 'Today is not a working day for you.'],
    ['no_shift', 'No shift is assigned to you. Ask your admin.'],
    ['face_not_approved', 'Your face is not approved yet, so you cannot punch.'],
    ['day_closed', "Today's attendance is closed."],
    ['request_pending', 'Your punch-out request is waiting for approval.'],
  ])('disables the button and says why when the day is blocked (%s)', async (blocked, text) => {
    mockApi({ [TODAY]: today({ action: 'none', blocked }) });
    await renderWithTheme(<PunchCard />);
    expect(await screen.findByText(text)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Punch in' })).toBeDisabled();
  });

  it('shows no button at all when the day is done', async () => {
    mockApi({
      [TODAY]: today({
        action: 'none',
        blocked: 'done',
        day: dayBody({ status: 'present', worked_minutes: 480 }),
      }),
    });
    await renderWithTheme(<PunchCard />);
    expect(await screen.findByText('You are done for today.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /Punch/ })).toBeNull();
    expect(screen.getByTestId('punch-status')).toHaveTextContent('Present');
    expect(screen.getByTestId('punch-hours')).toHaveTextContent('Worked today: 8 h 0 min');
  });

  it('offers face setup when the face is not approved, and goes to the right step', async () => {
    mockApi({
      [TODAY]: today({ action: 'none', blocked: 'face_not_approved' }),
      'GET /api/v1/me/face-enrollment': () => Response.json({ status: 'consented' }),
    });
    await renderWithTheme(<PunchCard />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Go to face setup' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/face/capture');
  });

  it('offers no face setup while the enrollment waits for approval', async () => {
    mockApi({
      [TODAY]: today({ action: 'none', blocked: 'face_not_approved' }),
      'GET /api/v1/me/face-enrollment': () => Response.json({ status: 'pending' }),
    });
    await renderWithTheme(<PunchCard />);
    await screen.findByText('Your face is not approved yet, so you cannot punch.');
    expect(screen.queryByRole('button', { name: 'Go to face setup' })).toBeNull();
  });

  it('says why it failed, with Retry, when today cannot be loaded', async () => {
    let up = false;
    mockApi({
      [TODAY]: () =>
        up ? Response.json(todayBody()) : failure(500, 'INTERNAL', 'The database is down.'),
    });
    await renderWithTheme(<PunchCard />);
    expect(await screen.findByText('The database is down.')).toBeOnTheScreen();
    up = true;
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Punch in' })).toBeOnTheScreen();
  });

  it('asks again each time Home comes back into view, but not for the first showing', async () => {
    mockApi({ [TODAY]: today() });
    await renderWithTheme(<PunchCard />);
    await screen.findByRole('button', { name: 'Punch in' });
    const asked = () => calls.filter((call) => call.url.endsWith('/attendance/today')).length;
    expect(asked()).toBe(1);

    await act(async () => mockFocus.effect?.()); // the first focus: the mount fetch covers it
    expect(asked()).toBe(1);
    await act(async () => mockFocus.effect?.()); // coming back
    await waitFor(() => expect(asked()).toBe(2));
  });
});

describe('PunchCard tap flow', () => {
  it('checks the position with the server, then opens the camera with what the phone reported', async () => {
    mockApi({ [TODAY]: today(), [PRECHECK]: () => Response.json(precheckBody()) });
    await renderWithTheme(<PunchCard />);
    await tap('Punch in');

    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/punch/capture'));
    expect(await calls.find((c) => c.url.endsWith('/precheck'))?.json()).toEqual({
      lat: 20.2961,
      lng: 85.8245,
      accuracy_m: 12.5,
    });
    expect(currentFlow()).toMatchObject({
      kind: 'in',
      fix: FIX,
      integrity: { emulator: false, rooted: false },
    });
  });

  it('carries the mock, emulator and root flags to the server unchanged, and decides nothing itself', async () => {
    locate.mockResolvedValue({ ...FIX, mocked: true });
    jest.mocked(Device.isRootedExperimentalAsync).mockResolvedValue(true);
    (Device as { isDevice: boolean }).isDevice = false;
    mockApi({
      [TODAY]: today({ action: 'punch_out' }),
      [PRECHECK]: () => Response.json(precheckBody({ action: 'punch_out' })),
    });
    await renderWithTheme(<PunchCard />);
    await tap('Punch out');
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/punch/capture'));
    expect(currentFlow()).toMatchObject({
      kind: 'out',
      fix: { mocked: true },
      integrity: { emulator: true, rooted: true },
    });
  });

  it('shows how far away the branch is, with the server message, and stops when the server refuses', async () => {
    mockApi({
      [TODAY]: today(),
      [PRECHECK]: () =>
        Response.json(
          precheckBody({
            allowed: false,
            nearest_branch: 'Head Office',
            distance_m: 340,
            place: null,
            code: 'OUTSIDE_GEOFENCE',
            message: 'You are outside the allowed area for punching in.',
          }),
        ),
    });
    await renderWithTheme(<PunchCard />);
    await tap('Punch in');
    expect(await screen.findByText('You are 340 m away from Head Office.')).toBeOnTheScreen();
    expect(screen.getByText('You are outside the allowed area for punching in.')).toBeOnTheScreen();
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(currentFlow()).toBeNull();
  });

  it('offers a punch-out request when the server says the position is away from work', async () => {
    mockApi({
      [TODAY]: today({ action: 'punch_out' }),
      [PRECHECK]: () =>
        Response.json(
          precheckBody({
            allowed: true,
            action: 'request_punch_out',
            place: { type: 'outside', branch: 'Head Office', distance_m: 340 },
            nearest_branch: 'Head Office',
            distance_m: 340,
          }),
        ),
    });
    await renderWithTheme(<PunchCard />);
    await tap('Punch out');
    expect(await screen.findByText('You are 340 m away from Head Office.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Punch out' })).toBeNull();
    expect(mockRouter.push).not.toHaveBeenCalled();

    await tap('Request punch out');
    expect(mockRouter.push).toHaveBeenCalledWith('/punch/request');
    expect(currentFlow()).toMatchObject({ kind: 'request' });
  });

  it.each([
    ['permission_denied', /may not use your location/],
    ['services_off', /Location is turned off/],
    ['timeout', /took too long/],
    ['unavailable', /Could not get your location/],
  ] as const)('says %s in words, and makes no precheck', async (code, message) => {
    locate.mockRejectedValue(new LocationError(code));
    mockApi({ [TODAY]: today() });
    await renderWithTheme(<PunchCard />);
    await tap('Punch in');
    expect(await screen.findByText(message)).toBeOnTheScreen();
    expect(calls.some((call) => call.url.endsWith('/precheck'))).toBe(false);
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('goes on to the camera without a connection, and lets the server check the position later', async () => {
    mockApi({
      [TODAY]: today(),
      [PRECHECK]: () => {
        throw new TypeError('Network request failed');
      },
    });
    await renderWithTheme(<PunchCard />);
    await tap('Punch in');
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/punch/capture'));
    expect(currentFlow()).toMatchObject({ kind: 'in', fix: FIX });
  });

  it('shows the real reason when the precheck itself fails on the server', async () => {
    mockApi({
      [TODAY]: today(),
      [PRECHECK]: () => errorBody('DEVICE_NOT_APPROVED', null, 403),
    });
    await renderWithTheme(<PunchCard />);
    await tap('Punch in');
    expect(
      await screen.findByText('This phone is not approved yet. Ask your admin.'),
    ).toBeOnTheScreen();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });
});

describe('PunchCard and the Face card share one enrollment query', () => {
  it('invalidating it after the consent step still fetches it (no skipToken error)', async () => {
    mockApi({
      [TODAY]: today(),
      [PRECHECK]: () => Response.json(precheckBody()),
      'GET /api/v1/me/face-enrollment': () => Response.json({ status: 'consented' }),
    });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = await renderWithTheme(
      <>
        <PunchCard />
        <FaceEnrollmentCard />
      </>,
    );
    await screen.findByRole('button', { name: 'Punch in' });
    // Pressing the button re-renders only the Punch card (busy state). It renders after the
    // Face card, so whatever options it registered on the shared query are the ones that stay.
    await tap('Punch in');
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalled());
    await client.invalidateQueries({ queryKey: FACE_KEY });
    expect(spy.mock.calls.flat().join(' ')).not.toMatch(/skipToken|Missing queryFn/);
    expect(client.getQueryState(FACE_KEY)?.status).toBe('success');
    spy.mockRestore();
  });
});
