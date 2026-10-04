import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import type { components } from 'api-types';
import { HomeLocationCard } from '@/components/home-location-card';
import { LocationError, getCurrentFix } from '@/lib/location';
import type { LocationErrorCode } from '@/lib/location';
import { bodyOf, calls, failure, mockApi } from '@/test/fake-api';
import { renderWithTheme } from '@/test/render';
import { resetSecureStore } from '@/test/secure-store-mock';

// The phone's GPS is replaced; the helper itself is covered in src/lib/location.test.ts.
jest.mock('@/lib/location', () => ({
  ...jest.requireActual('@/lib/location'),
  getCurrentFix: jest.fn(),
}));
const locate = jest.mocked(getCurrentFix);

type MyHome = components['schemas']['MyHomeOut'];

const MINE = 'GET /api/v1/me/home-location';
const REQUEST = 'POST /api/v1/me/home-location-requests';
const USE = 'Use my current location';
const AGAIN = 'Send a new request';
const INTRO = 'Stand at the place you work from at home. Your admin must approve it.';
const HERE = { lat: 20.3001, lng: 85.8302, accuracyM: 18.6 };
const NONE: MyHome = { approved: null, pending: null, last_rejected: null };
const PENDING = { created_at: '2026-10-04T09:12:00Z' };
const APPROVED = { radius_m: 100, decided_at: '2026-10-02T06:00:00Z' };

const button = (name: string) => screen.getByRole('button', { name });
const dialog = () => within(screen.getByTestId('dialog'));
const posts = () => calls.filter((call) => call.method === 'POST');

let home: MyHome;

async function renderCard(routes: Parameters<typeof mockApi>[0] = {}) {
  mockApi({ [MINE]: () => Response.json(home), ...routes });
  await renderWithTheme(<HomeLocationCard />);
  await screen.findByText(INTRO);
}

beforeEach(() => {
  resetSecureStore();
  home = NONE;
  locate.mockReset();
  locate.mockResolvedValue(HERE);
});

