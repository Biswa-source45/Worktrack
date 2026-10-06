import { File, Paths } from 'expo-file-system';
import { ApiError } from './api-error';
import {
  MAX_QUEUED_PHOTOS,
  MAX_QUEUED_PHOTO_BYTES,
  discardRow,
  enqueue,
  enqueueTask,
  getStore,
  openTaskPayload,
} from './punch-queue';
import type { QueueRow, TaskAttempt } from './punch-queue';
import { sendQueuedTask, syncQueue } from './punch-sync';
import type { SendTask } from './punch-sync';
import { submitTaskAction } from './task-actions';
import { calls, mockApi, recordForms } from '@/test/fake-api';
import { resetMemoryStore } from '@/test/memory-queue-store';
import { resetSecureStore } from '@/test/secure-store-mock';

const USER = 1;
const BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
const NO_SEND = async () => undefined;

function photo(name: string) {
  const file = new File(Paths.cache, name);
  file.create({ overwrite: true });
  file.write(BYTES);
  return file;
}

function attempt(id: string, over: Partial<TaskAttempt> = {}, files: string[] = []): TaskAttempt {
  return {
    id,
    userId: USER,
    taskId: 7,
    action: 'accept',
    fields: {},
    photos: files.map((name) => ({ part: 'photos', uri: photo(name).uri })),
    deviceTime: '2026-10-06T04:30:00.000Z',
    ...over,
  };
}

const rows = (userId = USER): Promise<QueueRow[]> => getStore().then((store) => store.list(userId));
const rowOf = async (id: string) => (await rows()).find((row) => row.id === id);
const refusal = (code: string, message: string, status = 409) =>
  new ApiError(status, code, message);

beforeEach(() => {
  resetMemoryStore();
  resetSecureStore();
});

describe('enqueueTask', () => {
  it('seals the action under its own kind, user and device time, with the photos inside', async () => {
    await enqueueTask(
      attempt(
        'done-1',
        { action: 'complete', fields: { remarks: 'Panel replaced', secret: 'abc' } },
        ['t-1.jpg', 't-2.jpg'],
      ),
    );

    expect(await rowOf('done-1')).toMatchObject({
      kind: 'task_complete',
      user_id: USER,
      status: 'queued',
      created_at: '2026-10-06T04:30:00.000Z',
    });
    const store = await getStore();
    const blob = (await store.payload('done-1')) as Uint8Array;
    // Sealed: the remarks are not readable in the stored bytes.
    expect(Buffer.from(blob).toString('utf8')).not.toContain('Panel replaced');
    const payload = await openTaskPayload(blob);
    expect(payload).toMatchObject({
      task_id: 7,
      action: 'complete',
      fields: { remarks: 'Panel replaced', secret: 'abc' },
      device_time: '2026-10-06T04:30:00.000Z',
    });
    expect(payload.photos).toEqual([
      { part: 'photos', data: Buffer.from(BYTES).toString('base64') },
      { part: 'photos', data: Buffer.from(BYTES).toString('base64') },
    ]);
  });

  it('deletes the cache photos once they are sealed: only the sealed copy remains', async () => {
    await enqueueTask(attempt('gone-1', { action: 'notes' }, ['n-1.jpg']));
    expect(new File(Paths.cache, 'n-1.jpg').exists).toBe(false);
    const payload = await openTaskPayload(
      (await (await getStore()).payload('gone-1')) as Uint8Array,
    );
    expect(payload.photos).toHaveLength(1); // still there for the send
  });
});

