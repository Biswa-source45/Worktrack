import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { colors } from 'design-tokens';
import * as SystemUI from 'expo-system-ui';
import { Pressable, Text, useColorScheme } from 'react-native';
import { resetSecureStore, secureStoreContents, setItemAsync } from '@/test/secure-store-mock';
import { THEME_KEY, ThemeProvider, useTheme } from './theme';

function Probe() {
  const { choice, scheme, colors: current, ready, setChoice, text, shadow } = useTheme();
  return (
    <>
      <Text testID="state">{`${ready ? 'ready' : 'restoring'} ${choice} ${scheme}`}</Text>
      <Text testID="background">{current.background}</Text>
      <Text testID="font">{JSON.stringify(text('h3'))}</Text>
      <Text testID="shadow">{JSON.stringify(shadow('sm'))}</Text>
      {(['light', 'dark', 'system'] as const).map((option) => (
        <Pressable key={option} accessibilityRole="button" onPress={() => setChoice(option)}>
          <Text>{option}</Text>
        </Pressable>
      ))}
    </>
  );
}

// The React Native Jest preset replaces useColorScheme with a mock function.
const system = (scheme: 'light' | 'dark') => jest.mocked(useColorScheme).mockReturnValue(scheme);

async function renderProbe(fontsLoaded = false) {
  await render(
    <ThemeProvider fontsLoaded={fontsLoaded}>
      <Probe />
    </ThemeProvider>,
  );
  await screen.findByText(/^ready /);
}

const state = () => screen.getByTestId('state');
const background = () => screen.getByTestId('background');

beforeEach(() => {
  resetSecureStore();
  jest.mocked(SystemUI.setBackgroundColorAsync).mockClear();
});
afterEach(() => system('light'));

describe('ThemeProvider', () => {
  it('defaults to System and follows a light system', async () => {
    system('light');
    await renderProbe();
    expect(state()).toHaveTextContent('ready system light');
    expect(background()).toHaveTextContent(colors.light.background);
  });

  it('defaults to System and follows a dark system', async () => {
    system('dark');
    await renderProbe();
    expect(state()).toHaveTextContent('ready system dark');
    expect(background()).toHaveTextContent(colors.dark.background);
  });

  it('lets Dark override a light system, switches the colours and stores the choice', async () => {
    system('light');
    await renderProbe();
    await fireEvent.press(screen.getByText('dark'));
    expect(state()).toHaveTextContent('ready dark dark');
    expect(background()).toHaveTextContent(colors.dark.background);
    await waitFor(() => expect(secureStoreContents()[THEME_KEY]).toBe('dark'));
    expect(THEME_KEY).toBe('worktrack.theme');
  });

  it('lets Light override a dark system, and System hands control back', async () => {
    system('dark');
    await renderProbe();
    await fireEvent.press(screen.getByText('light'));
    expect(state()).toHaveTextContent('ready light light');
    expect(background()).toHaveTextContent(colors.light.background);

    await fireEvent.press(screen.getByText('system'));
    expect(state()).toHaveTextContent('ready system dark');
    await waitFor(() => expect(secureStoreContents()[THEME_KEY]).toBe('system'));
  });

  it('restores the stored choice on the next start', async () => {
    system('light');
    await setItemAsync(THEME_KEY, 'dark');
    await renderProbe();
    expect(state()).toHaveTextContent('ready dark dark');
    expect(background()).toHaveTextContent(colors.dark.background);
  });

  it('ignores a stored value it does not know', async () => {
    system('dark');
    await setItemAsync(THEME_KEY, 'sepia');
    await renderProbe();
    expect(state()).toHaveTextContent('ready system dark');
  });

  it('keeps the native root background on the theme background', async () => {
    system('light');
    await renderProbe();
    expect(SystemUI.setBackgroundColorAsync).toHaveBeenLastCalledWith(colors.light.background);
    await fireEvent.press(screen.getByText('dark'));
    expect(SystemUI.setBackgroundColorAsync).toHaveBeenLastCalledWith(colors.dark.background);
  });

  it('names the font family per weight once the fonts are loaded, and the system font before', async () => {
    system('light');
    await renderProbe(false);
    expect(JSON.parse(screen.getByTestId('font').props.children)).toEqual({
      fontSize: 20,
      lineHeight: 28,
      fontWeight: '600',
    });
    await screen.unmount();

    await renderProbe(true);
    expect(JSON.parse(screen.getByTestId('font').props.children)).toEqual({
      fontSize: 20,
      lineHeight: 28,
      fontFamily: 'PlusJakartaSans_600SemiBold',
    });
  });

  it('builds a shadow with matching iOS shadow props and Android elevation', async () => {
    system('dark');
    await renderProbe();
    expect(JSON.parse(screen.getByTestId('shadow').props.children)).toEqual({
      shadowColor: expect.any(String),
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.35,
      shadowRadius: 1.5,
      elevation: 1,
    });
  });
});
