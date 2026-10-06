import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import ComposeScreen from '@/app/tasks/[id]/compose';
import { getStore, openTaskPayload } from '@/lib/punch-queue';
import { setTokens } from '@/lib/token-store';
import { calls, failure, meBody, mockApi, recordForms, taskDetailBody } from '@/test/fake-api';
import { resetMemoryStore } from '@/test/memory-queue-store';
import { renderWithAuth } from '@/test/render';
import { resetSecureStore } from '@/test/secure-store-mock';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
const mockParams = { id: '41', mode: 'note' };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useFocusEffect: jest.fn(),
  useLocalSearchParams: () => mockParams,
}));

const mockCamera = { uris: [] as string[] };
// There is no camera in Jest: this stands in for the back camera, taking the next prepared photo.
jest.mock('@/components/photo-camera', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    PhotoCamera: ({
      onPhoto,
      onCancel,
    }: {
      onPhoto: (uri: string) => void;
      onCancel: () => void;
    }) =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Text, null, 'back camera'),
        React.createElement(Pressable, {
          accessibilityRole: 'button',
          accessibilityLabel: 'Shutter',
          onPress: () => onPhoto(mockCamera.uris.shift() ?? ''),
        }),
        React.createElement(Pressable, {
          accessibilityRole: 'button',
          accessibilityLabel: 'Close camera',
          onPress: onCancel,
        }),
      ),
  };
});

const ONE = 'GET /api/v1/tasks/41';
const base = { 'GET /api/v1/me': () => Response.json(meBody()) };
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const queryButton = (name: string | RegExp) => screen.queryByRole('button', { name });
const type = (over: Partial<ReturnType<typeof taskDetailBody>['type']> = {}) =>
  taskDetailBody({ type: { ...taskDetailBody().type, ...over } }, 'in_progress');
const answer = () => Response.json({ task: taskDetailBody({}, 'in_progress'), replayed: false });

/** Prepares photos in the phone cache for the camera to hand over, one per shutter press. */
function photos(...names: string[]) {
  return names.map((name) => {
    const file = new File(Paths.cache, name);
    file.create({ overwrite: true });
    file.write(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]));
    mockCamera.uris.push(file.uri);
    return file;
  });
}

async function open(
  mode: string,
  task: ReturnType<typeof taskDetailBody> = type(),
  routes: Parameters<typeof mockApi>[0] = {},
) {
  mockParams.mode = mode;
  mockApi({ ...base, [ONE]: () => Response.json(task), ...routes });
  await renderWithAuth(<ComposeScreen />);
  await screen.findByText('T-00041 · Inspect the pump house');
}
const shoot = async () => {
  await fireEvent.press(button('Take a photo'));
  await fireEvent.press(await screen.findByRole('button', { name: 'Shutter' }));
};
const write = (label: string, text: string) =>
  fireEvent.changeText(screen.getByLabelText(label), text);

let forms: ReturnType<typeof recordForms>;
let warn: jest.SpyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  mockCamera.uris = [];
  resetMemoryStore();
  resetSecureStore();
  await setTokens({ access: 'access-1', refresh: 'refresh-1' });
  forms = recordForms();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  forms.restore();
  warn.mockRestore();
});

