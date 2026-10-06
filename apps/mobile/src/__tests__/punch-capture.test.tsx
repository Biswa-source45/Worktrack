import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import PunchCaptureScreen from '@/app/punch/capture';
import { getStore } from '@/lib/punch-queue';
import { currentOutcome, endFlow, startFlow } from '@/lib/punch-flow';
import type { Flow } from '@/lib/punch-flow';
import { setTokens } from '@/lib/token-store';
import { calls, failure, meBody, mockApi, punchResultBody, recordForms } from '@/test/fake-api';
import { resetMemoryStore } from '@/test/memory-queue-store';
import { renderWithAuth } from '@/test/render';
import { resetSecureStore } from '@/test/secure-store-mock';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

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

const IN = 'POST /api/v1/attendance/punch-in';
const OUT = 'POST /api/v1/attendance/punch-out';
const REQUEST = 'POST /api/v1/attendance/punch-out-requests';
const FIX = { lat: 20.2961, lng: 85.8245, accuracyM: 12.5, mocked: false };
const flow = (over: Partial<Flow> = {}): Flow => ({
  kind: 'in',
  fix: FIX,
  integrity: { emulator: false, rooted: false },
  ...over,
});
const created = () => Response.json(punchResultBody(), { status: 201 });
const take = () => fireEvent.press(screen.getByRole('button', { name: 'Take selfie' }));

/** A selfie in the phone cache, as the camera leaves it. */
function selfie(name: string) {
  const file = new File(Paths.cache, name);
  file.create({ overwrite: true });
  file.write(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]));
  mockCamera.uri = file.uri;
  return file;
}

// Lets the sign-in state finish loading, for the tests that have no camera to wait for.
const settled = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

async function open() {
  await renderWithAuth(<PunchCaptureScreen />);
  await screen.findByRole('button', { name: 'Take selfie' });
}

let forms: ReturnType<typeof recordForms>;
let warn: jest.SpyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  mockCamera.available = true;
  resetMemoryStore();
  resetSecureStore();
  endFlow();
  await setTokens({ access: 'access-1', refresh: 'refresh-1' });
  forms = recordForms();
  // The screen logs a send failure for the developer; the tests read it from the screen instead.
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  forms.restore();
  warn.mockRestore();
});

const base = { 'GET /api/v1/me': () => Response.json(meBody()) };