describe('what a saved task action may hold', () => {
  it('refuses more photos than the server takes, queues nothing and keeps the cache photos', async () => {
    const names = Array.from({ length: MAX_QUEUED_PHOTOS + 1 }, (_, i) => `many-${i}.jpg`);
    await expect(enqueueTask(attempt('many', { action: 'complete' }, names))).rejects.toThrow(
      /at most 5 photos/,
    );
    expect(await rows()).toEqual([]);
    expect(new File(Paths.cache, 'many-0.jpg').exists).toBe(true);
  });

  it('refuses a photo that is too large to seal, queues nothing and keeps the cache photo', async () => {
    const big = new File(Paths.cache, 'big.jpg');
    big.create({ overwrite: true });
    big.write(new Uint8Array(MAX_QUEUED_PHOTO_BYTES + 1));
    await expect(
      enqueueTask(attempt('big', { action: 'notes', photos: [{ part: 'photo', uri: big.uri }] })),
    ).rejects.toThrow(/too large/);
    expect(await rows()).toEqual([]);
    expect(big.exists).toBe(true);
    big.delete();
  });

  it('removes a dismissed failed action together with its sealed photos', async () => {
    await enqueueTask(attempt('dismiss', { action: 'notes' }, ['d-1.jpg']));
    await (await getStore()).update('dismiss', { status: 'failed', error_code: 'X' });
    await discardRow('dismiss');
    expect(await rows()).toEqual([]);
    expect(await (await getStore()).payload('dismiss')).toBeNull();
  });
});

