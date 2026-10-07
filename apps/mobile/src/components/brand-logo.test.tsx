import { screen } from '@testing-library/react-native';
import { StyleSheet, useColorScheme } from 'react-native';
import compactDark from '../../assets/brand/logo-compact-dark.png';
import compactLight from '../../assets/brand/logo-compact-light.png';
import { BrandLogo } from '@/components/brand-logo';
import { renderWithTheme } from '@/test/render';

// The React Native Jest preset replaces useColorScheme with a mock function.
const system = (scheme: 'light' | 'dark') => jest.mocked(useColorScheme).mockReturnValue(scheme);

describe('BrandLogo', () => {
  it('shows the light-theme logo (dark text) on a light system, labelled for a screen reader', async () => {
    system('light');
    await renderWithTheme(<BrandLogo width={240} />);
    const logo = await screen.findByRole('image', { name: 'WorkTrack' });
    expect(logo.props.source).toBe(compactLight);
  });

  it('shows the dark-theme logo (white text) on a dark system', async () => {
    system('dark');
    await renderWithTheme(<BrandLogo width={240} />);
    const logo = await screen.findByRole('image', { name: 'WorkTrack' });
    expect(logo.props.source).toBe(compactDark);
  });

  it('keeps the logo proportions at any width', async () => {
    system('light');
    await renderWithTheme(<BrandLogo width={200} />);
    const logo = await screen.findByRole('image', { name: 'WorkTrack' });
    const { width, height } = StyleSheet.flatten(logo.props.style);
    expect(width).toBe(200);
    expect(height).toBeCloseTo(40, 0); // the file is 480 x 96
  });
});
