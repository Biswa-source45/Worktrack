import { File, Paths } from 'expo-file-system';
import { ApiError } from './api-error';
import { enqueueTask, getStore } from './punch-queue';
import type { QueueRow, TaskAttempt } from './punch-queue';
import { syncQueue } from './punch-sync';
import type { SendTask } from './punch-sync';
import { submitTaskAction } from './task-actions';
import { mockApi } from '@/test/fake-api';
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

beforeEach(() => {
  resetMemoryStore();
  resetSecureStore();
});

describe('the same action is not saved twice (tapping Accept again while offline)', () => {
  it('keeps one saved Accept for the same task and person, however often it is tapped', async () => {
    await enqueueTask(attempt('acc-1'));
    await enqueueTask(attempt('acc-2'));
    await enqueueTask(attempt('acc-3'));
    expect((await rows()).map((row) => row.id)).toEqual(['acc-1']);
  });

  it('still saves another action, another task, another person, and notes or comments as often as written', async () => {
    await enqueueTask(attempt('a-1'));
    await enqueueTask(attempt('a-start', { action: 'start' }));
    await enqueueTask(attempt('a-other-task', { taskId: 8 }));
    await enqueueTask(attempt('a-other-user', { userId: 2 }));
    await enqueueTask(attempt('a-note-1', { action: 'notes', fields: { note: 'one' } }));
    await enqueueTask(attempt('a-note-2', { action: 'notes', fields: { note: 'two' } }));
    await enqueueTask(attempt('a-say-1', { action: 'comments', fields: { body: 'one' } }));
    await enqueueTask(attempt('a-say-2', { action: 'comments', fields: { body: 'two' } }));
    expect((await rows()).map((row) => row.id)).toEqual([
      'a-1',
      'a-start',
      'a-other-task',
      'a-note-1',
      'a-note-2',
      'a-say-1',
      'a-say-2',
    ]);
    expect((await rows(2)).map((row) => row.id)).toEqual(['a-other-user']);
  });

  it('saves the action again once the earlier one has failed, so the employee can try again', async () => {
    await enqueueTask(attempt('f-1'));
    await (await getStore()).update('f-1', { status: 'failed', error_code: 'X' });
    await enqueueTask(attempt('f-2'));
    expect((await rows()).map((row) => row.id)).toEqual(['f-1', 'f-2']);
  });

  it('deletes the cache photos of the action it did not save', async () => {
    await enqueueTask(
      attempt('c-1', { action: 'complete', fields: { remarks: 'a' } }, ['c-1.jpg']),
    );
    await enqueueTask(
      attempt('c-2', { action: 'complete', fields: { remarks: 'b' } }, ['c-2.jpg']),
    );
    expect((await rows()).map((row) => row.id)).toEqual(['c-1']);
    expect(new File(Paths.cache, 'c-2.jpg').exists).toBe(false);
  });

  it('answers "saved" to every tap offline, but queues only the first', async () => {
    mockApi({
      'POST /api/v1/tasks/7/accept': () => {
        throw new TypeError('Network request failed');
      },
      'GET /health': () => {
        throw new TypeError('Network request failed');
      },
    });
    const first = await submitTaskAction(attempt('t-1'));
    const second = await submitTaskAction(attempt('t-2'));
    expect(first).toEqual({ type: 'queued' });
    expect(second).toEqual({ type: 'queued' });
    expect((await rows()).map((row) => row.id)).toEqual(['t-1']);
  });
});

describe('a saved action the task has already taken is done, not an error', () => {
  const taken = (from: string, action: string) =>
    new ApiError(
      409,
      'INVALID_TRANSITION',
      `This task cannot be moved by '${action}' while it is ${from}.`,
      { from, action },
    );
  const run = async (send: SendTask) => {
    await syncQueue(await getStore(), USER, { send: NO_SEND, sendTask: send });
  };

  it.each([
    ['accept', 'accepted'],
    ['decline', 'declined'],
    ['start', 'in_progress'],
    ['hold', 'on_hold'],
    ['resume', 'in_progress'],
    ['complete', 'completed'],
    ['reached', 'reached'],
  ] as const)('clears a saved %s that finds the task already %s', async (action, state) => {
    await enqueueTask(attempt('x-1', { action }));
    await run(async () => {
      throw taken(state, action);
    });
    expect(await rowOf('x-1')).toMatchObject({ status: 'synced', error_code: null });
  });

  it('wipes the sealed payload of a cleared action and carries on with the next one', async () => {
    await enqueueTask(attempt('n-1'));
    await enqueueTask(attempt('n-2', { action: 'start' }));
    const sent: string[] = [];
    await run(async (row) => {
      sent.push(row.id);
      if (row.id === 'n-1') throw taken('accepted', 'accept');
      return undefined;
    });
    expect(sent).toEqual(['n-1', 'n-2']);
    expect((await rows()).map((row) => row.status)).toEqual(['synced', 'synced']);
    expect(await (await getStore()).payload('n-1')).toBeNull();
  });

  it('keeps real refusals visible: another state, or another action, is still an error', async () => {
    await enqueueTask(attempt('e-1'));
    await enqueueTask(attempt('e-2', { action: 'start' }));
    await enqueueTask(attempt('e-3', { action: 'hold' }));
    await run(async (row) => {
      if (row.id === 'e-1') throw taken('cancelled', 'accept');
      if (row.id === 'e-2') throw taken('accepted', 'start'); // not started yet: a real conflict
      throw new ApiError(404, 'TASK_NOT_FOUND', 'This task does not exist.');
    });
    expect(await rowOf('e-1')).toMatchObject({
      status: 'failed',
      error_code: 'INVALID_TRANSITION',
    });
    expect(await rowOf('e-2')).toMatchObject({
      status: 'failed',
      error_code: 'INVALID_TRANSITION',
    });
    expect(await rowOf('e-3')).toMatchObject({ status: 'failed', error_code: 'TASK_NOT_FOUND' });
  });

  it('does not clear another refusal that merely carries the same details', async () => {
    await enqueueTask(attempt('m-1'));
    await run(async () => {
      throw new ApiError(409, 'REACH_REVIEW_PENDING', 'Waiting.', {
        from: 'accepted',
        action: 'accept',
      });
    });
    expect(await rowOf('m-1')).toMatchObject({ status: 'failed' });
  });
});