describe('PunchCaptureScreen', () => {
  it('says it needs the development build, and starts no camera, in Expo Go', async () => {
    mockCamera.available = false;
    mockApi(base);
    startFlow(flow());
    await renderWithAuth(<PunchCaptureScreen />);
    await settled();
    expect(screen.getByRole('header', { name: 'Needs the development build' })).toBeOnTheScreen();
    expect(screen.getByText(/to punch\./)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Take selfie' })).toBeNull();
  });

  it('goes back to Home when no punch is in progress', async () => {
    mockApi(base);
    await renderWithAuth(<PunchCaptureScreen />);
    await settled();
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'));
  });

  it('opens the single-selfie camera, not the enrollment steps', async () => {
    mockApi(base);
    startFlow(flow());
    await open();
    expect(screen.getByText('single selfie camera')).toBeOnTheScreen();
  });

  it('sends the selfie with every field and flag, then shows the result and deletes the selfie', async () => {
    mockApi({ ...base, [IN]: created });
    startFlow(flow({ fix: { ...FIX, mocked: true }, integrity: { emulator: true, rooted: true } }));
    jest.mocked(Crypto.randomUUID).mockReturnValueOnce('aaaaaaaa-0000-4000-8000-000000000001');
    const file = selfie('capture-ok.jpg');
    await open();
    await take();

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/punch/result'));
    const sent = calls.find((call) => call.url.endsWith('/punch-in'));
    expect(sent?.headers.get('Idempotency-Key')).toBe('aaaaaaaa-0000-4000-8000-000000000001');
    expect(forms.parts[0]).toEqual(['selfie', expect.anything()]);
    expect(forms.fields()).toMatchObject({
      lat: '20.2961',
      lng: '85.8245',
      accuracy_m: '12.5',
      mocked: 'true',
      emulator: 'true',
      rooted: 'true',
      offline: 'false',
    });
    // The time the photo was taken, on the phone's clock, for the audit.
    expect(new Date(forms.fields().device_time as string).getTime()).toBeLessThan(
      Date.now() + 1000,
    );
    expect(currentOutcome()).toMatchObject({
      type: 'sent',
      kind: 'in',
      result: { result: 'verified' },
    });
    expect(file.exists).toBe(false);
  });

  it('sends a punch-out to its own endpoint', async () => {
    mockApi({ ...base, [OUT]: created });
    startFlow(flow({ kind: 'out' }));
    selfie('capture-out.jpg');
    await open();
    await take();
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/punch/result'));
    expect(calls.some((call) => call.url.endsWith('/punch-out'))).toBe(true);
  });

  it('sends a punch-out request with its reason and note', async () => {
    mockApi({ ...base, [REQUEST]: created });
    startFlow(flow({ kind: 'request', reason: 'Client site', note: 'Back by 5' }));
    selfie('capture-request.jpg');
    await open();
    await take();
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/punch/result'));
    expect(forms.fields()).toMatchObject({ reason: 'Client site', note: 'Back by 5' });
  });

  it('shows a punch the server refused on the result screen, and deletes the selfie', async () => {
    mockApi({
      ...base,
      [IN]: () => failure(422, 'MOCK_LOCATION', 'A mock location was detected.'),
    });
    startFlow(flow());
    const file = selfie('capture-refused.jpg');
    await open();
    await take();
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/punch/result'));
    expect(currentOutcome()).toMatchObject({
      type: 'rejected',
      error: { code: 'MOCK_LOCATION', message: 'A mock location was detected.' },
    });
    expect(file.exists).toBe(false);
  });

  it('saves the punch on the phone when the connection is lost, with the same key, and deletes the selfie', async () => {
    mockApi({
      ...base,
      [IN]: () => {
        throw new TypeError('Network request failed');
      },
    });
    startFlow(flow());
    jest.mocked(Crypto.randomUUID).mockReturnValueOnce('bbbbbbbb-0000-4000-8000-000000000002');
    const file = selfie('capture-offline.jpg');
    await open();
    await take();

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/punch/result'));
    expect(currentOutcome()).toEqual({ type: 'queued', kind: 'in' });
    expect(await (await getStore()).list(1)).toEqual([
      expect.objectContaining({ id: 'bbbbbbbb-0000-4000-8000-000000000002', status: 'queued' }),
    ]);
    expect(file.exists).toBe(false);
  });

  it('keeps the selfie and the key after a server failure, so Try again is the same punch', async () => {
    let up = false;
    mockApi({
      ...base,
      [IN]: () => (up ? created() : failure(503, 'UNAVAILABLE', 'The server is busy.')),
    });
    startFlow(flow());
    jest.mocked(Crypto.randomUUID).mockReturnValueOnce('cccccccc-0000-4000-8000-000000000003');
    const file = selfie('capture-retry.jpg');
    await open();
    await take();

    expect(await screen.findByText('The server is busy.')).toBeOnTheScreen();
    expect(screen.getByText('503 UNAVAILABLE')).toBeOnTheScreen();
    expect(file.exists).toBe(true);
    expect(mockRouter.replace).not.toHaveBeenCalled();

    up = true;
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/punch/result'));
    const keys = calls
      .filter((c) => c.url.endsWith('/punch-in'))
      .map((c) => c.headers.get('Idempotency-Key'));
    expect(keys).toEqual([
      'cccccccc-0000-4000-8000-000000000003',
      'cccccccc-0000-4000-8000-000000000003',
    ]);
    expect(file.exists).toBe(false);
  });

  it('shows the error name for a failure that is neither the network nor the server', async () => {
    mockApi({
      ...base,
      [IN]: () => {
        throw new RangeError('request body too large');
      },
      'GET /health': () => Response.json({ status: 'ok' }),
    });
    startFlow(flow());
    selfie('capture-odd.jpg');
    await open();
    await take();
    expect(await screen.findByText('Something went wrong. Please try again.')).toBeOnTheScreen();
    expect(screen.getByText('RangeError: request body too large')).toBeOnTheScreen();
  });

  it('takes a new selfie with a new key, and deletes the old selfie, when asked', async () => {
    mockApi({ ...base, [IN]: () => failure(500, 'INTERNAL', 'The server failed.') });
    startFlow(flow());
    jest.mocked(Crypto.randomUUID).mockReturnValueOnce('dddddddd-0000-4000-8000-000000000004');
    const first = selfie('capture-first.jpg');
    await open();
    await take();
    await screen.findByText('The server failed.');

    await fireEvent.press(screen.getByRole('button', { name: 'Take a new selfie' }));
    expect(first.exists).toBe(false);
    expect(await screen.findByText('single selfie camera')).toBeOnTheScreen();

    jest.mocked(Crypto.randomUUID).mockReturnValueOnce('eeeeeeee-0000-4000-8000-000000000005');
    selfie('capture-second.jpg');
    await take();
    await screen.findByText('The server failed.');
    const keys = calls
      .filter((c) => c.url.endsWith('/punch-in'))
      .map((c) => c.headers.get('Idempotency-Key'));
    expect(keys).toEqual([
      'dddddddd-0000-4000-8000-000000000004',
      'eeeeeeee-0000-4000-8000-000000000005',
    ]);
  });

  it('deletes a selfie that was never sent when the screen is left', async () => {
    mockApi({ ...base, [IN]: () => failure(500, 'INTERNAL', 'The server failed.') });
    startFlow(flow());
    const file = selfie('capture-left.jpg');
    await open();
    await take();
    await screen.findByText('The server failed.');
    expect(file.exists).toBe(true);
    await act(async () => screen.unmount());
    expect(file.exists).toBe(false);
  });
});
