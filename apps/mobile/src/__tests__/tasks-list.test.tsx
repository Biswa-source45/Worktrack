import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import TasksScreen from '@/app/(app)/tasks';
import { enqueueTask } from '@/lib/punch-queue';
import { setTokens } from '@/lib/token-store';
import { calls, failure, meBody, mockApi, myTaskBody } from '@/test/fake-api';
import { resetMemoryStore } from '@/test/memory-queue-store';
import { renderWithAuth } from '@/test/render';
import { resetSecureStore } from '@/test/secure-store-mock';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useFocusEffect: jest.fn(),
}));

const ME = 'GET /api/v1/me';
const MINE = 'GET /api/v1/me/tasks';
const ASSIGNED = 'GET /api/v1/tasks';
const me =
  (permissions: string[] = []) =>
  () =>
    Response.json(meBody({ permissions }));
const page =
  (items: unknown[], next_cursor: string | null = null) =>
  () =>
    Response.json({ items, next_cursor });
const pill = (name: string) => screen.getByRole('button', { name });

beforeEach(async () => {
  jest.clearAllMocks();
  resetMemoryStore();
  resetSecureStore();
  await setTokens({ access: 'access-1', refresh: 'refresh-1' });
});

describe('Tasks tab', () => {
  it('lists my active tasks with code, title, client, time, address and a status of icon, label and colour', async () => {
    mockApi({
      [ME]: me(),
      [MINE]: page([
        myTaskBody({}, 'assigned'),
        myTaskBody(
          { id: 42, code: 'T-00042', title: 'Replace the meter', priority: 'urgent' },
          'in_progress',
        ),
      ]),
    });
    await renderWithAuth(<TasksScreen />);

    const first = await screen.findByTestId('task-41');
    expect(first).toHaveTextContent(/T\-00041/);
    expect(first).toHaveTextContent(/Inspect the pump house/);
    expect(first).toHaveTextContent(/Acme Water/);
    expect(first).toHaveTextContent(/6 Oct 2026, 11:00 am/);
    expect(first).toHaveTextContent(/Plot 4, Patia, Bhubaneswar/);
    expect(first).toHaveTextContent(/Assigned/);
    expect(screen.getByTestId('task-42')).toHaveTextContent(/In progress/);
    expect(screen.getByTestId('task-42')).toHaveTextContent(/Urgent/);
    expect(
      new URL(calls.find((call) => call.url.includes('/me/tasks'))!.url).searchParams.get('state'),
    ).toBe('active');
  });

  it('opens the task when a card is pressed', async () => {
    mockApi({ [ME]: me(), [MINE]: page([myTaskBody()]) });
    await renderWithAuth(<TasksScreen />);
    await fireEvent.press(
      await screen.findByRole('button', { name: /T-00041, Inspect the pump house/ }),
    );
    expect(mockRouter.push).toHaveBeenCalledWith('/tasks/41');
  });

  it('shows Done tasks when asked, and says so when there are none', async () => {
    mockApi({
      [ME]: me(),
      [MINE]: (request: Request) =>
        new URL(request.url).searchParams.get('state') === 'done'
          ? Response.json({ items: [], next_cursor: null })
          : Response.json({ items: [myTaskBody()], next_cursor: null }),
    });
    await renderWithAuth(<TasksScreen />);
    await screen.findByTestId('task-41');
    await fireEvent.press(pill('Done'));
    expect(await screen.findByText('No finished tasks yet.')).toBeOnTheScreen();
    expect(screen.queryByTestId('task-41')).toBeNull();
  });

  it('says so when there are no active tasks', async () => {
    mockApi({ [ME]: me(), [MINE]: page([]) });
    await renderWithAuth(<TasksScreen />);
    expect(await screen.findByText('No active tasks.')).toBeOnTheScreen();
  });

  it('shows the server reason and a Retry when the list cannot be loaded', async () => {
    let fail = true;
    mockApi({
      [ME]: me(),
      [MINE]: () =>
        fail
          ? failure(500, 'INTERNAL', 'The task list is down.')
          : Response.json({ items: [myTaskBody()], next_cursor: null }),
    });
    await renderWithAuth(<TasksScreen />);
    expect(await screen.findByText('The task list is down.')).toBeOnTheScreen();
    fail = false;
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('task-41')).toBeOnTheScreen();
  });

  it('loads the next page on Load more', async () => {
    mockApi({
      [ME]: me(),
      [MINE]: (request: Request) =>
        new URL(request.url).searchParams.get('cursor') === 'c2'
          ? Response.json({ items: [myTaskBody({ id: 43, code: 'T-00043' })], next_cursor: null })
          : Response.json({ items: [myTaskBody()], next_cursor: 'c2' }),
    });
    await renderWithAuth(<TasksScreen />);
    await screen.findByTestId('task-41');
    await fireEvent.press(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByTestId('task-43')).toBeOnTheScreen();
  });

  it('offers no Assigned by me to an employee without task permissions', async () => {
    mockApi({ [ME]: me(), [MINE]: page([myTaskBody()]) });
    await renderWithAuth(<TasksScreen />);
    await screen.findByTestId('task-41');
    expect(screen.queryByRole('button', { name: 'Assigned by me' })).toBeNull();
  });

  it('shows an assigner the tasks they assigned, read-only, with who they are assigned to', async () => {
    mockApi({
      [ME]: me(['tasks.create']),
      [MINE]: page([]),
      [ASSIGNED]: page([
        {
          id: 50,
          code: 'T-00050',
          title: 'Survey the depot',
          type: myTaskBody().type,
          client_name: 'Beta Corp',
          site: myTaskBody().site,
          priority: 'normal',
          scheduled_at: '2026-10-07T05:30:00Z',
          status: 'accepted',
          created_by: { id: 1, name: 'Asha Rao', emp_code: 'EMP-7' },
          assignees: [
            {
              user: { id: 9, name: 'Ravi Kumar', emp_code: 'EMP-9' },
              status: 'accepted',
              escalated: false,
              reach_review: 'none',
            },
          ],
        },
      ]),
    });
    await renderWithAuth(<TasksScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Assigned by me' }));

    const card = await screen.findByTestId('task-50');
    expect(card).toHaveTextContent(/Survey the depot/);
    expect(card).toHaveTextContent(/Ravi Kumar/);
    expect(card).toHaveTextContent(/Accepted/);
    const asked = new URL(calls.find((call) => call.url.includes('/api/v1/tasks?'))!.url)
      .searchParams;
    expect(asked.get('view')).toBe('assigned_by_me');
  });

  it('says how many task updates are saved on the phone and links to them', async () => {
    mockApi({ [ME]: me(), [MINE]: page([myTaskBody()]) });
    await enqueueTask({
      id: 'saved-1',
      userId: 1,
      taskId: 41,
      action: 'accept',
      fields: {},
      photos: [],
      deviceTime: '2026-10-06T04:30:00.000Z',
    });
    await renderWithAuth(<TasksScreen />);
    expect(
      await screen.findByText('1 task update is saved on this phone and waiting to be sent.'),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'View saved items' }));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/punch/queue'));
  });
});
