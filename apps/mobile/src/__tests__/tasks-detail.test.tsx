import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import * as Crypto from 'expo-crypto';
import { Linking } from 'react-native';
import TaskDetailScreen from '@/app/tasks/[id]/index';
import { LocationError, getCurrentFix } from '@/lib/location';
import { getStore } from '@/lib/punch-queue';
import { currentReach, endReach } from '@/lib/task-flow';
import { setTokens } from '@/lib/token-store';
import { calls, failure, meBody, mockApi, recordForms, taskDetailBody } from '@/test/fake-api';
import { resetMemoryStore } from '@/test/memory-queue-store';
import { renderWithAuth } from '@/test/render';
import { resetSecureStore } from '@/test/secure-store-mock';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useFocusEffect: jest.fn(),
  useLocalSearchParams: () => ({ id: '41' }),
}));
jest.mock('@/lib/location', () => ({
  ...jest.requireActual('@/lib/location'),
  getCurrentFix: jest.fn(),
}));
// The current build has no native map: the site then shows as an address.
jest.mock(
  'react-native-maps',
  () => {
    throw new Error("Cannot find module 'react-native-maps'");
  },
  { virtual: true },
);

const ME = 'GET /api/v1/me';
const ONE = 'GET /api/v1/tasks/41';
const action = (name: string) => `POST /api/v1/tasks/41/${name}`;
const FIX = { lat: 20.3547, lng: 85.8197, accuracyM: 9, mocked: false };
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const queryButton = (name: string | RegExp) => screen.queryByRole('button', { name });
const base = { [ME]: () => Response.json(meBody()) };
const detail =
  (status: string, over: Parameters<typeof taskDetailBody>[0] = {}) =>
  () =>
    Response.json(taskDetailBody(over, status));
const answer = (status: string) => () =>
  Response.json({ task: taskDetailBody({}, status), replayed: false }, { status: 200 });

async function open(status: string, routes: Parameters<typeof mockApi>[0] = {}) {
  mockApi({ ...base, [ONE]: detail(status), ...routes });
  await renderWithAuth(<TaskDetailScreen />);
  await screen.findByRole('header', { name: 'Inspect the pump house' });
}

let forms: ReturnType<typeof recordForms>;
let warn: jest.SpyInstance;
const open_ = jest.spyOn(Linking, 'openURL');

beforeEach(async () => {
  jest.clearAllMocks();
  resetMemoryStore();
  resetSecureStore();
  endReach();
  jest.mocked(getCurrentFix).mockResolvedValue(FIX);
  open_.mockResolvedValue(true);
  await setTokens({ access: 'access-1', refresh: 'refresh-1' });
  forms = recordForms();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  forms.restore();
  warn.mockRestore();
});

