import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import ReachScreen from '@/app/tasks/[id]/reach';
import { getStore } from '@/lib/punch-queue';
import { currentReach, endReach, startReach } from '@/lib/task-flow';
import { setTokens } from '@/lib/token-store';
import { calls, failure, meBody, mockApi, recordForms, taskDetailBody } from '@/test/fake-api';
import { resetMemoryStore } from '@/test/memory-queue-store';
import { renderWithAuth } from '@/test/render';
import { resetSecureStore } from '@/test/secure-store-mock';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useFocusEffect: jest.fn(),
  useLocalSearchParams: () => ({ id: '41' }),
}));

const mockCamera = { available: true, uri: '' };
jest.mock('@/lib/camera', () => ({
  get cameraAvailable() {
    return mockCamera.available;
  },
}));

// There is no camera in Jest: this stands in for the native one, in its single-selfie mode.
jest.mock('@/components/face-camera', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    __esModule: true,
    default: ({
      single,
      onPhoto,
    }: {
      single?: boolean;
      onPhoto: (uri: string, turn: number) => void;
    }) =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Text, null, single ? 'single selfie camera' : 'enrollment camera'),
        React.createElement(Pressable, {
          accessibilityRole: 'button',
          accessibilityLabel: 'Take selfie',
          onPress: () => onPhoto(mockCamera.uri, 0),
        }),
      ),
  };
});

const ME = 'GET /api/v1/me';
const REACHED = 'POST /api/v1/tasks/41/reached';
const FIX = { lat: 20.3547, lng: 85.8197, accuracyM: 9.5, mocked: false };
const base = { [ME]: () => Response.json(meBody()) };
const take = () => fireEvent.press(screen.getByRole('button', { name: 'Take selfie' }));
const tap = (name: string) => fireEvent.press(screen.getByRole('button', { name }));

const REACH = {
  at: '2026-10-06T05:00:00Z',
  distance_m: 20,
  flags: [] as ('location_mismatch' | 'face_review' | 'impossible_jump')[],
  reason: null,
  review: 'none' as 'none' | 'pending' | 'approved' | 'rejected',
  review_remarks: null,
  reviewed_by: null,
  reviewed_at: null,
};
const reached =
  (over: Partial<typeof REACH> = {}) =>
  () =>
    Response.json({
      task: taskDetailBody({}, 'reached', { ...REACH, ...over }),
      replayed: false,
    });

/** A selfie in the phone cache, as the camera leaves it. */
function selfie(name: string) {
  const file = new File(Paths.cache, name);
  file.create({ overwrite: true });
  file.write(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]));
  mockCamera.uri = file.uri;
  return file;
}

async function open(routes: Parameters<typeof mockApi>[0] = {}) {
  mockApi({ ...base, ...routes });
  startReach({ taskId: 41, fix: FIX, integrity: { emulator: false, rooted: false } });
  await renderWithAuth(<ReachScreen />);
  await screen.findByRole('button', { name: 'Take selfie' });
}

let forms: ReturnType<typeof recordForms>;
let warn: jest.SpyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  mockCamera.available = true;
  resetMemoryStore();
  resetSecureStore();
  endReach();
  await setTokens({ access: 'access-1', refresh: 'refresh-1' });
  forms = recordForms();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  forms.restore();
  warn.mockRestore();
});