describe('syncQueue with task actions', () => {
  it('replays punches and task actions strictly oldest first, one at a time, each with its own sender', async () => {
    await enqueue({
      id: 'punch-1',
      userId: USER,
      kind: 'in',
      selfieUri: photo('p-1.jpg').uri,
      lat: 20,
      lng: 85,
      accuracyM: 10,
      mocked: false,
      emulator: false,
      rooted: false,
      deviceTime: '2026-10-06T03:30:00.000Z',
    });
    await enqueueTask(attempt('accept-1', { action: 'accept' }));
    await enqueueTask(attempt('start-1', { action: 'start' }));
    await enqueueTask(attempt('hold-1', { action: 'hold', fields: { reason: 'Lunch' } }));
    const order: string[] = [];
    let active = 0;
    const track = async (id: string) => {
      active += 1;
      expect(active).toBe(1);
      order.push(id);
      await Promise.resolve();
      active -= 1;
    };
    const send = jest.fn(async (row: QueueRow) => track(row.id));
    const sendTask: SendTask = jest.fn(async (row) => track(row.id));

    await syncQueue(await getStore(), USER, { send, sendTask });

    expect(order).toEqual(['punch-1', 'accept-1', 'start-1', 'hold-1']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sendTask).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ id: 'hold-1', kind: 'task_hold' }),
      expect.objectContaining({ task_id: 7, action: 'hold', fields: { reason: 'Lunch' } }),
    );
    expect((await rows()).map((row) => row.status)).toEqual([
      'synced',
      'synced',
      'synced',
      'synced',
    ]);
  });

  it('stops at a lost connection and keeps the task action and the later ones queued, same key', async () => {
    await enqueueTask(attempt('a', { action: 'start' }));
    await enqueueTask(attempt('b', { action: 'hold', fields: { reason: 'x1' } }));
    const keys: string[] = [];
    let up = false;
    const sendTask: SendTask = jest.fn(async (row) => {
      keys.push(row.id);
      if (!up) throw new TypeError('Network request failed');
    });

    await syncQueue(await getStore(), USER, { send: NO_SEND, sendTask });
    expect((await rows()).map((row) => row.status)).toEqual(['queued', 'queued']);
    up = true;
    await syncQueue(await getStore(), USER, { send: NO_SEND, sendTask });

    expect(keys).toEqual(['a', 'a', 'b']);
    expect((await rows()).map((row) => row.status)).toEqual(['synced', 'synced']);
  });

  it('marks a refused task action failed with the server message and carries on with the next', async () => {
    await enqueueTask(attempt('late', { action: 'start' }));
    await enqueueTask(attempt('fine', { action: 'notes', fields: { note: 'ok' } }));
    const sendTask: SendTask = jest.fn(async (row) => {
      if (row.id === 'late') {
        throw refusal('INVALID_TRANSITION', 'The task was cancelled by the assigner.');
      }
    });

    await syncQueue(await getStore(), USER, { send: NO_SEND, sendTask });

    expect(await rowOf('late')).toMatchObject({
      status: 'failed',
      error_code: 'INVALID_TRANSITION',
      error_message: 'The task was cancelled by the assigner.',
    });
    expect((await rowOf('fine'))?.status).toBe('synced');
  });

  it('fails a replay the server found too old, in its own words', async () => {
    await enqueueTask(attempt('old', { action: 'accept' }));
    const sendTask: SendTask = async () => {
      throw refusal('OFFLINE_PUNCH_TOO_OLD', 'This was saved more than 12 hours ago.');
    };
    await syncQueue(await getStore(), USER, { send: NO_SEND, sendTask });
    expect(await rowOf('old')).toMatchObject({
      status: 'failed',
      error_code: 'OFFLINE_PUNCH_TOO_OLD',
    });
  });

  it('keeps a task action queued after a 5xx and stops the run', async () => {
    await enqueueTask(attempt('a', { action: 'resume' }));
    await enqueueTask(attempt('b', { action: 'hold', fields: { reason: 'x1' } }));
    const sendTask: SendTask = jest.fn(async () => {
      throw refusal('HTTP_503', '', 503);
    });
    await syncQueue(await getStore(), USER, { send: NO_SEND, sendTask });
    expect(sendTask).toHaveBeenCalledTimes(1);
    expect(await rowOf('a')).toMatchObject({ status: 'queued', attempts: 1 });
  });

  it('sends only the signed-in employee rows and leaves another employee queue alone', async () => {
    await enqueueTask(attempt('mine', { action: 'start' }));
    await enqueueTask(attempt('theirs', { action: 'start', userId: 2 }));
    const sendTask: SendTask = jest.fn(NO_SEND);

    await syncQueue(await getStore(), USER, { send: NO_SEND, sendTask });

    expect(sendTask).toHaveBeenCalledTimes(1);
    expect((await rows(USER)).map((row) => row.id)).toEqual(['mine']);
    expect(await rows(2)).toEqual([expect.objectContaining({ id: 'theirs', status: 'queued' })]);
  });

  it('wipes the sealed payload, photos included, once the server has the action', async () => {
    await enqueueTask(attempt('w', { action: 'notes' }, ['w-1.jpg']));
    await syncQueue(await getStore(), USER, { send: NO_SEND, sendTask: NO_SEND });
    expect(await (await getStore()).payload('w')).toBeNull();
  });

  it('marks a task action unreadable when its blob is gone, without dropping it silently', async () => {
    await enqueueTask(attempt('lost', { action: 'start' }));
    resetSecureStore(); // the key is lost
    const sendTask: SendTask = jest.fn(NO_SEND);
    await syncQueue(await getStore(), USER, { send: NO_SEND, sendTask });
    expect(sendTask).not.toHaveBeenCalled();
    expect(await rowOf('lost')).toMatchObject({ status: 'failed', error_code: 'UNREADABLE' });
  });

  it('keeps the photos readable through a failed send so a later replay still has them', async () => {
    await enqueueTask(
      attempt('keep', { action: 'complete', fields: { remarks: 'ok' } }, ['k.jpg']),
    );
    const sendTask: SendTask = async () => {
      throw new TypeError('Network request failed');
    };
    await syncQueue(await getStore(), USER, { send: NO_SEND, sendTask });
    const payload = await openTaskPayload((await (await getStore()).payload('keep')) as Uint8Array);
    expect(payload.photos).toHaveLength(1);
    expect((await rowOf('keep'))?.status).toBe('queued');
  });
});

