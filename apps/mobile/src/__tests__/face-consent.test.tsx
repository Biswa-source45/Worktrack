import { fireEvent, screen } from '@testing-library/react-native';
import FaceConsentScreen from '@/app/face/consent';
import { calls, errorBody, mockApi } from '@/test/fake-api';
import { renderWithTheme } from '@/test/render';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const CONSENT = 'POST /api/v1/me/face-enrollment/consent';
const AGREE = 'I agree and continue';

beforeEach(() => jest.clearAllMocks());

describe('FaceConsentScreen', () => {
  it('explains what is kept, why, who sees it, how it is protected and when it is deleted', async () => {
    mockApi({});
    await renderWithTheme(<FaceConsentScreen />);
    expect(screen.getByRole('header', { name: 'Before we start' })).toBeOnTheScreen();
    for (const heading of [
      'What we keep',
      'Why',
      'Who can see it',
      'How it is protected',
      'When it is deleted',
    ]) {
      expect(screen.getByText(heading)).toBeOnTheScreen();
    }
    expect(screen.getByText(/Every time they open them, it is logged/)).toBeOnTheScreen();
    // Nothing is recorded until the person agrees.
    expect(calls).toHaveLength(0);
  });

  it('records the consent on the server, then goes on to the photos', async () => {
    mockApi({
      [CONSENT]: () =>
        Response.json({ status: 'consented', consent_at: '2026-02-01T04:30:00Z' }, { status: 201 }),
      'GET /api/v1/me/face-enrollment': () => Response.json({ status: 'consented' }),
    });
    await renderWithTheme(<FaceConsentScreen />);
    await fireEvent.press(screen.getByRole('button', { name: AGREE }));
    await screen.findByRole('button', { name: AGREE });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(mockRouter.replace).toHaveBeenCalledWith('/face/capture');
  });

  it('stays on the notice and says why when the server refuses', async () => {
    mockApi({
      [CONSENT]: () => errorBody('ALREADY_APPROVED', null, 409),
    });
    await renderWithTheme(<FaceConsentScreen />);
    await fireEvent.press(screen.getByRole('button', { name: AGREE }));
    expect(await screen.findByRole('alert')).toBeOnTheScreen();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    // The button is usable again for a retry.
    expect(screen.getByRole('button', { name: AGREE })).toBeEnabled();
  });

  it('says so when the server cannot be reached', async () => {
    mockApi({
      [CONSENT]: () => {
        throw new TypeError('Network request failed');
      },
    });
    await renderWithTheme(<FaceConsentScreen />);
    await fireEvent.press(screen.getByRole('button', { name: AGREE }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/connect|network/i);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('goes back without recording anything on Not now', async () => {
    mockApi({});
    await renderWithTheme(<FaceConsentScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Not now' }));
    expect(mockRouter.back).toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});
