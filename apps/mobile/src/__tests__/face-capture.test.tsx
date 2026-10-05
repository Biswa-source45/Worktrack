import { fireEvent, screen } from '@testing-library/react-native';
import FaceCaptureScreen from '@/app/face/capture';
import { calls, errorBody, mockApi } from '@/test/fake-api';
import { renderWithTheme } from '@/test/render';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const mockCamera = { available: true };
jest.mock('@/lib/camera', () => ({
  get cameraAvailable() {
    return mockCamera.available;
  },
}));

// There is no camera in Jest: this stands in for the native one. Photo 2 (step 1) reports a head
// turn of +1, the way the real camera does when it takes the turned photo.
jest.mock('@/components/face-camera', () => {
  // A jest.mock factory cannot use imports from the file; it runs before them.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    __esModule: true,
    default: ({
      step,
      firstTurn,
      onPhoto,
    }: {
      step: number;
      firstTurn: number;
      onPhoto: (uri: string, turn: number) => void;
    }) =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Text, null, `camera step ${step + 1} turn ${firstTurn}`),
        React.createElement(Pressable, {
          accessibilityRole: 'button',
          accessibilityLabel: 'Take photo',
          onPress: () => onPhoto(`file:///photo-${step + 1}.jpg`, step === 1 ? 1 : 0),
        }),
      ),
  };
});

const SEND = 'POST /api/v1/me/face-enrollment';
const CONSENT_FLOW = 'GET /api/v1/me/face-enrollment';
const enrolled = () =>
  Response.json({ status: 'pending', submitted_at: '2026-02-01T04:31:00Z' }, { status: 201 });
const posts = () => calls.filter((c) => c.method === 'POST');
const take = () => fireEvent.press(screen.getByRole('button', { name: 'Take photo' }));

async function takeAll() {
  for (let n = 1; n <= 3; n++) {
    await screen.findByText(new RegExp(`camera step ${n}`));
    await take();
  }
  await screen.findByRole('header', { name: 'Check your photos' });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCamera.available = true;
});

