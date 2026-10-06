import { screen } from '@testing-library/react-native';
import i18n from '@/lib/i18n';
import type { QueueRow } from '@/lib/punch-queue';
import { renderWithTheme } from '@/test/render';
import { PunchQueueRow } from './punch-queue-row';

const row = (over: Partial<QueueRow>): QueueRow => ({
  id: 'r-1',
  seq: 1,
  user_id: 1,
  kind: 'task_complete',
  status: 'failed',
  attempts: 0,
  error_code: 'PROOF_PHOTO_REQUIRED',
  error_message: 'Add at least one proof photo.',
  created_at: '2026-10-06T04:30:00.000Z',
  updated_at: '2026-10-06T04:31:00.000Z',
  ...over,
});

describe('PunchQueueRow for a saved task action', () => {
  it('names the action and shows the server reason when it was refused', async () => {
    await renderWithTheme(
      <PunchQueueRow row={row({})} t={i18n.t} onRetry={jest.fn()} onDiscard={jest.fn()} />,
    );
    expect(screen.getByText('Complete task')).toBeOnTheScreen();
    expect(screen.getByText('Not sent: Add at least one proof photo.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: /^Retry/ })).toBeOnTheScreen();
  });
});
