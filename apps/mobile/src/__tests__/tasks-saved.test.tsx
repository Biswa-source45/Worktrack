import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import TaskDetailScreen from '@/app/tasks/[id]/index';
import { getStore, notifyQueueChange } from '@/lib/punch-queue';
import { setTokens } from '@/lib/token-store';
import { meBody, mockApi, taskDetailBody } from '@/test/fake-api';
import { resetMemoryStore } from '@/test/memory-queue-store';
import { renderWithAuth } from '@/test/render';
import { resetSecureStore } from '@/test/secure-store-mock';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useFocusEffect: jest.fn(),
  useLocalSearchParams: () => ({ id: '41' }),
}));
jest.mock(
  'react-native-maps',
  () => {
    throw new Error("Cannot find module 'react-native-maps'");
  },
  { virtual: true },
);

const SAVED = 'Saved on this phone. It will be sent when you are back online.';
const offline = () => {
  throw new TypeError('Network request failed');
};

beforeEach(async () => {
  jest.clearAllMocks();
  resetMemoryStore();
  resetSecureStore();
  await setTokens({ access: 'access-1', refresh: 'refresh-1' });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

async function openOffline() {
  mockApi({
    'GET /api/v1/me': () => Response.json(meBody()),
    'GET /api/v1/tasks/41': () => Response.json(taskDetailBody({}, 'assigned')),
    'POST /api/v1/tasks/41/accept': offline,
    'GET /health': offline,
  });
  await renderWithAuth(<TaskDetailScreen />);
  await screen.findByRole('header', { name: 'Inspect the pump house' });
}

describe('"Saved on this phone" on the task screen', () => {
  it('goes away once the saved action has been sent, even after several taps on Accept', async () => {
    await openOffline();
    const accept = () => screen.getByRole('button', { name: 'Accept task' });
    await fireEvent.press(accept());
    expect(await screen.findByText(SAVED)).toBeOnTheScreen();
    await fireEvent.press(accept());
    await fireEvent.press(accept());

    // One saved Accept, however often it was tapped.
    const store = await getStore();
    const rows = await store.list(1);
    expect(rows).toHaveLength(1);
    expect(screen.getByText(SAVED)).toBeOnTheScreen();

    // Back online: the saved action is sent and the queue marks it sent.
    await act(async () => {
      await store.update(rows[0].id, { status: 'synced', wipe: true });
      notifyQueueChange();
    });
    await waitFor(() => expect(screen.queryByText(SAVED)).toBeNull());
  });

  it('goes away when the saved action failed: it is no longer waiting to be sent', async () => {
    await openOffline();
    await fireEvent.press(screen.getByRole('button', { name: 'Accept task' }));
    expect(await screen.findByText(SAVED)).toBeOnTheScreen();

    const store = await getStore();
    const [row] = await store.list(1);
    await act(async () => {
      await store.update(row.id, { status: 'failed', error_code: 'TASK_NOT_FOUND' });
      notifyQueueChange();
    });
    await waitFor(() => expect(screen.queryByText(SAVED)).toBeNull());
  });
});
