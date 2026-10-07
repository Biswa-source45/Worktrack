import { act, fireEvent, screen } from '@testing-library/react-native';
import { renderWithTheme } from '@/test/render';
import { PhotoCamera } from './photo-camera';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 }),
}));

const mockApp = { available: true };
jest.mock('@/lib/camera', () => ({
  get cameraAvailable() {
    return mockApp.available;
  },
}));

type CameraProps = { onStarted: () => void; onError: (error: Error) => void };
const mockVision = {
  permission: true,
  canRequest: true,
  device: {} as object | undefined,
  capture: jest.fn(),
  requestPermission: jest.fn(),
  outputOptions: undefined as unknown,
  deviceFacing: '',
  camera: undefined as CameraProps | undefined,
};

// There is no camera in Jest: this stands in for VisionCamera, which starts at once.
jest.mock('react-native-vision-camera', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const React = require('react');
  const { View } = require('react-native');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    CommonResolutions: { HD_4_3: 'HD_4_3' },
    useCameraPermission: () => ({
      hasPermission: mockVision.permission,
      canRequestPermission: mockVision.canRequest,
      requestPermission: mockVision.requestPermission,
    }),
    useCameraDevice: (facing: string) => {
      mockVision.deviceFacing = facing;
      return mockVision.device;
    },
    usePhotoOutput: (options: unknown) => {
      mockVision.outputOptions = options;
      return { capturePhotoToFile: mockVision.capture };
    },
    Camera: (props: CameraProps) => {
      mockVision.camera = props;
      React.useEffect(() => props.onStarted(), []); // eslint-disable-line react-hooks/exhaustive-deps
      return React.createElement(View, { testID: 'camera' });
    },
  };
});

const shutter = () => screen.findByRole('button', { name: 'Take photo' });

beforeEach(() => {
  jest.clearAllMocks();
  mockApp.available = true;
  Object.assign(mockVision, { permission: true, canRequest: true, device: {}, camera: undefined });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('PhotoCamera', () => {
  it('opens the back camera with balanced quality, never speed', async () => {
    await renderWithTheme(<PhotoCamera onPhoto={jest.fn()} />);
    await shutter();
    expect(mockVision.deviceFacing).toBe('back');
    expect(mockVision.outputOptions).toMatchObject({ qualityPrioritization: 'balanced' });
  });

  it('takes a photo only when the shutter is pressed and hands over its file uri', async () => {
    mockVision.capture.mockResolvedValue({ filePath: '/cache/task-1.jpg' });
    const onPhoto = jest.fn();
    await renderWithTheme(<PhotoCamera onPhoto={onPhoto} />);
    await shutter();
    expect(onPhoto).not.toHaveBeenCalled();
    await fireEvent.press(await shutter());
    await screen.findByRole('button', { name: 'Take photo' });
    expect(onPhoto).toHaveBeenCalledWith('file:///cache/task-1.jpg');
  });

  it('shows a failed capture in words and lets the employee press again', async () => {
    mockVision.capture.mockRejectedValueOnce(new Error('boom'));
    const onPhoto = jest.fn();
    await renderWithTheme(<PhotoCamera onPhoto={onPhoto} />);
    await fireEvent.press(await shutter());
    expect(
      await screen.findByText('Could not take the photo. Please try again.'),
    ).toBeOnTheScreen();
    mockVision.capture.mockResolvedValueOnce({ filePath: 'file:///cache/again.jpg' });
    await fireEvent.press(await shutter());
    await screen.findByRole('button', { name: 'Take photo' });
    expect(onPhoto).toHaveBeenCalledWith('file:///cache/again.jpg');
  });

  it('shows the camera error with Try again instead of a black screen, and reopens on retry', async () => {
    await renderWithTheme(<PhotoCamera onPhoto={jest.fn()} />);
    await shutter();
    const props = mockVision.camera;
    expect(props).toBeDefined();
    await act(() => props?.onError(new Error('CameraX: session failed')));
    expect(await screen.findByText('The camera did not work.')).toBeOnTheScreen();
    expect(screen.getByText('CameraX: session failed')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await shutter();
  });

  it('says why when the camera permission is denied, and offers the settings when it cannot ask', async () => {
    Object.assign(mockVision, { permission: false, canRequest: false });
    await renderWithTheme(<PhotoCamera onPhoto={jest.fn()} />);
    expect(await screen.findByText('Allow the camera')).toBeOnTheScreen();
    expect(screen.getByText(/Nothing is read from your gallery/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeOnTheScreen();
  });

  it('asks for the permission when it still can', async () => {
    Object.assign(mockVision, { permission: false, canRequest: true });
    await renderWithTheme(<PhotoCamera onPhoto={jest.fn()} />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Allow camera' }));
    expect(mockVision.requestPermission).toHaveBeenCalled();
  });

  it('lets a form close the camera with the back arrow instead of leaving the screen', async () => {
    const onCancel = jest.fn();
    await renderWithTheme(<PhotoCamera onPhoto={jest.fn()} onCancel={onCancel} />);
    await shutter();
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('says the development build is needed in Expo Go instead of crashing', async () => {
    mockApp.available = false;
    await renderWithTheme(<PhotoCamera onPhoto={jest.fn()} />);
    expect(screen.getByText('Needs the development build')).toBeOnTheScreen();
    expect(screen.getByText(/not available in Expo Go/)).toBeOnTheScreen();
    expect(mockVision.camera).toBeUndefined();
  });
});
