import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { File, Paths } from 'expo-file-system';
import PunchQueueScreen from '@/app/punch/queue';
import { PunchQueueCard } from '@/components/punch-queue-card';
import { useAuth } from '@/lib/auth';
import { enqueue, getStore } from '@/lib/punch-queue';
import type { QueueKind } from '@/lib/punch-queue';
import { useQueueAutoSync } from '@/lib/punch-sync';
import { setTokens } from '@/lib/token-store';
import { calls, failure, meBody, mockApi, punchResultBody, recordForms } from '@/test/fake-api';
import { memoryStore, resetMemoryStore } from '@/test/memory-queue-store';
import { renderWithAuth } from '@/test/render';
import { resetSecureStore } from '@/test/secure-store-mock';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const ME = 'GET /api/v1/me';
const IN = 'POST /api/v1/attendance/punch-in';
const base = { [ME]: () => Response.json(meBody()) };

async function save(id: string, kind: QueueKind = 'in', at = '2026-10-05T03:30:00.000Z') {
  const photo = new File(Paths.cache, `queue-ui-${id}.jpg`);
  photo.create({ overwrite: true });
  photo.write(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]));
  await enqueue({
    id,
    userId: 1,
    kind,
    selfieUri: photo.uri,
    lat: 20.2961,
    lng: 85.8245,
    accuracyM: 10,
    mocked: false,
    emulator: false,
    rooted: false,
    deviceTime: at,
  });
}
const mark = async (id: string, patch: Parameters<typeof memoryStore.update>[1]) =>
  (await getStore()).update(id, patch);
const row = (id: string) => screen.getByTestId(`queue-row-${id}`);

// Mounts the sync triggers the way the tab layout does, so "Sync now" has an owner to sync for.
function Screen() {
  const { me } = useAuth();
  useQueueAutoSync(me?.id);
  return <PunchQueueScreen />;
}

beforeEach(async () => {
  jest.clearAllMocks();
  resetMemoryStore();
  resetSecureStore();
  await setTokens({ access: 'access-1', refresh: 'refresh-1' });
});

