import { fireEvent, screen } from '@testing-library/react-native';
import { renderWithTheme } from '@/test/render';
import { CameraProblem } from './camera-problem';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

describe('CameraProblem', () => {
  it('says the camera did not work, shows what the library reported, and offers Try again', async () => {
    const onRetry = jest.fn();
    await renderWithTheme(<CameraProblem detail="CameraX: session failed" onRetry={onRetry} />);
    expect(screen.getByText('The camera did not work.')).toBeOnTheScreen();
    expect(screen.getByText(/Close other apps that use the camera/)).toBeOnTheScreen();
    expect(screen.getByText('CameraX: session failed')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('leaves the way out in reach', async () => {
    await renderWithTheme(<CameraProblem detail="" onRetry={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('shows no detail line when there is none', async () => {
    await renderWithTheme(<CameraProblem detail="" onRetry={jest.fn()} />);
    expect(screen.queryByText('CameraX: session failed')).toBeNull();
  });
});