describe('FaceCaptureScreen', () => {
  it('says it needs the development build, and starts no camera, in Expo Go', async () => {
    mockCamera.available = false;
    mockApi({});
    await renderWithTheme(<FaceCaptureScreen />);
    expect(screen.getByRole('header', { name: 'Needs the development build' })).toBeOnTheScreen();
    expect(screen.getByText(/camera is not available in Expo Go/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Take photo' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Back' })); // the arrow
    expect(mockRouter.back).toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('takes the three photos in order, shows them for a check, and sends them together', async () => {
    mockApi({ [SEND]: enrolled, [CONSENT_FLOW]: () => Response.json({ status: 'pending' }) });
    await renderWithTheme(<FaceCaptureScreen />);
    await takeAll();
    expect(screen.getAllByRole('button', { name: /Retake photo/ })).toHaveLength(3);
    expect(posts()).toHaveLength(0);

    await fireEvent.press(screen.getByRole('button', { name: 'Send photos' }));
    expect(await screen.findByText(/Photos sent\. An admin will review them/)).toBeOnTheScreen();
    expect(posts()).toHaveLength(1);
    expect(posts()[0].url).toContain('/api/v1/me/face-enrollment');
    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
  });

  it('remembers which way the head was turned so the last photo asks for the other side', async () => {
    mockApi({});
    await renderWithTheme(<FaceCaptureScreen />);
    expect(await screen.findByText('camera step 1 turn 0')).toBeOnTheScreen();
    await take();
    expect(await screen.findByText('camera step 2 turn 0')).toBeOnTheScreen();
    await take();
    expect(await screen.findByText('camera step 3 turn 1')).toBeOnTheScreen();
  });

  it('retakes one photo and keeps the other two', async () => {
    mockApi({});
    await renderWithTheme(<FaceCaptureScreen />);
    await takeAll();
    await fireEvent.press(screen.getByRole('button', { name: 'Retake photo 2' }));
    expect(await screen.findByText(/camera step 2/)).toBeOnTheScreen();
    await take();
    await screen.findByRole('header', { name: 'Check your photos' });
    expect(screen.getAllByRole('button', { name: /Retake photo/ })).toHaveLength(3);
    expect(posts()).toHaveLength(0);
  });

  it('names the photos the server refused, blocks sending, and sends again after the retake', async () => {
    let answer = () =>
      errorBody(
        'FACE_QUALITY',
        {
          photos: [
            { index: 1, code: 'BLURRY' },
            { index: 2, code: 'TOO_DARK' },
          ],
        },
        422,
      );
    mockApi({ [SEND]: () => answer(), [CONSENT_FLOW]: () => Response.json({ status: 'pending' }) });
    await renderWithTheme(<FaceCaptureScreen />);
    await takeAll();
    await fireEvent.press(screen.getByRole('button', { name: 'Send photos' }));

    expect(await screen.findByText(/Some photos need to be retaken/)).toBeOnTheScreen();
    expect(screen.getByText('The photo was blurry. Hold still and retake it.')).toBeOnTheScreen();
    expect(screen.getByText('The photo was too dark. Move to a brighter place.')).toBeOnTheScreen();
    // Photo 1 was fine and is not marked; sending is blocked until the marked ones are retaken.
    expect(screen.getAllByRole('alert')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Send photos' })).toBeDisabled();

    await fireEvent.press(screen.getByRole('button', { name: 'Retake photo 2' }));
    await screen.findByText(/camera step 2/);
    await take();
    await screen.findByRole('header', { name: 'Check your photos' });
    expect(screen.queryByText('The photo was blurry. Hold still and retake it.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send photos' })).toBeDisabled(); // photo 3 still marked

    await fireEvent.press(screen.getByRole('button', { name: 'Retake photo 3' }));
    await screen.findByText(/camera step 3/);
    await take();
    await screen.findByRole('header', { name: 'Check your photos' });
    answer = enrolled;
    await fireEvent.press(screen.getByRole('button', { name: 'Send photos' }));
    expect(await screen.findByText(/Photos sent\./)).toBeOnTheScreen();
    expect(posts()).toHaveLength(2);
  });

  it('shows an unknown refusal code as an unreadable photo', async () => {
    mockApi({
      [SEND]: () =>
        errorBody('FACE_QUALITY', { photos: [{ index: 0, code: 'SOMETHING_NEW' }] }, 422),
    });
    await renderWithTheme(<FaceCaptureScreen />);
    await takeAll();
    await fireEvent.press(screen.getByRole('button', { name: 'Send photos' }));
    expect(await screen.findByText('The photo could not be read. Retake it.')).toBeOnTheScreen();
  });

  it('shows the server message, and marks nothing, when the refusal names no photo', async () => {
    mockApi({ [SEND]: () => errorBody('FACE_QUALITY', null, 422) });
    await renderWithTheme(<FaceCaptureScreen />);
    await takeAll();
    await fireEvent.press(screen.getByRole('button', { name: 'Send photos' }));
    expect(await screen.findByText('FACE_QUALITY')).toBeOnTheScreen();
    expect(screen.queryByText(/Retake the marked ones/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Send photos' })).toBeEnabled();
  });

  it('says what the server answered when the answer is not its own error format', async () => {
    // A gateway or proxy page: no JSON error, so no message to show.
    mockApi({ [SEND]: () => new Response('<html>Bad Gateway</html>', { status: 502 }) });
    await renderWithTheme(<FaceCaptureScreen />);
    await takeAll();
    await fireEvent.press(screen.getByRole('button', { name: 'Send photos' }));
    expect(
      await screen.findByText('The server answered with an error (502). Please try again.'),
    ).toBeOnTheScreen();
    expect(screen.getByText('502 HTTP_502')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Send photos' })).toBeEnabled();
  });

  it('shows the error name for a failure that is neither the network nor the server', async () => {
    mockApi({
      [SEND]: () => {
        throw new RangeError('request body too large');
      },
    });
    await renderWithTheme(<FaceCaptureScreen />);
    await takeAll();
    await fireEvent.press(screen.getByRole('button', { name: 'Send photos' }));
    expect(await screen.findByText('Something went wrong. Please try again.')).toBeOnTheScreen();
    expect(screen.getByText('RangeError: request body too large')).toBeOnTheScreen();
  });

  it('asks for all three again when they do not look like one person', async () => {
    mockApi({ [SEND]: () => errorBody('FACE_INCONSISTENT', null, 422) });
    await renderWithTheme(<FaceCaptureScreen />);
    await takeAll();
    await fireEvent.press(screen.getByRole('button', { name: 'Send photos' }));
    expect(await screen.findByText(/do not look like the same person/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Retake all three' }));
    expect(await screen.findByText('camera step 1 turn 0')).toBeOnTheScreen();
    await takeAll();
    expect(screen.getByRole('button', { name: 'Send photos' })).toBeEnabled();
  });

  it('goes back to the notice when the consent is missing', async () => {
    mockApi({ [SEND]: () => errorBody('CONSENT_REQUIRED', null, 409) });
    await renderWithTheme(<FaceCaptureScreen />);
    await takeAll();
    await fireEvent.press(screen.getByRole('button', { name: 'Send photos' }));
    await screen.findByRole('button', { name: 'Send photos' });
    expect(mockRouter.replace).toHaveBeenCalledWith('/face/consent');
  });

  it('keeps the photos and allows a retry when the server cannot be reached', async () => {
    let up = false;
    mockApi({
      [SEND]: () => {
        if (!up) throw new TypeError('Network request failed');
        return enrolled();
      },
      [CONSENT_FLOW]: () => Response.json({ status: 'pending' }),
    });
    await renderWithTheme(<FaceCaptureScreen />);
    await takeAll();
    await fireEvent.press(screen.getByRole('button', { name: 'Send photos' }));
    expect(await screen.findByRole('alert')).toBeOnTheScreen();
    expect(screen.getAllByRole('button', { name: /Retake photo/ })).toHaveLength(3);
    up = true;
    await fireEvent.press(screen.getByRole('button', { name: 'Send photos' }));
    expect(await screen.findByText(/Photos sent\./)).toBeOnTheScreen();
  });
});
