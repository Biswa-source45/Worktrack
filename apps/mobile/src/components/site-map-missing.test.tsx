import { screen } from '@testing-library/react-native';
import { renderWithTheme } from '@/test/render';
import { SiteMap } from './site-map';

// The build the phone has today: react-native-maps is not in it.
jest.mock(
  'react-native-maps',
  () => {
    throw new Error("Cannot find module 'react-native-maps'");
  },
  { virtual: true },
);

describe('SiteMap without the native map module', () => {
  it('shows the address on its own and does not crash', async () => {
    await renderWithTheme(
      <SiteMap lat={20.2961} lng={85.8245} radiusM={200} address="Plot 4, Patia, Bhubaneswar" />,
    );
    expect(screen.getByText('Plot 4, Patia, Bhubaneswar')).toBeOnTheScreen();
  });
});