describe('Task detail: what is shown', () => {
  it('shows the task, its status, the client, the time, the details and the site address', async () => {
    await open('assigned');
    expect(screen.getByTestId('task-status')).toHaveTextContent(/Assigned/);
    expect(screen.getByText('T-00041 · Site Visit')).toBeOnTheScreen();
    expect(screen.getByText('Acme Water')).toBeOnTheScreen();
    expect(screen.getByText('6 Oct 2026, 11:00 am')).toBeOnTheScreen();
    expect(screen.getByText('90 minutes')).toBeOnTheScreen();
    expect(screen.getByText('Check the valves and photograph the meter.')).toBeOnTheScreen();
    // No native map in this build: the address stands in, and nothing crashes.
    expect(screen.getByText('Plot 4, Patia, Bhubaneswar')).toBeOnTheScreen();
    expect(screen.getByText(/within 200 metres/)).toBeOnTheScreen();
  });

  it('opens directions to the site and the dialler for the contact', async () => {
    await open('accepted');
    await fireEvent.press(button('Navigate to the site'));
    expect(open_).toHaveBeenCalledWith(
      'https://www.google.com/maps/dir/?api=1&destination=20.3547,85.8197&travelmode=driving',
    );
    await fireEvent.press(button('Call Ravi Kumar'));
    expect(open_).toHaveBeenLastCalledWith('tel:+919876543210');
  });

  it('says so when no app on the phone can open the link', async () => {
    await open('accepted');
    open_.mockRejectedValue(new Error('no app'));
    await fireEvent.press(button('Call Ravi Kumar'));
    expect(await screen.findByText('No app on this phone could open that.')).toBeOnTheScreen();
  });

  it('opens a brief attachment through its absolute signed link', async () => {
    await open('assigned', {
      [ONE]: detail('assigned', {
        attachments: [
          {
            id: 7,
            kind: 'brief',
            filename: 'site-plan.pdf',
            content_type: 'application/pdf',
            size: 1200,
            uploaded_by: { id: 5, name: 'Meera Nair', emp_code: 'EMP-2' },
            created_at: '2026-10-05T10:00:00Z',
            url: '/api/v1/files/abc123',
          },
          {
            id: 8,
            kind: 'work_photo',
            filename: 'other.jpg',
            content_type: 'image/jpeg',
            size: 10,
            uploaded_by: { id: 1, name: 'Asha Rao', emp_code: 'EMP-7' },
            created_at: '2026-10-05T10:00:00Z',
            url: '/api/v1/files/zzz',
          },
        ],
      }),
    });
    await fireEvent.press(button('site-plan.pdf'));
    expect(open_).toHaveBeenCalledWith('https://api.test/api/v1/files/abc123');
    expect(queryButton('other.jpg')).toBeNull();
  });

  it('shows the comments and an Add a comment button that opens the comment form', async () => {
    await open('in_progress', {
      [ONE]: detail('in_progress', {
        comments: [
          {
            id: 1,
            author: { id: 5, name: 'Meera Nair', emp_code: 'EMP-2' },
            body: 'Please send the meter photo.',
            created_at: '2026-10-06T06:00:00Z',
            attachment: null,
          },
        ],
      }),
    });
    expect(screen.getByText('Please send the meter photo.')).toBeOnTheScreen();
    await fireEvent.press(button('Add a comment'));
    expect(mockRouter.push).toHaveBeenCalledWith('/tasks/41/compose?mode=comment');
  });

  it('shows the timeline with who did what and what was sent later from the phone', async () => {
    await open('accepted', {
      [ONE]: detail('accepted', {
        events: [
          {
            id: 1,
            event: 'accepted',
            at: '2026-10-06T04:30:00Z',
            actor: { id: 1, name: 'Asha Rao', emp_code: 'EMP-7' },
            subject: { id: 1, name: 'Asha Rao', emp_code: 'EMP-7' },
            note: null,
            offline: true,
          },
        ],
      }),
    });
    // Once as the status, once as the timeline entry.
    expect(screen.getAllByText('Accepted')).toHaveLength(2);
    expect(
      screen.getByText(/Asha Rao · 6 Oct 2026, 10:00 am · sent later from the phone/),
    ).toBeOnTheScreen();
  });

  it('says what the employee reached, "sent for review" when flagged, and never a score', async () => {
    await open('reached', {
      [ONE]: detail('reached', {
        assignees: taskDetailBody({}, 'reached', {
          at: '2026-10-06T05:00:00Z',
          distance_m: 340,
          flags: ['location_mismatch', 'face_review'],
          reason: 'GPS drifts here',
          review: 'pending',
          review_remarks: null,
          reviewed_by: null,
          reviewed_at: null,
        }).assignees,
      }),
    });
    expect(screen.getByText('You reached the site')).toBeOnTheScreen();
    expect(screen.getByText('at 6 Oct 2026, 10:30 am · sent for review')).toBeOnTheScreen();
    expect(screen.queryByText(/mismatch/i)).toBeNull();
    expect(screen.queryByText(/score/i)).toBeNull();
  });

  it('shows the real reason and a Retry when the task cannot be loaded', async () => {
    mockApi({ ...base, [ONE]: () => failure(404, 'NOT_FOUND', 'Task not found.') });
    await renderWithAuth(<TaskDetailScreen />);
    expect(await screen.findByText('Task not found.')).toBeOnTheScreen();
    expect(screen.getByText('404 NOT_FOUND')).toBeOnTheScreen();
    expect(button('Retry')).toBeOnTheScreen();
  });

  it('shows an assigner who is not on the task the assignees and no action buttons', async () => {
    await open('accepted', {
      [ME]: () => Response.json(meBody({ id: 5, permissions: ['tasks.create'] })),
    });
    expect(screen.getByText('Assigned to')).toBeOnTheScreen();
    expect(screen.getByText('Asha Rao (EMP-7)')).toBeOnTheScreen();
    expect(screen.queryByTestId('task-actions')).toBeNull();
    expect(queryButton('I have reached')).toBeNull();
  });
});

