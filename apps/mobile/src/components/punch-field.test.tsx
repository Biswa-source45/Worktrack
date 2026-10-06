import { fireEvent, screen } from '@testing-library/react-native';
import PunchResultScreen from '@/app/punch/result';
import { PunchCard } from '@/components/punch-card';
import { getCurrentFix } from '@/lib/location';
import { endFlow, finishAttempt } from '@/lib/punch-flow';
import { mockApi, precheckBody, punchBody, punchResultBody, todayBody } from '@/test/fake-api';
import { renderWithTheme } from '@/test/render';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useFocusEffect: jest.fn(),
}));
jest.mock('@/lib/location', () => ({
  ...jest.requireActual('@/lib/location'),
  getCurrentFix: jest.fn(),
}));

const TODAY = 'GET /api/v1/attendance/today';
const PRECHECK = 'POST /api/v1/attendance/precheck';
const FIX = { lat: 20.3547, lng: 85.8197, accuracyM: 9, mocked: false };
const TASK_PLACE = { type: 'task', task: 'T-00041', distance_m: 35 } as const;

beforeEach(() => {
  jest.clearAllMocks();
  endFlow();
  jest.mocked(getCurrentFix).mockResolvedValue(FIX);
});

describe('Field punch-in on the punch card', () => {
  it('says which task the punch would be for when the server places it at a task site', async () => {
    mockApi({
      [TODAY]: () => Response.json(todayBody()),
      [PRECHECK]: () => Response.json(precheckBody({ place: TASK_PLACE, nearest_branch: null })),
    });
    await renderWithTheme(<PunchCard />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Punch in' }));
    expect(await screen.findByTestId('punch-field')).toHaveTextContent('Field punch-in at T-00041');
    expect(mockRouter.push).toHaveBeenCalledWith('/punch/capture');
  });

  it('says nothing about a task for a branch punch', async () => {
    mockApi({
      [TODAY]: () => Response.json(todayBody()),
      [PRECHECK]: () => Response.json(precheckBody()),
    });
    await renderWithTheme(<PunchCard />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Punch in' }));
    await screen.findByTestId('punch-away');
    expect(screen.queryByTestId('punch-field')).toBeNull();
  });

  it('marks a punch already made at a task site in the day list', async () => {
    mockApi({
      [TODAY]: () =>
        Response.json(
          todayBody({ action: 'punch_out', punches: [punchBody({ place: TASK_PLACE })] }),
        ),
    });
    await renderWithTheme(<PunchCard />);
    expect(
      await screen.findByText('Punch in 9:05 am (Field punch-in at T-00041)'),
    ).toBeOnTheScreen();
  });
});

describe('Field punch-in on the result screen', () => {
  it('names the task on a counted field punch-in', async () => {
    finishAttempt({
      type: 'sent',
      kind: 'in',
      result: punchResultBody({ punch: punchBody({ place: TASK_PLACE }) }),
    });
    await renderWithTheme(<PunchResultScreen />);
    expect(screen.getByRole('header', { name: 'Punched in' })).toBeOnTheScreen();
    expect(screen.getByText('Field punch-in at T-00041')).toBeOnTheScreen();
  });

  it('shows no task line for a branch punch', async () => {
    finishAttempt({ type: 'sent', kind: 'in', result: punchResultBody() });
    await renderWithTheme(<PunchResultScreen />);
    expect(screen.queryByText(/Field punch-in/)).toBeNull();
  });
});
