import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { colors } from 'design-tokens';
import { useState } from 'react';
import { StyleSheet } from 'react-native';
import type { TextStyle, ViewStyle } from 'react-native';
import { THEME_KEY } from '@/lib/theme';
import { renderWithTheme } from '@/test/render';
import { resetSecureStore, setItemAsync } from '@/test/secure-store-mock';
import { Field } from './field';
import { PasswordField } from './password-field';

function Form() {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  return (
    <>
      <Field label="Employee ID" value={name} onChangeText={setName} />
      <PasswordField label="Password" value={password} onChangeText={setPassword} />
    </>
  );
}

const inputStyle = (label: string) =>
  StyleSheet.flatten(screen.getByLabelText(label).props.style) as TextStyle;
// The input sits directly in its frame (the bordered box that carries the background).
const frameStyle = (label: string) =>
  StyleSheet.flatten(screen.getByLabelText(label).parent?.props.style) as ViewStyle;

beforeEach(() => resetSecureStore());

describe.each(['light', 'dark'] as const)('Field in the %s theme', (theme) => {
  beforeEach(async () => {
    await setItemAsync(THEME_KEY, theme);
    await renderWithTheme(<Form />);
    await waitFor(() => expect(inputStyle('Employee ID').color).toBe(colors[theme].text));
  });

  it.each(['Employee ID', 'Password'])('%s has a visible label and readable text', (label) => {
    expect(screen.getByText(label)).toBeOnTheScreen();
    const input = inputStyle(label);
    const frame = frameStyle(label);
    expect(input.color).toBe(colors[theme].text);
    expect(frame.backgroundColor).toBe(colors[theme].raised);
    expect(input.color).not.toBe(frame.backgroundColor);
    expect(frame.minHeight).toBeGreaterThanOrEqual(48);
  });

  // Regression: `lineHeight: undefined` reached Android's TextInput as 0. After the first typed
  // character the text was measured with no height, the input shrank to its padding and nothing
  // typed was visible (Redmi 13C, Android 15, 2026-10-05). The key must not be there at all.
  it.each(['Employee ID', 'Password'])('%s never passes a lineHeight key', async (label) => {
    expect('lineHeight' in inputStyle(label)).toBe(false);
    await fireEvent.changeText(screen.getByLabelText(label), 'abc123');
    await fireEvent(screen.getByLabelText(label), 'focus');
    expect('lineHeight' in inputStyle(label)).toBe(false);
    expect(inputStyle(label).fontSize).toBe(16);
  });
});

it('the password keeps its text style when it is shown and hidden', async () => {
  await renderWithTheme(<Form />);
  await fireEvent.changeText(screen.getByLabelText('Password'), 'secret-1');
  await fireEvent.press(screen.getByRole('button', { name: 'Show password' }));
  expect('lineHeight' in inputStyle('Password')).toBe(false);
  await fireEvent.press(screen.getByRole('button', { name: 'Hide password' }));
  expect('lineHeight' in inputStyle('Password')).toBe(false);
  expect(screen.getByLabelText('Password').props.value).toBe('secret-1');
});
