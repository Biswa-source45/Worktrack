import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { ApiError } from '@/lib/api-error';
import { renderWithTheme } from '@/test/render';
import { ConfirmDialog } from './confirm-dialog';

const button = (name: string) => screen.getByRole('button', { name });
const disabled = (name: string) => button(name).props.accessibilityState.disabled;

function setup(onConfirm: () => Promise<void>, notice?: string) {
  const onClose = jest.fn();
  return {
    onClose,
    render: () =>
      renderWithTheme(
        <ConfirmDialog
          title="Revoke phone"
          message="Revoke iPhone 15 for Asha Rao?"
          notice={notice}
          confirmLabel="Revoke"
          destructive
          onConfirm={onConfirm}
          onClose={onClose}
        />,
      ),
  };
}

describe('ConfirmDialog', () => {
  it('shows the title as a header, the message and the notice', async () => {
    const { render } = setup(jest.fn(), 'They are signed out at once.');
    await render();
    expect(screen.getByRole('header', { name: 'Revoke phone' })).toBeOnTheScreen();
    expect(screen.getByText('Revoke iPhone 15 for Asha Rao?')).toBeOnTheScreen();
    expect(screen.getByRole('alert')).toHaveTextContent('They are signed out at once.');
    expect(screen.getByTestId('dialog').props.accessibilityViewIsModal).toBe(true);
  });

  it('confirms once, then closes', async () => {
    const onConfirm = jest.fn(() => Promise.resolve());
    const { render, onClose } = setup(onConfirm);
    await render();
    await fireEvent.press(button('Revoke'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons while the action runs, so it cannot be sent twice', async () => {
    let finish = () => {};
    const onConfirm = jest.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { render, onClose } = setup(onConfirm);
    await render();
    expect(disabled('Revoke')).toBe(false);

    await fireEvent.press(button('Revoke'));
    expect(disabled('Revoke')).toBe(true);
    expect(disabled('Cancel')).toBe(true);
    await fireEvent.press(button('Revoke'));
    await fireEvent.press(button('Cancel'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    finish();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('stays open with the server message when the action fails, and can be retried', async () => {
    const onConfirm = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new ApiError(409, 'CONFLICT', 'This phone is no longer active.'))
      .mockResolvedValueOnce();
    const { render, onClose } = setup(onConfirm);
    await render();
    await fireEvent.press(button('Revoke'));
    expect(await screen.findByRole('alert')).toHaveTextContent('This phone is no longer active.');
    expect(onClose).not.toHaveBeenCalled();
    expect(disabled('Revoke')).toBe(false);

    await fireEvent.press(button('Revoke'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('shows a general message when the failure has no server message', async () => {
    const { render } = setup(() => Promise.reject(new Error('boom')));
    await render();
    await fireEvent.press(button('Revoke'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    );
  });

  it('closes from Cancel and from the Android back button', async () => {
    const { render, onClose } = setup(jest.fn());
    await render();
    await fireEvent.press(button('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    await fireEvent(screen.getByTestId('dialog-modal'), 'requestClose');
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
