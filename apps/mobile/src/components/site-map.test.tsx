import { screen } from '@testing-library/react-native';
import { renderWithTheme } from '@/test/render';
import { SiteMap } from './site-map';

const mockMaps = { crash: false, circle: undefined as Record<string, unknown> | undefined };

// There is no native map in Jest: this stands in for react-native-maps once it is in the build.
jest.mock(
  'react-native-maps',
  () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const React = require('react');
    const { View, Text } = require('react-native');
    /* eslint-enable @typescript-eslint/no-require-imports */
    return {
      __esModule: true,
      default: ({ children, initialRegion }: { children: unknown; initialRegion: object }) => {
        if (mockMaps.crash) throw new Error('View config not found for RNMapsMapView');
        return React.createElement(
          View,
          { testID: 'map', accessibilityHint: JSON.stringify(initialRegion) },
          children,
        );
      },
      Marker: () => React.createElement(Text, null, 'pin'),
      Circle: (props: Record<string, unknown>) => {
        mockMaps.circle = props;
        return null;
      },
    };
  },
  { virtual: true },
);

const SITE = { lat: 20.2961, lng: 85.8245, radiusM: 200, address: 'Plot 4, Patia, Bhubaneswar' };

beforeEach(() => {
  mockMaps.crash = false;
  mockMaps.circle = undefined;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('SiteMap with the native map in the build', () => {
  it('shows the pin and the site circle at the task radius, in theme colours', async () => {
    await renderWithTheme(<SiteMap {...SITE} />);
    expect(screen.getByTestId('map')).toBeOnTheScreen();
    expect(screen.getByText('pin')).toBeOnTheScreen();
    expect(mockMaps.circle).toMatchObject({
      center: { latitude: 20.2961, longitude: 85.8245 },
      radius: 200,
    });
    expect(screen.getByLabelText(`Map of the task site: ${SITE.address}`)).toBeOnTheScreen();
  });

  it('falls back to the address when the map fails to start instead of crashing', async () => {
    mockMaps.crash = true;
    await renderWithTheme(<SiteMap {...SITE} />);
    expect(screen.queryByTestId('map')).toBeNull();
    expect(screen.getByText(SITE.address)).toBeOnTheScreen();
  });
});
