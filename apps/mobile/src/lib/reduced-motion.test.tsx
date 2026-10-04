import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, Animated } from 'react-native';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import '@/lib/i18n';
import { resetSecureStore } from '@/test/secure-store-mock';
import { ThemeProvider } from './theme';

// The React Native Jest preset replaces AccessibilityInfo with mock functions.
const query = jest.mocked(AccessibilityInfo.isReduceMotionEnabled);
const listen = jest.mocked(AccessibilityInfo.addEventListener);
const timing = jest.spyOn(Animated, 'timing');
const loop = jest.spyOn(Animated, 'loop');

// Every useReducedMotion() caller (the provider and the component) has read the setting.
async function settled() {
  await waitFor(() => expect(query.mock.calls.length).toBeGreaterThanOrEqual(2));
  await act(async () => {});
  timing.mockClear();
}

async function renderButton(reduced: boolean) {
  query.mockResolvedValue(reduced);
  await render(
    <ThemeProvider>
      <Button label="Save" onPress={() => {}} />
    </ThemeProvider>,
  );
  await settled();
  return screen.getByRole('button', { name: 'Save' });
}

async function renderSkeleton(reduced: boolean) {
  query.mockResolvedValue(reduced);
  await render(
    <ThemeProvider>
      <Skeleton accessibilityLabel="Loading..." />
    </ThemeProvider>,
  );
  await settled();
}

beforeEach(() => {
  resetSecureStore();
  for (const mock of [query, listen, timing, loop]) mock.mockClear();
});
afterAll(() => query.mockResolvedValue(false));

describe('Reduce Motion', () => {
  it('scales the button to 0.97 in 150 ms on press when motion is allowed', async () => {
    const button = await renderButton(false);
    await fireEvent(button, 'pressIn');
    expect(timing).toHaveBeenCalledTimes(1);
    expect(timing.mock.calls[0][1]).toMatchObject({
      toValue: 0.97,
      duration: 150,
      useNativeDriver: true,
    });
    await fireEvent(button, 'pressOut');
    expect(timing.mock.calls[1][1]).toMatchObject({ toValue: 1 });
  });

  it('does not start the press animation when Reduce Motion is on', async () => {
    const button = await renderButton(true);
    await fireEvent(button, 'pressIn');
    await fireEvent(button, 'pressOut');
    expect(timing).not.toHaveBeenCalled();
  });

  it('pulses the skeleton when motion is allowed', async () => {
    await renderSkeleton(false);
    expect(loop).toHaveBeenCalledTimes(1);
  });

  it('never starts the skeleton pulse when Reduce Motion is on', async () => {
    await renderSkeleton(true);
    expect(loop).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Loading...')).toBeOnTheScreen();
  });

  it('stops moving as soon as Reduce Motion is switched on', async () => {
    const button = await renderButton(false);
    // The mock is typed by the last overload of addEventListener; these are the boolean ones.
    const handlers = listen.mock.calls
      .filter(([event]) => (event as string) === 'reduceMotionChanged')
      .map(([, handler]) => handler as unknown as (enabled: boolean) => void);
    expect(handlers.length).toBeGreaterThanOrEqual(2);
    await act(async () => handlers.forEach((handler) => handler(true)));

    await fireEvent(button, 'pressIn');
    expect(timing).not.toHaveBeenCalled();
  });
});
