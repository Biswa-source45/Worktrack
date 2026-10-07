import { screen } from '@testing-library/react-native';
import TaskDetailScreen from '@/app/tasks/[id]/index';
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

const REVIEWER = { id: 9, name: 'Meera Das', emp_code: 'EMP-9' };
const reach = (
  over: Partial<NonNullable<ReturnType<typeof taskDetailBody>['assignees'][0]['reach']>>,
) => ({
  at: '2026-10-06T05:00:00Z',
  distance_m: 340,
  flags: ['location_mismatch' as const],
  reason: 'GPS drifts here',
  review: 'pending' as const,
  review_remarks: null,
  reviewed_by: null,
  reviewed_at: null,
  ...over,
});

beforeEach(async () => {
  jest.clearAllMocks();
  resetMemoryStore();
  resetSecureStore();
  await setTokens({ access: 'access-1', refresh: 'refresh-1' });
});

async function show(over: Parameters<typeof reach>[0]) {
  mockApi({
    'GET /api/v1/me': () => Response.json(meBody()),
    'GET /api/v1/tasks/41': () =>
      Response.json({
        ...taskDetailBody({}, 'reached'),
        assignees: taskDetailBody({}, 'reached', reach(over)).assignees,
      }),
  });
  await renderWithAuth(<TaskDetailScreen />);
  await screen.findByText('You reached the site');
}

describe('what the employee sees of the review of their Reached', () => {
  it('says "sent for review" while the review is waiting', async () => {
    await show({});
    expect(screen.getByText('at 6 Oct 2026, 10:30 am · sent for review')).toBeOnTheScreen();
    expect(screen.queryByText('Approved')).toBeNull();
    expect(screen.queryByText('Rejected')).toBeNull();
  });

  it('shows Approved with the reviewer note, and no longer says "sent for review"', async () => {
    await show({
      review: 'approved',
      review_remarks: 'Seen it, the gate is on the far side',
      reviewed_by: REVIEWER,
      reviewed_at: '2026-10-06T06:00:00Z',
    });
    expect(screen.getByText('Approved')).toBeOnTheScreen();
    expect(screen.getByText('Seen it, the gate is on the far side')).toBeOnTheScreen();
    expect(screen.getByText('at 6 Oct 2026, 10:30 am')).toBeOnTheScreen();
    expect(screen.queryByText(/sent for review/)).toBeNull();
  });

  it('shows Rejected with the reviewer note, and no longer says "sent for review"', async () => {
    await show({
      review: 'rejected',
      review_remarks: 'Not at the site',
      reviewed_by: REVIEWER,
      reviewed_at: '2026-10-06T06:00:00Z',
    });
    expect(screen.getByText('Rejected')).toBeOnTheScreen();
    expect(screen.getByText('Not at the site')).toBeOnTheScreen();
    expect(screen.queryByText(/sent for review/)).toBeNull();
    expect(screen.queryByText('Approved')).toBeNull();
  });

  it('shows the result even when the reviewer wrote no note', async () => {
    await show({ review: 'approved', reviewed_by: REVIEWER, reviewed_at: '2026-10-06T06:00:00Z' });
    expect(screen.getByText('Approved')).toBeOnTheScreen();
    expect(screen.getByText('Reviewed by Meera Das')).toBeOnTheScreen();
  });

  it('names who decided', async () => {
    await show({
      review: 'rejected',
      review_remarks: 'Not at the site',
      reviewed_by: REVIEWER,
      reviewed_at: '2026-10-06T06:00:00Z',
    });
    expect(screen.getByText(/Meera Das/)).toBeOnTheScreen();
  });

  it('shows nothing about a review for a clean Reached that needed none', async () => {
    await show({ flags: [], review: 'none', reason: null, distance_m: 12 });
    expect(screen.getByText('at 6 Oct 2026, 10:30 am')).toBeOnTheScreen();
    expect(screen.queryByText(/review/i)).toBeNull();
    expect(screen.queryByText('Approved')).toBeNull();
  });

  it('never shows a score or the word mismatch, whatever the decision', async () => {
    await show({
      flags: ['location_mismatch', 'face_review'],
      review: 'rejected',
      review_remarks: 'Not at the site',
      reviewed_by: REVIEWER,
      reviewed_at: '2026-10-06T06:00:00Z',
    });
    expect(screen.queryByText(/mismatch/i)).toBeNull();
    expect(screen.queryByText(/score/i)).toBeNull();
  });
});
