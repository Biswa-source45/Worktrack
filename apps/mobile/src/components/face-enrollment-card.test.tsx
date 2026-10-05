import { fireEvent, screen } from '@testing-library/react-native';
import { calls, errorBody, mockApi } from '@/test/fake-api';
import { renderWithTheme } from '@/test/render';
import { FaceEnrollmentCard, waitingRefresh } from './face-enrollment-card';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const MINE = 'GET /api/v1/me/face-enrollment';
const enrollment = (over: Record<string, unknown> = {}) => ({
  status: 'none',
  consent_at: null,
  submitted_at: null,
  decided_at: null,
  reason: null,
  ...over,
});

async function show(body: Record<string, unknown>) {
  mockApi({ [MINE]: () => Response.json(enrollment(body)) });
  await renderWithTheme(<FaceEnrollmentCard />);
}

beforeEach(() => jest.clearAllMocks());

describe('FaceEnrollmentCard', () => {
  it('invites someone who has not started to set up, and opens the consent notice', async () => {
    await show({});
    expect(await screen.findByText('Not set up')).toBeOnTheScreen();
    expect(screen.getByText(/checked against three photos/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Set up face recognition' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/face/consent');
  });

  it('lets someone who accepted the notice carry on to the photos', async () => {
    await show({ status: 'consented', consent_at: '2026-02-01T04:30:00Z' });
    expect(await screen.findByText('Photos still needed')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Continue setup' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/face/capture');
  });

  it('shows when the photos were sent, and no action, while an admin decides', async () => {
    await show({ status: 'pending', submitted_at: '2026-02-01T04:31:00Z' });
    expect(await screen.findByText('Waiting for approval')).toBeOnTheScreen();
    expect(screen.getByText(/Photos sent .*\(IST\)/)).toBeOnTheScreen();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says the face is enrolled once approved', async () => {
    await show({ status: 'approved', decided_at: '2026-02-02T04:31:00Z' });
    expect(await screen.findByText('Face enrolled')).toBeOnTheScreen();
    expect(screen.getByText(/Your face is enrolled/)).toBeOnTheScreen();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each([
    ['rejected', 'Face is partly covered', 'Your photos were rejected: Face is partly covered'],
    ['rejected', null, 'Your photos were rejected. Enroll again.'],
    ['reset', 'Grew a beard', 'Your enrollment was reset: Grew a beard'],
    ['reset', null, 'Your enrollment was reset. Enroll again.'],
  ])(
    'tells why a %s enrollment ended (%s) and offers to start again',
    async (status, reason, message) => {
      await show({ status, reason });
      expect(await screen.findByText(message)).toBeOnTheScreen();
      expect(screen.getByRole('alert')).toHaveTextContent(message);
      await fireEvent.press(screen.getByRole('button', { name: 'Enroll again' }));
      // Consent is asked for again: the old photos and template were deleted.
      expect(mockRouter.push).toHaveBeenCalledWith('/face/consent');
    },
  );

  it('shows its own Retry when the status cannot be loaded', async () => {
    let answer: Response = errorBody('INTERNAL_ERROR', null, 500);
    mockApi({ [MINE]: () => answer });
    await renderWithTheme(<FaceEnrollmentCard />);
    expect(await screen.findByText('Could not load your face enrollment.')).toBeOnTheScreen();
    answer = Response.json(enrollment({ status: 'approved' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Face enrolled')).toBeOnTheScreen();
    expect(calls.filter((c) => c.url.endsWith('/me/face-enrollment'))).toHaveLength(2);
  });

  it('names the status for screen readers', async () => {
    await show({ status: 'approved' });
    await screen.findByText('Face enrolled');
    expect(screen.getByTestId('face-status')).toHaveAccessibleName('Face enrolled');
  });

  // A plain function, not a fake-timer test: that one never finished under Node 22 (CI) and hung
  // the whole mobile job.
  it('looks again every 15 seconds while an admin has to decide, and never otherwise', () => {
    expect(waitingRefresh('pending')).toBe(15_000);
    for (const status of ['none', 'consented', 'approved', 'rejected', 'reset', undefined]) {
      expect(waitingRefresh(status)).toBe(false);
    }
  });
});