describe('sendQueuedTask', () => {
  const payload = (over = {}) => ({
    task_id: 7,
    action: 'complete' as const,
    fields: { remarks: 'Panel replaced' },
    device_time: '2026-10-06T04:30:00.000Z',
    photos: [{ part: 'photos', data: Buffer.from(BYTES).toString('base64') }],
    ...over,
  });
  const row = { id: 'send-1', kind: 'task_complete' } as QueueRow;
  const done = () => Response.json({ replayed: true }, { status: 201 });

  it('posts multipart to the task action under its own key as offline, with the time it was taken', async () => {
    mockApi({ 'POST /api/v1/tasks/7/complete': done });
    const form = recordForms();
    await sendQueuedTask(row, payload());
    form.restore();

    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get('Idempotency-Key')).toBe('send-1');
    expect(form.fields()).toEqual({
      remarks: 'Panel replaced',
      device_time: '2026-10-06T04:30:00.000Z',
      offline: 'true',
    });
    expect(form.parts.filter(([name]) => name === 'photos')).toHaveLength(1);
    expect(form.parts.find(([name]) => name === 'photos')?.[1]).toBeInstanceOf(File);
  });

  it('deletes the temporary photo files after the request, sent or not', async () => {
    mockApi({ 'POST /api/v1/tasks/7/complete': done });
    let form = recordForms();
    await sendQueuedTask(row, payload());
    form.restore();
    expect(new File(Paths.cache, 'queued-send-1-0.jpg').exists).toBe(false);

    mockApi({
      'POST /api/v1/tasks/7/complete': () => {
        throw new TypeError('Network request failed');
      },
    });
    form = recordForms();
    await expect(sendQueuedTask(row, payload())).rejects.toThrow(TypeError);
    form.restore();
    expect(new File(Paths.cache, 'queued-send-1-0.jpg').exists).toBe(false);
  });

  it('turns the server refusal into an ApiError the queue classifies', async () => {
    mockApi({
      'POST /api/v1/tasks/7/complete': () =>
        Response.json(
          { error: { code: 'PROOF_PHOTO_REQUIRED', message: 'Add a photo.', details: null } },
          { status: 422 },
        ),
    });
    const form = recordForms();
    await expect(sendQueuedTask(row, payload())).rejects.toMatchObject({
      status: 422,
      code: 'PROOF_PHOTO_REQUIRED',
      message: 'Add a photo.',
    });
    form.restore();
  });

  it('sends a task action with no photos', async () => {
    mockApi({ 'POST /api/v1/tasks/7/accept': done });
    const form = recordForms();
    await sendQueuedTask(
      { ...row, id: 'send-2' },
      payload({ action: 'accept', fields: {}, photos: [] }),
    );
    form.restore();
    expect(form.parts.map(([name]) => name).sort()).toEqual(['device_time', 'offline']);
  });
});

describe('submitTaskAction', () => {
  it('sends at once, not as offline, with the key and the device time', async () => {
    mockApi({
      'POST /api/v1/tasks/7/hold': () => Response.json({ ok: true }, { status: 201 }),
    });
    const form = recordForms();
    const sent = await submitTaskAction(
      attempt('now-1', { action: 'hold', fields: { reason: 'Waiting for the client' } }),
    );
    form.restore();
    expect(sent).toEqual({ type: 'sent', result: { ok: true } });
    expect(calls[0].headers.get('Idempotency-Key')).toBe('now-1');
    expect(form.fields()).toEqual({
      reason: 'Waiting for the client',
      device_time: '2026-10-06T04:30:00.000Z',
      offline: 'false',
    });
    expect(await rows()).toEqual([]);
  });

  it('saves the action on the phone when the connection is lost, photos sealed and cache files gone', async () => {
    mockApi({
      'POST /api/v1/tasks/7/notes': () => {
        throw new TypeError('Network request failed');
      },
      'GET /health': () => {
        throw new TypeError('Network request failed');
      },
    });
    const form = recordForms();
    const sent = await submitTaskAction(
      attempt('lost-1', { action: 'notes', fields: { note: 'Wall cracked' } }, ['q-1.jpg']),
    );
    form.restore();

    expect(sent).toEqual({ type: 'queued' });
    expect(await rowOf('lost-1')).toMatchObject({ kind: 'task_notes', status: 'queued' });
    expect(new File(Paths.cache, 'q-1.jpg').exists).toBe(false);
  });

  it('throws the server refusal and queues nothing, so the screen shows the real reason', async () => {
    mockApi({
      'POST /api/v1/tasks/7/start': () =>
        Response.json(
          {
            error: { code: 'INVALID_TRANSITION', message: 'Reach the site first.', details: null },
          },
          { status: 409 },
        ),
    });
    const form = recordForms();
    await expect(submitTaskAction(attempt('no-1', { action: 'start' }))).rejects.toMatchObject({
      status: 409,
      code: 'INVALID_TRANSITION',
    });
    form.restore();
    expect(await rows()).toEqual([]);
  });
});
