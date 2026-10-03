import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, jsonBody, mockApi } from '@/test/render';
import '@/lib/i18n';
import { ChangePasswordForm } from './change-password-form';
import { LoginForm } from './login-form';

const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

beforeEach(() => router.replace.mockReset());

describe('LoginForm', () => {
  async function submit(identifier: string, password: string) {
    const user = userEvent.setup();
    render(<LoginForm />);
    if (identifier)
      await user.type(screen.getByLabelText('Employee ID or mobile number'), identifier);
    if (password) await user.type(screen.getByLabelText('Password'), password);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
  }

  it('validates required fields without calling the server', async () => {
    const calls = mockApi({});
    await submit('', '');
    expect(await screen.findAllByText('This field is required.')).toHaveLength(2);
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
    expect(calls).toHaveLength(0);
  });

  it('signs in and goes home', async () => {
    const calls = mockApi({ 'POST /api/auth/login': { must_change_password: false } });
    await submit('  ADMIN-1 ', 'secret-pw');
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(jsonBody(calls[0])).toEqual({ identifier: 'ADMIN-1', password: 'secret-pw' });
  });

  it('sends people with a temporary password to the change-password screen', async () => {
    mockApi({ 'POST /api/auth/login': { must_change_password: true } });
    await submit('ADMIN-1', 'temp-pw');
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/change-password'));
  });

  it('shows one generic message for bad credentials (including no web access)', async () => {
    mockApi({ 'POST /api/auth/login': () => apiError(401, 'INVALID_CREDENTIALS') });
    await submit('EMP-9', 'whatever');
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid employee ID or password.');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('shows the lockout time in minutes', async () => {
    mockApi({
      'POST /api/auth/login': () => apiError(429, 'ACCOUNT_LOCKED', { retry_after_seconds: 601 }),
    });
    await submit('EMP-9', 'whatever');
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in 11 minute(s)');
  });

  it('shows a network message when the server cannot be reached', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));
    await submit('EMP-9', 'whatever');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
  });
});

describe('ChangePasswordForm', () => {
  async function fill(current: string, next: string, confirm: string) {
    const user = userEvent.setup();
    render(<ChangePasswordForm />);
    if (current) await user.type(screen.getByLabelText('Current password'), current);
    if (next) await user.type(screen.getByLabelText(/^New password/), next);
    if (confirm) await user.type(screen.getByLabelText('Confirm new password'), confirm);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
  }

  it('requires at least 10 characters', async () => {
    const calls = mockApi({});
    await fill('old-temp-pw', 'short', 'short');
    expect(await screen.findByText('Use at least 10 characters.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('requires the confirmation to match', async () => {
    const calls = mockApi({});
    await fill('old-temp-pw', 'long-enough-pw', 'long-enough-px');
    expect(await screen.findByText('The passwords do not match.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('submits current and new password only, then goes home', async () => {
    const calls = mockApi({ 'POST /api/auth/change-password': { must_change_password: false } });
    await fill('old-temp-pw', 'long-enough-pw', 'long-enough-pw');
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(jsonBody(calls[0])).toEqual({
      current_password: 'old-temp-pw',
      new_password: 'long-enough-pw',
    });
  });

  it('shows the server message for a wrong current password', async () => {
    mockApi({ 'POST /api/auth/change-password': () => apiError(400, 'INVALID_CURRENT_PASSWORD') });
    await fill('wrong-current', 'long-enough-pw', 'long-enough-pw');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The current password is incorrect.',
    );
    expect(router.replace).not.toHaveBeenCalled();
  });
});
