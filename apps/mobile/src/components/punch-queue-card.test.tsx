import { act, screen } from '@testing-library/react-native';
import { File, Paths } from 'expo-file-system';
import { PunchQueueCard } from '@/components/punch-queue-card';
import { enqueue, enqueueTask } from '@/lib/punch-queue';
import { setTokens } from '@/lib/token-store';
import { meBody, mockApi } from '@/test/fake-api';
import { resetMemoryStore } from '@/test/memory-queue-store';
import { renderWithAuth } from '@/test/render';
import { resetSecureStore } from '@/test/secure-store-mock';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const AT = '2026-10-06T04:30:00.000Z';

beforeEach(async () => {
  resetMemoryStore();
  resetSecureStore();
  await setTokens({ access: 'access-1', refresh: 'refresh-1' });
  mockApi({ 'GET /api/v1/me': () => Response.json(meBody()) });
});

describe('PunchQueueCard with saved task actions', () => {
  it('does not count a saved task action as a punch', async () => {
    await enqueueTask({
      id: 'task-1',
      userId: 1,
      taskId: 7,
      action: 'start',
      fields: {},
      photos: [],
      deviceTime: AT,
    });
    await renderWithAuth(<PunchQueueCard />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByTestId('punch-queue-card')).toBeNull();
  });

  it('counts only the punches when both are saved', async () => {
    const photo = new File(Paths.cache, 'card-mixed.jpg');
    photo.create({ overwrite: true });
    photo.write(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]));
    await enqueue({
      id: 'punch-1',
      userId: 1,
      kind: 'in',
      selfieUri: photo.uri,
      lat: 20.2961,
      lng: 85.8245,
      accuracyM: 10,
      mocked: false,
      emulator: false,
      rooted: false,
      deviceTime: AT,
    });
    await enqueueTask({
      id: 'task-1',
      userId: 1,
      taskId: 7,
      action: 'hold',
      fields: { reason: 'Lunch' },
      photos: [],
      deviceTime: AT,
    });
    await renderWithAuth(<PunchQueueCard />);
    expect(await screen.findByText('1 punch is waiting to be sent.')).toBeOnTheScreen();
  });
});