describe('Add a note', () => {
  it('needs some text, and sends nothing without it', async () => {
    await open('note');
    await fireEvent.press(button('Save note'));
    expect(await screen.findByText('This field is required.')).toBeOnTheScreen();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('sends the note with one photo as files, under a key, then goes back and deletes the photo', async () => {
    const [file] = photos('note-1.jpg');
    await open('note', type(), { 'POST /api/v1/tasks/41/notes': answer });
    await write('Note', 'Meter reads 1204');
    await shoot();
    expect(await screen.findByLabelText('Photo 1')).toBeOnTheScreen();
    // One photo is the most a note takes.
    expect(queryButton('Take a photo')).toBeNull();
    await fireEvent.press(button('Save note'));

    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    const sent = calls.find((call) => call.url.endsWith('/tasks/41/notes'));
    expect(sent?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(forms.fields()).toMatchObject({ note: 'Meter reads 1204', offline: 'false' });
    expect(forms.parts.find(([name]) => name === 'photo')?.[1]).toBeInstanceOf(File);
    expect(file.exists).toBe(false);
  });

  it('removes a photo and deletes its file, and the camera can be closed without losing the text', async () => {
    const [file] = photos('note-2.jpg');
    await open('note');
    await write('Note', 'Half written');
    await fireEvent.press(button('Take a photo'));
    await fireEvent.press(await screen.findByRole('button', { name: 'Close camera' }));
    expect(screen.getByDisplayValue('Half written')).toBeOnTheScreen();
    expect(mockRouter.back).not.toHaveBeenCalled();

    await shoot();
    await fireEvent.press(await screen.findByRole('button', { name: 'Remove photo 1' }));
    expect(screen.queryByLabelText('Photo 1')).toBeNull();
    expect(file.exists).toBe(false);
    expect(button('Take a photo')).toBeOnTheScreen();
  });

  it('shows the server reason with its code, keeps the photos, and a second press is the same send', async () => {
    const [file] = photos('note-3.jpg');
    jest
      .mocked(Crypto.randomUUID)
      .mockReturnValueOnce('dddddddd-0000-4000-8000-000000000001')
      .mockReturnValueOnce('dddddddd-0000-4000-8000-000000000002');
    let first = true;
    await open('note', type(), {
      'POST /api/v1/tasks/41/notes': () => {
        if (first) {
          first = false;
          return failure(409, 'INVALID_TRANSITION', 'The task is closed.');
        }
        return answer();
      },
    });
    await write('Note', 'Late note');
    await shoot();
    await fireEvent.press(button('Save note'));
    expect(await screen.findByText('The task is closed.')).toBeOnTheScreen();
    expect(screen.getByText('409 INVALID_TRANSITION')).toBeOnTheScreen();
    expect(file.exists).toBe(true);

    await fireEvent.press(button('Save note'));
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    const keys = calls
      .filter((call) => call.url.endsWith('/tasks/41/notes'))
      .map((call) => call.headers.get('Idempotency-Key'));
    expect(keys).toEqual([
      'dddddddd-0000-4000-8000-000000000001',
      'dddddddd-0000-4000-8000-000000000001',
    ]);
  });

  it('saves the note on the phone when there is no connection, and leaves no photo in the cache', async () => {
    const [file] = photos('note-4.jpg');
    await open('note', type(), {
      'POST /api/v1/tasks/41/notes': () => {
        throw new TypeError('Network request failed');
      },
      'GET /health': () => {
        throw new TypeError('Network request failed');
      },
    });
    await write('Note', 'Offline note');
    await shoot();
    await fireEvent.press(button('Save note'));

    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    const [row] = await (await getStore()).list(1);
    expect(row).toMatchObject({ kind: 'task_notes', status: 'queued' });
    const payload = await openTaskPayload((await (await getStore()).payload(row.id)) as Uint8Array);
    expect(payload).toMatchObject({
      task_id: 41,
      action: 'notes',
      fields: { note: 'Offline note' },
    });
    expect(payload.photos).toHaveLength(1);
    expect(file.exists).toBe(false);
  });

  it('deletes photos that were taken but never sent when the form is left', async () => {
    const [file] = photos('note-5.jpg');
    await open('note');
    await shoot();
    expect(file.exists).toBe(true);
    await screen.unmount();
    expect(file.exists).toBe(false);
  });
});

describe('Add a comment', () => {
  it('posts the text as the comment body with an optional photo', async () => {
    await open('comment', type(), { 'POST /api/v1/tasks/41/comments': answer });
    await write('Comment', 'Arrived, gate is locked');
    await fireEvent.press(button('Post comment'));
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    expect(forms.fields()).toMatchObject({ body: 'Arrived, gate is locked' });
    expect(forms.parts.some(([name]) => name === 'photo')).toBe(false);
  });
});

describe('Complete the task', () => {
  const COMPLETE = { 'POST /api/v1/tasks/41/complete': answer };

  it('needs the remarks', async () => {
    await open('complete');
    await fireEvent.press(button('Complete task'));
    expect(await screen.findByText('This field is required.')).toBeOnTheScreen();
  });

  it('asks for a proof photo when the task type requires one, and sends nothing without it', async () => {
    await open('complete', type({ proof_photo_required: true, proof_kind: 'photo' }), COMPLETE);
    expect(screen.getByText('Photos (required)')).toBeOnTheScreen();
    await write('Remarks', 'All done');
    await fireEvent.press(button('Complete task'));
    expect(
      await screen.findByText('Add at least one proof photo to complete this task.'),
    ).toBeOnTheScreen();
    expect(calls.some((call) => call.url.endsWith('/complete'))).toBe(false);
  });

  it('asks for a receipt photo when the task type is a receipt', async () => {
    await open('complete', type({ proof_photo_required: true, proof_kind: 'receipt' }), COMPLETE);
    expect(screen.getByText('Receipt photos (required)')).toBeOnTheScreen();
    await write('Remarks', 'Submitted');
    await fireEvent.press(button('Complete task'));
    expect(
      await screen.findByText('Add at least one photo of the receipt to complete this task.'),
    ).toBeOnTheScreen();
  });

  it('completes with remarks and several proof photos as repeated parts, up to five', async () => {
    const files = photos('c-1.jpg', 'c-2.jpg', 'c-3.jpg', 'c-4.jpg', 'c-5.jpg');
    await open('complete', type({ proof_photo_required: true }), COMPLETE);
    await write('Remarks', 'Valves checked');
    for (let n = 1; n <= 5; n += 1) await shoot();
    expect(await screen.findByLabelText('Photo 5')).toBeOnTheScreen();
    expect(queryButton('Take a photo')).toBeNull(); // five is the most
    await fireEvent.press(button('Complete task'));

    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    expect(forms.fields()).toMatchObject({ remarks: 'Valves checked', offline: 'false' });
    expect(forms.parts.filter(([name]) => name === 'photos')).toHaveLength(5);
    for (const file of files) expect(file.exists).toBe(false);
  });

  it('completes without photos when the task type does not need proof', async () => {
    await open('complete', type({ proof_photo_required: false }), COMPLETE);
    expect(screen.getByText('Photos')).toBeOnTheScreen();
    await write('Remarks', 'Nothing to photograph');
    await fireEvent.press(button('Complete task'));
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
  });

  it('shows the server refusal for missing proof in words, and keeps the form', async () => {
    const [file] = photos('c-6.jpg');
    // The server counts photos the phone considers proof; here it still refuses.
    await open('complete', type({ proof_photo_required: true, proof_kind: 'receipt' }), {
      'POST /api/v1/tasks/41/complete': () =>
        Response.json(
          {
            error: {
              code: 'PROOF_PHOTO_REQUIRED',
              message: 'PROOF_PHOTO_REQUIRED',
              details: { proof_kind: 'receipt' },
            },
          },
          { status: 422 },
        ),
    });
    await write('Remarks', 'Done');
    await shoot();
    await fireEvent.press(button('Complete task'));
    expect(
      await screen.findByText('Add at least one photo of the receipt to complete this task.'),
    ).toBeOnTheScreen();
    expect(screen.getByText('422 PROOF_PHOTO_REQUIRED')).toBeOnTheScreen();
    expect(file.exists).toBe(true);
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('shows progress while the upload is slow', async () => {
    let release: (response: Response) => void = () => undefined;
    await open('complete', type({ proof_photo_required: false }), {
      'POST /api/v1/tasks/41/complete': () =>
        new Promise<Response>((resolve) => (release = resolve)),
    });
    await write('Remarks', 'Done');
    await fireEvent.press(button('Complete task'));
    expect(
      await screen.findByText('Sending. This can take a moment on a slow connection.'),
    ).toBeOnTheScreen();
    release(answer());
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
  });
});