describe('Task detail: the buttons of each status', () => {
  const OFFERED: [string, string[]][] = [
    ['assigned', ['Accept task', 'Decline task']],
    ['accepted', ['I have reached']],
    ['reached', ['Start work', 'Add a note']],
    ['in_progress', ['Put on hold', 'Add a note', 'Complete task']],
    ['on_hold', ['Resume work', 'Add a note']],
  ];
  it.each(OFFERED)('%s offers exactly its next steps', async (status, expected) => {
    await open(status);
    const card = within(screen.getByTestId('task-actions'));
    const labels = card.getAllByRole('button').map((item) => item.props.accessibilityLabel);
    expect(labels).toEqual(expected);
  });

  it.each(['completed', 'declined', 'cancelled', 'closed'])(
    '%s offers no next step',
    async (status) => {
      await open(status);
      expect(screen.queryByTestId('task-actions')).toBeNull();
    },
  );

  it('shows why the employee declined', async () => {
    await open('declined', {
      [ONE]: detail('declined', {
        assignees: taskDetailBody({}, 'declined').assignees.map((a) => ({
          ...a,
          declined_reason: 'On leave that day',
        })),
      }),
    });
    expect(screen.getByText('You declined this task: On leave that day')).toBeOnTheScreen();
  });
});

describe('Task detail: accept, decline, start, hold, resume', () => {
  it('accepts with an idempotency key, then offers the next step from the server answer', async () => {
    await open('assigned', { [action('accept')]: answer('accepted') });
    await fireEvent.press(button('Accept task'));
    expect(await screen.findByRole('button', { name: 'I have reached' })).toBeOnTheScreen();

    const sent = calls.find((call) => call.url.endsWith('/tasks/41/accept'));
    expect(sent?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(forms.fields()).toMatchObject({ offline: 'false' });
    expect(new Date(forms.fields().device_time as string).getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
    expect(screen.getByTestId('task-status')).toHaveTextContent(/Accepted/);
  });

  it('declines with a reason of 3 to 200 characters, and shows that it was declined', async () => {
    await open('assigned', { [action('decline')]: answer('declined') });
    await fireEvent.press(button('Decline task'));
    const dialog = within(screen.getByTestId('dialog'));

    await fireEvent.press(dialog.getByRole('button', { name: 'Decline task' }));
    expect(await dialog.findByText('Give a reason of at least 3 characters.')).toBeOnTheScreen();
    expect(calls.some((call) => call.url.endsWith('/decline'))).toBe(false);

    await fireEvent.changeText(dialog.getByLabelText('Reason'), 'On leave');
    await fireEvent.press(dialog.getByRole('button', { name: 'Decline task' }));
    await waitFor(() => expect(screen.queryByTestId('dialog')).toBeNull());
    expect(forms.fields()).toMatchObject({ reason: 'On leave', offline: 'false' });
    expect(screen.getByTestId('task-status')).toHaveTextContent(/Declined/);
  });

  it('keeps the dialog open and shows the server reason and code when decline is refused', async () => {
    await open('assigned', {
      [action('decline')]: () =>
        failure(409, 'INVALID_TRANSITION', 'The task was cancelled by the assigner.'),
    });
    await fireEvent.press(button('Decline task'));
    const dialog = within(screen.getByTestId('dialog'));
    await fireEvent.changeText(dialog.getByLabelText('Reason'), 'On leave');
    await fireEvent.press(dialog.getByRole('button', { name: 'Decline task' }));

    expect(await dialog.findByText('The task was cancelled by the assigner.')).toBeOnTheScreen();
    expect(dialog.getByText('409 INVALID_TRANSITION')).toBeOnTheScreen();
  });

  it('starts work, holds with a reason and resumes', async () => {
    await open('reached', { [action('start')]: answer('in_progress') });
    await fireEvent.press(button('Start work'));
    expect(await screen.findByRole('button', { name: 'Put on hold' })).toBeOnTheScreen();

    mockApi({ ...base, [ONE]: detail('in_progress'), [action('hold')]: answer('on_hold') });
    await fireEvent.press(button('Put on hold'));
    const dialog = within(screen.getByTestId('dialog'));
    await fireEvent.changeText(dialog.getByLabelText('Reason'), 'Waiting for the client');
    await fireEvent.press(dialog.getByRole('button', { name: 'Put on hold' }));
    expect(await screen.findByRole('button', { name: 'Resume work' })).toBeOnTheScreen();
    expect(forms.fields()).toMatchObject({ reason: 'Waiting for the client' });

    mockApi({ ...base, [ONE]: detail('on_hold'), [action('resume')]: answer('in_progress') });
    await fireEvent.press(button('Resume work'));
    expect(await screen.findByRole('button', { name: 'Complete task' })).toBeOnTheScreen();
  });

  it('shows the server message with its status and code when an action is refused', async () => {
    await open('assigned', {
      [action('accept')]: () => failure(409, 'INVALID_TRANSITION', 'The task was cancelled.'),
    });
    await fireEvent.press(button('Accept task'));
    expect(await screen.findByText('The task was cancelled.')).toBeOnTheScreen();
    expect(screen.getByText('409 INVALID_TRANSITION')).toBeOnTheScreen();
    expect(await (await getStore()).list(1)).toEqual([]); // a refusal is not saved for later
  });

  it('saves the action on the phone when there is no connection, and says so', async () => {
    await open('assigned', {
      [action('accept')]: () => {
        throw new TypeError('Network request failed');
      },
      'GET /health': () => {
        throw new TypeError('Network request failed');
      },
    });
    await fireEvent.press(button('Accept task'));
    expect(
      await screen.findByText('Saved on this phone. It will be sent when you are back online.'),
    ).toBeOnTheScreen();
    expect(await (await getStore()).list(1)).toEqual([
      expect.objectContaining({ kind: 'task_accept', status: 'queued' }),
    ]);
  });

  it('sends the same key again when a send is retried after a server error', async () => {
    jest
      .mocked(Crypto.randomUUID)
      .mockReturnValueOnce('cccccccc-0000-4000-8000-000000000001')
      .mockReturnValueOnce('cccccccc-0000-4000-8000-000000000002');
    let first = true;
    await open('assigned', {
      [action('accept')]: () => {
        if (first) {
          first = false;
          return failure(503, 'HTTP_503', 'The server is busy.');
        }
        return Response.json({ task: taskDetailBody({}, 'accepted'), replayed: false });
      },
    });
    await fireEvent.press(button('Accept task'));
    expect(await screen.findByText('The server is busy.')).toBeOnTheScreen();
    await fireEvent.press(button('Accept task'));
    expect(await screen.findByRole('button', { name: 'I have reached' })).toBeOnTheScreen();

    const keys = calls
      .filter((call) => call.url.endsWith('/tasks/41/accept'))
      .map((call) => call.headers.get('Idempotency-Key'));
    expect(keys).toEqual([
      'cccccccc-0000-4000-8000-000000000001',
      'cccccccc-0000-4000-8000-000000000001',
    ]);
  });
});

describe('Task detail: note, complete and I have reached', () => {
  it('opens the note form and the completion form', async () => {
    await open('in_progress');
    await fireEvent.press(button('Add a note'));
    expect(mockRouter.push).toHaveBeenLastCalledWith('/tasks/41/compose?mode=note');
    await fireEvent.press(button('Complete task'));
    expect(mockRouter.push).toHaveBeenLastCalledWith('/tasks/41/compose?mode=complete');
  });

  it('takes the position and the phone checks, then opens the selfie screen', async () => {
    await open('accepted');
    await fireEvent.press(button('I have reached'));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/tasks/41/reach'));
    expect(currentReach()).toEqual({
      taskId: 41,
      fix: FIX,
      integrity: { emulator: false, rooted: false },
    });
  });

  it('says why when the position cannot be found, and opens nothing', async () => {
    jest.mocked(getCurrentFix).mockRejectedValue(new LocationError('services_off'));
    await open('accepted');
    await fireEvent.press(button('I have reached'));
    expect(
      await screen.findByText('Location is turned off on this phone. Turn it on and try again.'),
    ).toBeOnTheScreen();
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(currentReach()).toBeNull();
  });

  it('shows progress while a send is slow', async () => {
    let release: (response: Response) => void = () => undefined;
    await open('assigned', {
      [action('accept')]: () => new Promise<Response>((resolve) => (release = resolve)),
    });
    await fireEvent.press(button('Accept task'));
    expect(
      await screen.findByText('Sending. This can take a moment on a slow connection.'),
    ).toBeOnTheScreen();
    await act(async () =>
      release(Response.json({ task: taskDetailBody({}, 'accepted'), replayed: false })),
    );
    expect(await screen.findByRole('button', { name: 'I have reached' })).toBeOnTheScreen();
  });
});