describe('Work-from-home location (Profile & Settings)', () => {
  describe('states', () => {
    it('says Not set when there is nothing yet', async () => {
      await renderCard();
      expect(screen.getByRole('header', { name: 'Work-from-home location' })).toBeOnTheScreen();
      expect(screen.getByText('Not set')).toBeOnTheScreen();
      expect(button(USE)).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: AGAIN })).toBeNull();
    });

    it('shows a pending request with the time it was sent, in IST', async () => {
      home = { ...NONE, pending: PENDING };
      await renderCard();
      expect(screen.getByText('Request pending')).toBeOnTheScreen();
      expect(screen.getByText('Requested 4 Oct 2026, 2:42 pm')).toBeOnTheScreen();
      expect(screen.queryByText('Not set')).toBeNull();
      expect(button(AGAIN)).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: USE })).toBeNull();
    });

    it('shows an approved location with its radius', async () => {
      home = { ...NONE, approved: APPROVED };
      await renderCard();
      expect(screen.getByText('Approved')).toBeOnTheScreen();
      expect(
        screen.getByText('You can punch in within 100 metres of this place.'),
      ).toBeOnTheScreen();
      expect(screen.queryByText('Not set')).toBeNull();
      expect(button(AGAIN)).toBeOnTheScreen();
    });

    it('shows the last rejection with its reason when nothing newer exists', async () => {
      home = {
        ...NONE,
        last_rejected: { reason: 'This is not your address.', decided_at: '2026-10-03T06:00:00Z' },
      };
      await renderCard();
      expect(
        screen.getByText('Your last request was rejected: This is not your address.'),
      ).toBeOnTheScreen();
      expect(screen.getByText('Not set')).toBeOnTheScreen();
      expect(button(USE)).toBeOnTheScreen();
    });

    it('shows a rejection without a reason', async () => {
      home = { ...NONE, last_rejected: { reason: null, decided_at: '2026-10-03T06:00:00Z' } };
      await renderCard();
      expect(screen.getByText('Your last request was rejected.')).toBeOnTheScreen();
    });

    it('still shows a rejection that came after the approved location', async () => {
      home = {
        approved: APPROVED,
        pending: null,
        last_rejected: { reason: 'Too far.', decided_at: '2026-10-03T06:00:00Z' },
      };
      await renderCard();
      expect(screen.getByText('Approved')).toBeOnTheScreen();
      expect(screen.getByText('Your last request was rejected: Too far.')).toBeOnTheScreen();
    });

    it.each<[string, MyHome]>([
      [
        'a newer pending request',
        {
          approved: null,
          pending: PENDING,
          last_rejected: { reason: 'Too far.', decided_at: '2026-10-03T06:00:00Z' },
        },
      ],
      [
        'a newer approval',
        {
          approved: APPROVED,
          pending: null,
          last_rejected: { reason: 'Too far.', decided_at: '2026-10-01T06:00:00Z' },
        },
      ],
    ])('hides an old rejection behind %s', async (_, state) => {
      home = state;
      await renderCard();
      expect(screen.queryByText(/rejected/)).toBeNull();
    });

    it('shows an error with Retry when the state cannot load', async () => {
      let fail = true;
      mockApi({
        [MINE]: () =>
          fail ? failure(500, 'INTERNAL', 'The server had a problem.') : Response.json(home),
      });
      await renderWithTheme(<HomeLocationCard />);
      expect(
        await screen.findByText('Could not load your work-from-home location.'),
      ).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: USE })).toBeNull();
      fail = false;
      await fireEvent.press(button('Retry'));
      expect(await screen.findByText('Not set')).toBeOnTheScreen();
    });
  });

  describe('request', () => {
    it('asks with the accuracy, sends the fix once and then shows Pending', async () => {
      await renderCard({
        [REQUEST]: () => {
          home = { ...NONE, pending: PENDING };
          return Response.json(
            { status: 'pending', radius_m: 100, created_at: PENDING.created_at },
            { status: 201 },
          );
        },
      });
      await fireEvent.press(button(USE));
      expect(
        await dialog().findByText(
          'Send this place to your admin as your work-from-home location? Accuracy ±19 m',
        ),
      ).toBeOnTheScreen();
      expect(posts()).toHaveLength(0);

      await fireEvent.press(dialog().getByRole('button', { name: 'Send request' }));
      await waitFor(() => expect(screen.queryByTestId('dialog')).toBeNull());
      expect(posts()).toHaveLength(1);
      expect(await bodyOf(posts()[0])).toEqual({
        lat: HERE.lat,
        lng: HERE.lng,
        accuracy_m: HERE.accuracyM,
      });
      expect(await screen.findByText('Request pending')).toBeOnTheScreen();
      expect(button(AGAIN)).toBeOnTheScreen();
    });

    it('never shows the coordinates', async () => {
      await renderCard();
      await fireEvent.press(button(USE));
      await screen.findByTestId('dialog');
      expect(screen.queryByText(/20\.3|85\.8/)).toBeNull();
      await fireEvent.press(dialog().getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByText(/20\.3|85\.8/)).toBeNull();
    });

    it('sends nothing on Cancel and asks the phone again the next time', async () => {
      await renderCard();
      await fireEvent.press(button(USE));
      await fireEvent.press(await dialog().findByRole('button', { name: 'Cancel' }));
      expect(screen.queryByTestId('dialog')).toBeNull();
      expect(posts()).toHaveLength(0);

      await fireEvent.press(button(USE));
      await screen.findByTestId('dialog');
      expect(locate).toHaveBeenCalledTimes(2);
    });

    it.each([
      [
        422,
        'GPS_ACCURACY_POOR',
        'Your location is not accurate enough. Move to an open area and try again.',
      ],
      [403, 'DEVICE_NOT_APPROVED', 'This phone is not approved yet. Ask your admin to approve it.'],
    ])('keeps the dialog open with the message for %i %s', async (status, code, message) => {
      await renderCard({ [REQUEST]: () => failure(status, code, message) });
      await fireEvent.press(button(USE));
      await fireEvent.press(await dialog().findByRole('button', { name: 'Send request' }));
      expect(await dialog().findByText(message)).toBeOnTheScreen();
      expect(screen.getByText('Not set')).toBeOnTheScreen();
    });

    it.each<[LocationErrorCode, string]>([
      [
        'permission_denied',
        "WorkTrack may not use your location. Allow location for WorkTrack in your phone's Settings, then try again.",
      ],
      ['services_off', 'Location is turned off on this phone. Turn it on and try again.'],
      ['timeout', 'Finding your location took too long. Move to an open area and try again.'],
      ['unavailable', 'Could not get your location. Please try again.'],
    ])('explains a %s location failure and sends nothing', async (code, message) => {
      locate.mockRejectedValue(new LocationError(code));
      await renderCard();
      await fireEvent.press(button(USE));
      expect(await screen.findByText(message)).toBeOnTheScreen();
      expect(screen.queryByTestId('dialog')).toBeNull();
      expect(posts()).toHaveLength(0);
    });

    it('gives the request button a 48pt touch target', async () => {
      await renderCard();
      expect(button(USE)).toHaveStyle({ minHeight: 48 });
    });
  });
});
