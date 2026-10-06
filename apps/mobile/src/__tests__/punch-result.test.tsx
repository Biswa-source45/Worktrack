import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import PunchRequestScreen from '@/app/punch/request';
import PunchResultScreen from '@/app/punch/result';
import { ApiError } from '@/lib/api-error';
import { currentFlow, endFlow, finishAttempt, startFlow } from '@/lib/punch-flow';
import type { Flow, Outcome } from '@/lib/punch-flow';
import { dayBody, punchBody, punchResultBody } from '@/test/fake-api';
import { renderWithTheme } from '@/test/render';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const FLOW: Flow = {
  kind: 'in',
  fix: { lat: 20.2961, lng: 85.8245, accuracyM: 12.5, mocked: false },
  integrity: { emulator: false, rooted: false },
};
const sent = (
  kind: 'in' | 'out' | 'request',
  body: Parameters<typeof punchResultBody>[0] = {},
): Outcome => ({ type: 'sent', kind, result: punchResultBody(body) });
const refused = (code: string, message: string, status = 422): Outcome => ({
  type: 'rejected',
  error: new ApiError(status, code, message),
});
async function show(outcome: Outcome | null, flow: Flow | null = FLOW) {
  endFlow();
  if (flow) startFlow(flow);
  if (outcome) finishAttempt(outcome);
  await renderWithTheme(<PunchResultScreen />);
}
const press = (name: string) => fireEvent.press(screen.getByRole('button', { name }));

beforeEach(() => {
  jest.clearAllMocks();
  endFlow();
});

describe('PunchResultScreen', () => {
  it('shows a verified punch-in with the counted time in IST', async () => {
    await show(sent('in', { punch: punchBody({ time: '2026-10-05T03:35:00Z' }) }));
    expect(screen.getByRole('header', { name: 'Punched in' })).toBeOnTheScreen();
    expect(screen.getByText('Counted at 9:05 am (IST)')).toBeOnTheScreen();
    expect(screen.queryByText(/late/)).toBeNull();
  });

  it('says how late a punch-in was only when it was late', async () => {
    await show(sent('in', { day: dayBody({ late_minutes: 12 }) }));
    expect(screen.getByText('You are late by 12 min.')).toBeOnTheScreen();
  });

  it('shows a verified punch-out, never as late', async () => {
    await show(
      sent('out', { punch: punchBody({ type: 'out' }), day: dayBody({ late_minutes: 12 }) }),
    );
    expect(screen.getByRole('header', { name: 'Punched out' })).toBeOnTheScreen();
    expect(screen.queryByText(/late/)).toBeNull();
  });

  it('shows a punch in review as sent for review, with no score and no word mismatch', async () => {
    await show(
      sent('in', {
        result: 'in_review',
        punch: punchBody({ in_review: true, review_status: 'pending' }),
      }),
    );
    expect(screen.getByRole('header', { name: 'Sent for review' })).toBeOnTheScreen();
    expect(screen.getByText('An admin will review this punch.')).toBeOnTheScreen();
    expect(screen.queryByText(/score|mismatch|match/i)).toBeNull();
  });

  it('shows a punch-out request as waiting for approval', async () => {
    await show(sent('request', { result: 'in_review' }));
    expect(screen.getByRole('header', { name: 'Request sent' })).toBeOnTheScreen();
    expect(screen.getByText('Your punch-out request is waiting for approval.')).toBeOnTheScreen();
  });

  it('tells the employee a punch was saved on the phone, and links to the saved punches', async () => {
    await show({ type: 'queued', kind: 'in' });
    expect(screen.getByRole('header', { name: 'Saved on this phone' })).toBeOnTheScreen();
    expect(
      screen.getByText('Saved on this phone. It will be sent when you are online.'),
    ).toBeOnTheScreen();
    await press('See saved punches');
    expect(mockRouter.replace).toHaveBeenCalledWith('/punch/queue');
  });

  it('shows the server message for a refusal, with its status and code, and no retake', async () => {
    await show(refused('OUTSIDE_GEOFENCE', 'You are 340 m away from Head Office.'));
    expect(screen.getByRole('header', { name: 'Punch not recorded' })).toBeOnTheScreen();
    expect(screen.getByText('You are 340 m away from Head Office.')).toBeOnTheScreen();
    expect(screen.getByText('422 OUTSIDE_GEOFENCE')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Take it again' })).toBeNull();
  });

  it('explains a refusal that only echoes its code in the app words', async () => {
    await show(refused('DEVICE_NOT_TRUSTED', 'DEVICE_NOT_TRUSTED', 403));
    expect(screen.getByText('This phone is not trusted for punching.')).toBeOnTheScreen();
  });

  it('offers to take the selfie again when it could not be used, keeping the punch in progress', async () => {
    await show(
      refused('FACE_RETAKE', 'The photo was too dark. Move to a brighter place and try again.'),
    );
    expect(
      screen.getByText('The photo was too dark. Move to a brighter place and try again.'),
    ).toBeOnTheScreen();
    await press('Take it again');
    expect(mockRouter.replace).toHaveBeenCalledWith('/punch/capture');
    // Leaving this screen for the camera must not end the punch.
    await screen.unmount();
    expect(currentFlow()).toEqual(FLOW);
  });

  it('ends the punch and goes Home on Done', async () => {
    await show(sent('in'));
    await press('Done');
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
    await screen.unmount();
    expect(currentFlow()).toBeNull();
  });

  it('goes back to Home when there is nothing to show', async () => {
    await show(null, null);
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'));
  });
});

describe('PunchRequestScreen', () => {
  const REQUEST_FLOW: Flow = { ...FLOW, kind: 'request' };
  const field = (label: string) => screen.getByLabelText(label);
  const render = async (flow: Flow | null = REQUEST_FLOW) => {
    endFlow();
    if (flow) startFlow(flow);
    await renderWithTheme(<PunchRequestScreen />);
  };

  it('needs a reason of at least three characters before the camera', async () => {
    await render();
    await press('Continue to selfie');
    expect(await screen.findByText('Give a reason of at least 3 characters.')).toBeOnTheScreen();
    expect(mockRouter.replace).not.toHaveBeenCalled();

    await fireEvent.changeText(field('Reason'), '  ab ');
    await press('Continue to selfie');
    expect(await screen.findByText('Give a reason of at least 3 characters.')).toBeOnTheScreen();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(currentFlow()?.reason).toBeUndefined();
  });

  it('keeps the reason and the optional note with the punch and opens the camera', async () => {
    await render();
    await fireEvent.changeText(field('Reason'), ' Client site visit ');
    await fireEvent.changeText(field('Note (optional)'), 'Back by five');
    await press('Continue to selfie');
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/punch/capture'));
    expect(currentFlow()).toMatchObject({
      kind: 'request',
      reason: 'Client site visit',
      note: 'Back by five',
    });
  });

  it('does not need a note', async () => {
    await render();
    await fireEvent.changeText(field('Reason'), 'Client site visit');
    await press('Continue to selfie');
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/punch/capture'));
    expect(currentFlow()?.note).toBeUndefined();
  });

  it('limits the reason to 200 characters and the note to 500', async () => {
    await render();
    expect(field('Reason').props.maxLength).toBe(200);
    expect(field('Note (optional)').props.maxLength).toBe(500);
  });

  it('goes back to Home when it is opened without a request in progress', async () => {
    await render(FLOW);
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'));
    expect(screen.queryByLabelText('Reason')).toBeNull();
  });
});
