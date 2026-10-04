import { screen } from '@testing-library/react-native';
import LoadingScreen from '@/app/loading';
import { renderWithTheme } from '@/test/render';
import { resetSecureStore } from '@/test/secure-store-mock';

beforeEach(() => resetSecureStore());

describe('LoadingScreen', () => {
  it('shows the product name and a labelled progress placeholder', async () => {
    await renderWithTheme(<LoadingScreen />);
    expect(screen.getByText('WorkTrack')).toBeOnTheScreen();
    expect(await screen.findByRole('progressbar', { name: 'Loading...' })).toBeOnTheScreen();
  });
});