describe('PunchQueueScreen', () => {
  it('says so when nothing is saved', async () => {
    mockApi(base);
    await renderWithAuth(<PunchQueueScreen />);
    expect(await screen.findByText('No saved punches.')).toBeOnTheScreen();
  });

  it('lists each punch with its kind, the time it was taken in IST, and a status of icon, label and colour', async () => {
    await save('a', 'in', '2026-10-05T03:30:00.000Z');
    await save('b', 'out', '2026-10-05T12:45:00.000Z');
    await save('c', 'request', '2026-10-05T13:00:00.000Z');
    await mark('b', { status: 'syncing' });
    await mark('c', { status: 'synced' });
    mockApi(base);
    await renderWithAuth(<PunchQueueScreen />);

    const first = await screen.findByTestId('queue-row-a');
    expect(within(first).getByText('Punch in')).toBeOnTheScreen();
    expect(within(first).getByText('5 Oct 2026, 9:00 am')).toBeOnTheScreen();
    expect(within(first).getByText('Waiting to send')).toBeOnTheScreen();
    expect(within(row('b')).getByText('Punch out')).toBeOnTheScreen();
    expect(within(row('b')).getByText('5 Oct 2026, 6:15 pm')).toBeOnTheScreen();
    expect(within(row('b')).getByText('Sending')).toBeOnTheScreen();
    expect(within(row('c')).getByText('Punch-out request')).toBeOnTheScreen();
    expect(within(row('c')).getByText('Sent')).toBeOnTheScreen();
    // A sent punch has nothing left to retry or discard.
    expect(within(row('c')).queryByRole('button')).toBeNull();
  });

  it('shows why a punch was not sent, in the server words, and for one the phone cannot read', async () => {
    await save('refused');
    await save('unreadable');
    await save('echo');
    await mark('refused', {
      status: 'failed',
      error_code: 'OUTSIDE_GEOFENCE',
      error_message: 'You are 340 m away from Head Office.',
    });
    await mark('unreadable', { status: 'failed', error_code: 'UNREADABLE', error_message: null });
    await mark('echo', { status: 'failed', error_code: 'DAY_CLOSED', error_message: 'DAY_CLOSED' });
    mockApi(base);
    await renderWithAuth(<PunchQueueScreen />);

    expect(
      await screen.findByText('Not sent: You are 340 m away from Head Office.'),
    ).toBeOnTheScreen();
    expect(screen.getByText('Not sent: This saved punch could not be read.')).toBeOnTheScreen();
    expect(screen.getByText("Not sent: Today's attendance is closed.")).toBeOnTheScreen();
    expect(within(row('refused')).getByText('Not sent')).toBeOnTheScreen(); // the status badge
  });

  it('retries a failed punch: it goes back to queued with the reason cleared', async () => {
    await save('retry');
    await mark('retry', {
      status: 'failed',
      attempts: 5,
      error_code: 'INTERNAL',
      error_message: 'The server failed.',
    });
    mockApi(base);
    await renderWithAuth(<PunchQueueScreen />);
    await screen.findByText('Not sent: The server failed.');
    await fireEvent.press(screen.getByRole('button', { name: /^Retry the Punch in from/ }));

    await waitFor(() =>
      expect(within(row('retry')).getByText('Waiting to send')).toBeOnTheScreen(),
    );
    expect(screen.queryByText(/The server failed/)).toBeNull();
    expect((await (await getStore()).list(1))[0]).toMatchObject({ attempts: 0, error_code: null });
  });

  it('offers Retry only for a failed punch, and Discard for any that has not been sent', async () => {
    await save('queued');
    await save('failed');
    await mark('failed', { status: 'failed', error_code: 'X' });
    mockApi(base);
    await renderWithAuth(<PunchQueueScreen />);
    await screen.findByTestId('queue-row-queued');
    expect(within(row('queued')).queryByRole('button', { name: /Retry/ })).toBeNull();
    expect(within(row('queued')).getByRole('button', { name: /Discard/ })).toBeOnTheScreen();
    expect(within(row('failed')).getByRole('button', { name: /Retry/ })).toBeOnTheScreen();
    expect(within(row('failed')).getByRole('button', { name: /Discard/ })).toBeOnTheScreen();
  });

  it('asks before discarding, and keeps the punch when the employee cancels', async () => {
    await save('keep');
    mockApi(base);
    await renderWithAuth(<PunchQueueScreen />);
    await fireEvent.press(
      await screen.findByRole('button', { name: /^Discard the Punch in from/ }),
    );

    expect(screen.getByText('Discard this punch')).toBeOnTheScreen();
    expect(screen.getByText(/It will never be sent and cannot be recovered/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(await (await getStore()).list(1)).toHaveLength(1);
    expect(screen.getByTestId('queue-row-keep')).toBeOnTheScreen();
  });

  it('removes the punch for good when the discard is confirmed', async () => {
    await save('gone');
    mockApi(base);
    await renderWithAuth(<PunchQueueScreen />);
    await fireEvent.press(
      await screen.findByRole('button', { name: /^Discard the Punch in from/ }),
    );
    const dialog = screen.getByTestId('dialog');
    await fireEvent.press(within(dialog).getByRole('button', { name: 'Discard' }));

    expect(await screen.findByText('No saved punches.')).toBeOnTheScreen();
    expect(await (await getStore()).list(1)).toEqual([]);
    expect(await (await getStore()).payload('gone')).toBeNull();
  });

  it('sends the saved punches when Sync now is pressed once the server is back', async () => {
    await save('later');
    let up = false;
    mockApi({
      ...base,
      [IN]: () => {
        if (!up) throw new TypeError('Network request failed');
        return Response.json(punchResultBody(), { status: 201 });
      },
    });
    const form = recordForms();
    await renderWithAuth(<Screen />);
    // The run at start-up finds the server down: the punch stays queued.
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/punch-in'))).toBe(true));
    await waitFor(() =>
      expect(within(row('later')).getByText('Waiting to send')).toBeOnTheScreen(),
    );

    up = true;
    await fireEvent.press(screen.getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(within(row('later')).getByText('Sent')).toBeOnTheScreen());
    // Offline punches go out with the key they were saved under.
    const sends = calls.filter((call) => call.url.endsWith('/punch-in'));
    expect(sends.at(-1)?.headers.get('Idempotency-Key')).toBe('later');
    expect(form.fields().offline).toBe('true');
    form.restore();
  });

  it('shows the failure the server gave when a sync is refused', async () => {
    await save('refused');
    mockApi({
      ...base,
      [IN]: () => failure(422, 'OUTSIDE_GEOFENCE', 'You are 340 m away from Head Office.'),
    });
    const form = recordForms();
    await renderWithAuth(<Screen />);
    expect(
      await screen.findByText('Not sent: You are 340 m away from Head Office.'),
    ).toBeOnTheScreen();
    form.restore();
  });

  it('says when the saved punches cannot be read from the phone', async () => {
    mockApi(base);
    const list = jest.spyOn(memoryStore, 'list').mockRejectedValue(new Error('disk full'));
    await renderWithAuth(<PunchQueueScreen />);
    expect(
      await screen.findByText('Could not read the saved punches on this phone.'),
    ).toBeOnTheScreen();
    expect(screen.getByText('Error: disk full')).toBeOnTheScreen();
    list.mockRestore();
  });
});

describe('PunchQueueCard', () => {
  it('is not there while nothing is saved', async () => {
    mockApi(base);
    await renderWithAuth(<PunchQueueCard />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByTestId('punch-queue-card')).toBeNull();
  });

  it('counts the punches waiting and the ones that failed, and opens the list', async () => {
    await save('a');
    await save('b');
    await save('c');
    await mark('c', { status: 'failed', error_code: 'X' });
    mockApi(base);
    await renderWithAuth(<PunchQueueCard />);
    expect(await screen.findByText('2 punches are waiting to be sent.')).toBeOnTheScreen();
    expect(screen.getByText('1 punch could not be sent.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'View saved punches' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/punch/queue');
  });

  it('uses the singular for one punch', async () => {
    await save('only');
    mockApi(base);
    await renderWithAuth(<PunchQueueCard />);
    expect(await screen.findByText('1 punch is waiting to be sent.')).toBeOnTheScreen();
  });
});
