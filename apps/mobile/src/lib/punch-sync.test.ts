import { File, Paths } from 'expo-file-system';
import { ApiError } from './api-error';
import { MAX_ATTEMPTS, classify, dueForSync, sendQueued, syncQueue } from './punch-sync';
import type { Failure } from './punch-sync';
import { enqueue, getStore } from './punch-queue';
import type { Attempt, QueueRow, QueuedPayload } from './punch-queue';
import { calls, mockApi, punchResultBody, recordForms } from '@/test/fake-api';
import { resetMemoryStore, setStoredPayload } from '@/test/memory-queue-store';
import { resetSecureStore } from '@/test/secure-store-mock';

const USER = 1;
const NO_SEND = async () => undefined;

async function queue(id: string, kind: Attempt['kind'] = 'in', at = '2026-10-05T03:30:00.000Z') {
  const photo = new File(Paths.cache, `sync-${id}.jpg`);
  photo.create({ overwrite: true });
  photo.write(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]));
  await enqueue({
    id,
    userId: USER,
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

const rows = async (): Promise<QueueRow[]> => (await getStore()).list(USER);
const statusOf = async (id: string) => (await rows()).find((row) => row.id === id);
const refusal = (code: string, message = `${code} message`, status = 422) =>
  new ApiError(status, code, message);

const PAYLOAD: QueuedPayload = {
  lat: 20.2961,
  lng: 85.8245,
  accuracy_m: 10,
  device_time: '2026-10-05T12:30:00.000Z',
  mocked: false,
  emulator: false,
  rooted: false,
  reason: null,
  note: null,
  selfie: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
};

beforeEach(() => {
  resetMemoryStore();
  resetSecureStore();
});

describe('syncQueue', () => {
  it('sends the oldest punch first, one at a time, and marks each synced', async () => {
    await queue('first', 'in');
    await queue('second', 'out');
    const order: string[] = [];
    let active = 0;
    const send = jest.fn(async (row: QueueRow) => {
      active += 1;
      expect(active).toBe(1); // never two in flight
      order.push(row.id);
      await Promise.resolve();
      active -= 1;
    });

    await syncQueue(await getStore(), USER, { send });

    expect(order).toEqual(['first', 'second']);
    expect((await rows()).map((row) => row.status)).toEqual(['synced', 'synced']);
  });

  it('hands over the request id (the idempotency key) and the details as they were taken', async () => {
    await queue('key-1');
    const send = jest.fn(NO_SEND);
    await syncQueue(await getStore(), USER, { send });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'key-1', kind: 'in' }),
      expect.objectContaining({
        lat: 20.2961,
        device_time: '2026-10-05T03:30:00.000Z',
        mocked: false,
        selfie: expect.any(String),
      }),
    );
  });

  it('keeps the same key on every retry of a punch', async () => {
    await queue('retry-key');
    const keys: string[] = [];
    let up = false;
    const send = jest.fn(async (row: QueueRow) => {
      keys.push(row.id);
      if (!up) throw new TypeError('Network request failed');
    });
    await syncQueue(await getStore(), USER, { send });
    up = true;
    await syncQueue(await getStore(), USER, { send });
    expect(keys).toEqual(['retry-key', 'retry-key']);
    expect((await statusOf('retry-key'))?.status).toBe('synced');
  });

  it('stops at a network error and leaves that punch and the later ones queued', async () => {
    await queue('a');
    await queue('b');
    const send = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    await syncQueue(await getStore(), USER, { send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual([
      expect.objectContaining({ id: 'a', status: 'queued', attempts: 0 }),
      expect.objectContaining({ id: 'b', status: 'queued', attempts: 0 }),
    ]);
  });

  it('stops without failing anything when the session is not valid right now', async () => {
    await queue('a');
    await queue('b');
    const send = jest.fn(async () => {
      throw refusal('UNAUTHENTICATED', 'Sign in again.', 401);
    });
    await syncQueue(await getStore(), USER, { send });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await rows()).map((row) => row.status)).toEqual(['queued', 'queued']);
  });

  it('marks a refused punch failed with the server code and message, and sends the next one', async () => {
    await queue('refused');
    await queue('fine');
    const send = jest.fn(async (row: QueueRow) => {
      if (row.id === 'refused') {
        throw refusal('OUTSIDE_GEOFENCE', 'You are 340 m away from Head Office.');
      }
    });
    await syncQueue(await getStore(), USER, { send });
    expect(await statusOf('refused')).toMatchObject({
      status: 'failed',
      error_code: 'OUTSIDE_GEOFENCE',
      error_message: 'You are 340 m away from Head Office.',
    });
    expect((await statusOf('fine'))?.status).toBe('synced');
  });

  it('keeps a punch queued after a 5xx, counts the attempt, and stops the run', async () => {
    await queue('a');
    await queue('b');
    const send = jest.fn(async () => {
      throw refusal('HTTP_503', '', 503);
    });
    await syncQueue(await getStore(), USER, { send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await statusOf('a')).toMatchObject({ status: 'queued', attempts: 1 });
    expect((await statusOf('b'))?.attempts).toBe(0);
  });

  it('gives up on a punch after five 5xx answers, marks it failed, and goes on to the next', async () => {
    await queue('broken');
    await queue('later');
    const send = jest.fn(async (row: QueueRow) => {
      if (row.id === 'broken') throw refusal('INTERNAL', 'The server failed.', 500);
    });
    for (let run = 1; run < MAX_ATTEMPTS; run++) {
      await syncQueue(await getStore(), USER, { send });
      expect(await statusOf('broken')).toMatchObject({ status: 'queued', attempts: run });
      expect((await statusOf('later'))?.status).toBe('queued'); // order holds until it gives up
    }
    await syncQueue(await getStore(), USER, { send });
    expect(await statusOf('broken')).toMatchObject({
      status: 'failed',
      attempts: MAX_ATTEMPTS,
      error_code: 'INTERNAL',
    });
    expect((await statusOf('later'))?.status).toBe('synced');
  });

  it('marks a punch failed and unreadable when its blob is gone, and still sends the others', async () => {
    await queue('lost');
    await queue('ok');
    setStoredPayload('lost', null);
    const send = jest.fn(NO_SEND);
    await syncQueue(await getStore(), USER, { send });
    expect(await statusOf('lost')).toMatchObject({ status: 'failed', error_code: 'UNREADABLE' });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await statusOf('ok'))?.status).toBe('synced');
  });

  it('marks a punch failed and unreadable when the key is gone (app data cleared)', async () => {
    await queue('old');
    resetSecureStore(); // the key is lost; a new one is made, which cannot open the old blob
    const send = jest.fn(NO_SEND);
    await syncQueue(await getStore(), USER, { send });
    expect(send).not.toHaveBeenCalled();
    expect(await statusOf('old')).toMatchObject({ status: 'failed', error_code: 'UNREADABLE' });
  });

  it('wipes the sealed payload of a punch the server has', async () => {
    await queue('done');
    const store = await getStore();
    expect(await store.payload('done')).not.toBeNull();
    await syncQueue(store, USER, { send: NO_SEND });
    expect(await store.payload('done')).toBeNull();
    expect(await statusOf('done')).toMatchObject({ status: 'synced', error_code: null });
  });

  it('does not send a punch again that failed, until it is retried', async () => {
    await queue('failed-before');
    const store = await getStore();
    await store.update('failed-before', { status: 'failed', error_code: 'X' });
    const send = jest.fn(NO_SEND);
    await syncQueue(store, USER, { send });
    expect(send).not.toHaveBeenCalled();
  });

  it('starts over with a punch that a killed run left syncing', async () => {
    await queue('stuck');
    const store = await getStore();
    await store.update('stuck', { status: 'syncing' });
    const send = jest.fn(NO_SEND);
    await syncQueue(store, USER, { send });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await statusOf('stuck'))?.status).toBe('synced');
  });

  it('only sends the punches of the signed-in employee', async () => {
    await queue('mine');
    const store = await getStore();
    await store.insert(
      { id: 'theirs', user_id: 2, kind: 'in', created_at: '2026-10-05T03:00:00.000Z' },
      Uint8Array.of(1),
    );
    const send = jest.fn(NO_SEND);
    await syncQueue(store, USER, { send });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await store.list(2))[0].status).toBe('queued');
  });

  it('drops synced rows after seven days, and keeps newer ones and failed ones', async () => {
    await queue('old-synced');
    await queue('failed');
    const store = await getStore();
    await store.update('failed', { status: 'failed', error_code: 'X' });
    await syncQueue(store, USER, { send: NO_SEND });

    // Six days later it is still listed; eight days later it is gone, and the failed one stays.
    const real = Date.now();
    const clock = jest.spyOn(Date, 'now');
    clock.mockReturnValue(real + 6 * 86_400_000);
    await syncQueue(store, USER, { send: NO_SEND });
    expect((await rows()).map((row) => row.id)).toEqual(['old-synced', 'failed']);
    clock.mockReturnValue(real + 8 * 86_400_000);
    await syncQueue(store, USER, { send: NO_SEND });
    expect((await rows()).map((row) => row.id)).toEqual(['failed']);
    clock.mockRestore();
  });
});