describe('I have reached: the selfie screen', () => {
  it('says it needs the development build, and starts no camera, in Expo Go', async () => {
    mockCamera.available = false;
    mockApi(base);
    startReach({ taskId: 41, fix: FIX, integrity: { emulator: false, rooted: false } });
    await renderWithAuth(<ReachScreen />);
    expect(screen.getByRole('header', { name: 'Needs the development build' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Take selfie' })).toBeNull();
  });

  it('goes back to the task when no Reached is in progress', async () => {
    mockApi(base);
    await renderWithAuth(<ReachScreen />);
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/tasks/41'));
  });

  it('sends the selfie with the position, the phone checks and a key, then confirms and deletes the selfie', async () => {
    const file = selfie('reach-ok.jpg');
    await open({ [REACHED]: reached() });
    await take();

    expect(await screen.findByText('Your arrival is recorded.')).toBeOnTheScreen();
    const sent = calls.find((call) => call.url.endsWith('/tasks/41/reached'));
    expect(sent?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(forms.parts.find(([name]) => name === 'selfie')?.[1]).toBeInstanceOf(File);
    expect(forms.fields()).toMatchObject({
      lat: '20.3547',
      lng: '85.8197',
      accuracy_m: '9.5',
      mocked: 'false',
      emulator: 'false',
      rooted: 'false',
      offline: 'false',
    });
    expect(forms.fields()).not.toHaveProperty('mismatch_reason');
    expect(new Date(forms.fields().device_time as string).getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
    await waitFor(() => expect(file.exists).toBe(false));

    await tap('Back to the task');
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('says the arrival was sent for review when the server flagged it, with no score and no mismatch wording', async () => {
    selfie('reach-flag.jpg');
    await open({ [REACHED]: reached({ flags: ['face_review'], review: 'pending' }) });
    await take();
    expect(
      await screen.findByText(
        'Your arrival is recorded and sent for review. You can carry on with the task.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/mismatch|score/i)).toBeNull();
  });

  it('shows the distance when outside the site, asks for a reason, and resends the held selfie with it', async () => {
    const file = selfie('reach-outside.jpg');
    jest
      .mocked(Crypto.randomUUID)
      .mockReturnValueOnce('aaaaaaaa-0000-4000-8000-000000000001')
      .mockReturnValueOnce('aaaaaaaa-0000-4000-8000-000000000002');
    let attempt = 0;
    await open({
      [REACHED]: () => {
        attempt += 1;
        // The error body carries the numbers the screen shows.
        return attempt === 1
          ? Response.json(
              {
                error: {
                  code: 'OUTSIDE_SITE',
                  message: 'You are outside the site.',
                  details: { distance_m: 340.4, radius_m: 200 },
                },
              },
              { status: 422 },
            )
          : reached({ distance_m: 340, flags: ['location_mismatch'], review: 'pending' })();
      },
    });
    await take();

    expect(
      await screen.findByText('You are 340 m from the site. It must be within 200 m.'),
    ).toBeOnTheScreen();
    expect(file.exists).toBe(true); // held for the resend

    // A reason is needed first.
    await tap('Submit with this reason');
    expect(await screen.findByText('Give a reason of at least 3 characters.')).toBeOnTheScreen();
    expect(calls.filter((call) => call.url.endsWith('/reached'))).toHaveLength(1);

    forms.parts.length = 0;
    await fireEvent.changeText(
      screen.getByLabelText('Why is the position different?'),
      'GPS drifts here',
    );
    await tap('Submit with this reason');

    expect(
      await screen.findByText(
        'Your arrival is recorded and sent for review. You can carry on with the task.',
      ),
    ).toBeOnTheScreen();
    expect(forms.parts.find(([name]) => name === 'selfie')?.[1]).toBeInstanceOf(File);
    expect(forms.fields()).toMatchObject({ mismatch_reason: 'GPS drifts here', lat: '20.3547' });
    const keys = calls.map((call) => call.headers.get('Idempotency-Key')).filter(Boolean);
    // Another content, another key.
    expect(keys).toEqual([
      'aaaaaaaa-0000-4000-8000-000000000001',
      'aaaaaaaa-0000-4000-8000-000000000002',
    ]);
    await waitFor(() => expect(file.exists).toBe(false));
  });

  it('asks for another selfie when the server cannot use the photo, and deletes the old one', async () => {
    const file = selfie('reach-retake.jpg');
    await open({
      [REACHED]: () => failure(422, 'FACE_RETAKE', 'Look straight at the camera.'),
    });
    await take();
    expect(await screen.findByText('Look straight at the camera.')).toBeOnTheScreen();
    expect(screen.getByText('422 FACE_RETAKE')).toBeOnTheScreen();
    await waitFor(() => expect(file.exists).toBe(false));
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();

    await tap('Take it again');
    expect(await screen.findByRole('button', { name: 'Take selfie' })).toBeOnTheScreen();
  });

  it('shows the real reason and code for a refusal that retaking cannot fix, and deletes the selfie', async () => {
    const file = selfie('reach-mock.jpg');
    await open({
      [REACHED]: () => failure(403, 'MOCK_LOCATION', 'A mock location was detected.'),
    });
    await take();
    expect(await screen.findByText('A mock location was detected.')).toBeOnTheScreen();
    expect(screen.getByText('403 MOCK_LOCATION')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Take it again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await waitFor(() => expect(file.exists).toBe(false));
  });

  it('keeps the selfie after a server error, and Try again is the same send under the same key', async () => {
    const file = selfie('reach-5xx.jpg');
    jest
      .mocked(Crypto.randomUUID)
      .mockReturnValueOnce('bbbbbbbb-0000-4000-8000-000000000001')
      .mockReturnValueOnce('bbbbbbbb-0000-4000-8000-000000000002');
    let first = true;
    await open({
      [REACHED]: () => {
        if (first) {
          first = false;
          return failure(503, 'HTTP_503', 'The server is busy.');
        }
        return reached()();
      },
    });
    await take();
    expect(await screen.findByText('The server is busy.')).toBeOnTheScreen();
    expect(file.exists).toBe(true);
    await tap('Try again');
    expect(await screen.findByText('Your arrival is recorded.')).toBeOnTheScreen();

    const keys = calls
      .filter((call) => call.url.endsWith('/tasks/41/reached'))
      .map((call) => call.headers.get('Idempotency-Key'));
    expect(keys).toEqual([
      'bbbbbbbb-0000-4000-8000-000000000001',
      'bbbbbbbb-0000-4000-8000-000000000001',
    ]);
  });

  it('shows progress while the send is slow', async () => {
    selfie('reach-slow.jpg');
    let release: (response: Response) => void = () => undefined;
    await open({ [REACHED]: () => new Promise<Response>((resolve) => (release = resolve)) });
    await take();
    expect(await screen.findByText('Sending your selfie and position...')).toBeOnTheScreen();
    expect(
      screen.getByText('Sending. This can take a moment on a slow connection.'),
    ).toBeOnTheScreen();
    release(reached()());
    expect(await screen.findByText('Your arrival is recorded.')).toBeOnTheScreen();
  });

  it('saves the Reached on the phone as an offline one when there is no connection', async () => {
    const file = selfie('reach-offline.jpg');
    await open({
      [REACHED]: () => {
        throw new TypeError('Network request failed');
      },
      'GET /health': () => {
        throw new TypeError('Network request failed');
      },
    });
    await take();
    expect(
      await screen.findByText('Saved on this phone. It will be sent when you are back online.'),
    ).toBeOnTheScreen();
    expect(await (await getStore()).list(1)).toEqual([
      expect.objectContaining({ kind: 'task_reached', status: 'queued' }),
    ]);
    await waitFor(() => expect(file.exists).toBe(false));
  });

  it('deletes a selfie that is still held and clears the position when the screen is left', async () => {
    const file = selfie('reach-left.jpg');
    let release: (response: Response) => void = () => undefined;
    await open({ [REACHED]: () => new Promise<Response>((resolve) => (release = resolve)) });
    await take();
    await screen.findByText('Sending your selfie and position...');
    expect(file.exists).toBe(true);
    expect(currentReach()).not.toBeNull();
    await screen.unmount();
    expect(file.exists).toBe(false);
    expect(currentReach()).toBeNull();
    release(reached()()); // lets the request finish, so no timer is left running
  });

  it('explains a gateway page that is not the server error format', async () => {
    selfie('reach-gateway.jpg');
    await open({ [REACHED]: () => new Response('Bad gateway', { status: 502 }) });
    await take();
    expect(
      await screen.findByText('The server answered with an error (502). Please try again.'),
    ).toBeOnTheScreen();
    expect(screen.getByText('502 HTTP_502')).toBeOnTheScreen();
  });
});
