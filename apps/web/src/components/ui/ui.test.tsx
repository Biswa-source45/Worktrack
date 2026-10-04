import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import { cn } from '@/lib/utils';
import { initials } from './avatar';
import { PasswordInput } from './password-input';

describe('PasswordInput', () => {
  function mount(onSubmit = vi.fn()) {
    render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label htmlFor="pw">Password</label>
        <PasswordInput id="pw" name="password" autoComplete="current-password" />
        <button type="submit">Sign in</button>
      </form>,
    );
    return { onSubmit, input: screen.getByLabelText('Password') };
  }

  it('is hidden by default and keeps id, name and autocomplete', () => {
    const { input } = mount();
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('id', 'pw');
    expect(input).toHaveAttribute('name', 'password');
    expect(input).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('shows and hides the value, changing only the type, the label and aria-pressed', async () => {
    const user = userEvent.setup();
    const { input } = mount();
    await user.type(input, 'secret-pw');

    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveValue('secret-pw');
    expect(input).toHaveAttribute('name', 'password');
    expect(input).toHaveAttribute('autocomplete', 'current-password');
    const hide = screen.getByRole('button', { name: 'Hide password' });
    expect(hide).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Show password' })).not.toBeInTheDocument();

    await user.click(hide);
    expect(input).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('never submits the form, by mouse or keyboard, and follows the input in the tab order', async () => {
    const user = userEvent.setup();
    const { input, onSubmit } = mount();
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('type', 'button');

    await user.click(toggle);
    input.focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(input).toHaveAttribute('type', 'password');
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('initials', () => {
  it.each([
    ['Asha Rao', 'AR'],
    ['  demo   admin ', 'DA'],
    ['Biswabhusan Kumar Sahoo', 'BS'],
    ['Madonna', 'M'],
    ['', ''],
  ])('%j -> %j', (name, expected) => {
    expect(initials(name)).toBe(expected);
  });
});

describe('cn', () => {
  it('keeps a type-scale class next to a text colour', () => {
    expect(cn('text-h1', 'text-muted-foreground')).toBe('text-h1 text-muted-foreground');
    expect(cn('text-small', 'text-caption')).toBe('text-caption');
  });
});