describe('classify', () => {
  const cases: [string, unknown, Failure][] = [
    ['a lost connection', new TypeError('Network request failed'), 'network'],
    ['an aborted request', Object.assign(new Error('aborted'), { name: 'AbortError' }), 'network'],
    ['a 401', refusal('UNAUTHENTICATED', '', 401), 'auth'],
    ['a 422 with a code', refusal('FACE_RETAKE'), 'business'],
    ['a 404', refusal('NOT_FOUND', '', 404), 'business'],
    ['a 502', refusal('HTTP_502', '', 502), 'server'],
    ['an unexpected error', new RangeError('something unexpected'), 'server'],
  ];
  for (const [label, error, expected] of cases) {
    it(`treats ${label} as ${expected}`, () => {
      expect(classify(error)).toBe(expected);
    });
  }
});

describe('dueForSync', () => {
  it('spaces automatic runs five seconds apart, and never holds back a forced one', () => {
    expect(dueForSync(10_000, 6_000, false)).toBe(false);
    expect(dueForSync(11_000, 6_000, false)).toBe(true);
    expect(dueForSync(6_001, 6_000, true)).toBe(true);
  });
});

describe('sendQueued', () => {
  it('posts the punch as offline with the time it was taken, under its own key, and cleans up', async () => {
    mockApi({
      'POST /api/v1/attendance/punch-out': () =>
        Response.json(punchResultBody({ replayed: true }), { status: 201 }),
    });
    await queue('send-1', 'out', '2026-10-05T12:30:00.000Z');
    const row = (await rows())[0];
    const form = recordForms();

    await sendQueued(row, PAYLOAD);
    form.restore();

    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get('Idempotency-Key')).toBe('send-1');
    expect(form.fields()).toMatchObject({
      offline: 'true',
      device_time: '2026-10-05T12:30:00.000Z',
      mocked: 'false',
      lat: '20.2961',
    });
    // The temporary copy of the photo does not outlive the request.
    expect(new File(Paths.cache, 'queued-send-1.jpg').exists).toBe(false);
  });

  it('deletes the temporary photo even when the request fails', async () => {
    mockApi({
      'POST /api/v1/attendance/punch-in': () => {
        throw new TypeError('Network request failed');
      },
    });
    await queue('send-2');
    const row = (await rows())[0];
    const form = recordForms();
    await expect(sendQueued(row, PAYLOAD)).rejects.toThrow(TypeError);
    form.restore();
    expect(new File(Paths.cache, 'queued-send-2.jpg').exists).toBe(false);
  });
});
