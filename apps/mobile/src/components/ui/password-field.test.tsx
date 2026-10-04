import { fireEvent, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { renderWithTheme } from '@/test/render';
import { resetSecureStore } from '@/test/secure-store-mock';
import { PasswordField } from './password-field';

function Form({ kind }: { kind?: 'current' | 'new' }) {
  const [value, setValue] = useState('');
  return <PasswordField label="Password" kind={kind} value={value} onChangeText={setValue} />;
}

const input = () => screen.getByLabelText('Password');

beforeEach(() => resetSecureStore());

describe('PasswordField', () => {
  it('is hidden by default and offers Show password', async () => {
    await renderWithTheme(<Form />);
    expect(input().props.secureTextEntry).toBe(true);
    expect(screen.getByRole('button', { name: 'Show password' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Hide password' })).toBeNull();
  });

  it('shows and hides again, changes the button name and keeps the value', async () => {
    await renderWithTheme(<Form />);
    await fireEvent.changeText(input(), 'secret-pass-1');

    await fireEvent.press(screen.getByRole('button', { name: 'Show password' }));
    expect(input().props.secureTextEntry).toBe(false);
    expect(input().props.value).toBe('secret-pass-1');
    expect(screen.queryByRole('button', { name: 'Show password' })).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'Hide password' }));
    expect(input().props.secureTextEntry).toBe(true);
    expect(input().props.value).toBe('secret-pass-1');
    expect(screen.getByRole('button', { name: 'Show password' })).toBeOnTheScreen();
  });

  it('has a 48 point toggle', async () => {
    await renderWithTheme(<Form />);
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveStyle({
      width: 48,
      height: 48,
    });
  });

  it.each([
    ['current', 'password', 'password'],
    ['new', 'newPassword', 'new-password'],
  ] as const)('keeps autofill working for a %s password', async (kind, contentType, complete) => {
    await renderWithTheme(<Form kind={kind} />);
    expect(input().props.textContentType).toBe(contentType);
    expect(input().props.autoComplete).toBe(complete);
    await fireEvent.press(screen.getByRole('button', { name: 'Show password' }));
    expect(input().props.textContentType).toBe(contentType);
    expect(input().props.autoComplete).toBe(complete);
  });

  it('announces the error next to the field', async () => {
    await renderWithTheme(
      <PasswordField label="Password" value="" error="This field is required." />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('This field is required.');
  });
});
