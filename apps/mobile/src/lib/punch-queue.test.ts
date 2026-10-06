import { File, Paths } from 'expo-file-system';
import { discardRow, enqueue, getStore, onQueueChange, openPayload, retryRow } from './punch-queue';
import type { Attempt } from './punch-queue';
import { resetMemoryStore, setStoredPayload } from '@/test/memory-queue-store';
import { resetSecureStore } from '@/test/secure-store-mock';

const PHOTO = Uint8Array.from([0xff, 0xd8, 0x01, 0x02, 0x03, 0xff, 0xd9]);

function cacheFile(name: string) {
  const file = new File(Paths.cache, name);
  file.create({ overwrite: true });
  file.write(PHOTO);
  return file;
}

const attempt = (over: Partial<Attempt>): Attempt => ({
  id: 'req-1',
  userId: 1,
  kind: 'in',
  selfieUri: '',
  lat: 20.2961,
  lng: 85.8245,
  accuracyM: 12.5,
  mocked: false,
  emulator: false,
  rooted: false,
  deviceTime: '2026-10-05T03:30:00.000Z',
  ...over,
});

beforeEach(() => {
  resetMemoryStore();
  resetSecureStore();
});

describe('enqueue', () => {
  it('stores one queued row with plain metadata and one sealed payload', async () => {
    const photo = cacheFile('seal-a.jpg');
    await enqueue(attempt({ selfieUri: photo.uri, reason: 'Client site', note: 'Back by 5' }));

    const store = await getStore();
    const [row] = await store.list(1);
    expect(row).toMatchObject({
      id: 'req-1',
      user_id: 1,
      kind: 'in',
      status: 'queued',
      attempts: 0,
      error_code: null,
      error_message: null,
      created_at: '2026-10-05T03:30:00.000Z',
    });
    const blob = (await store.payload('req-1')) as Uint8Array;
    // Nothing readable is left in the blob: neither the position, the reason nor the photo.
    const raw = Buffer.from(blob).toString('latin1');
    expect(raw).not.toContain('20.2961');
    expect(raw).not.toContain('Client site');
    expect(raw).not.toContain(Buffer.from(PHOTO).toString('base64'));
  });

  it('seals everything the server needs, and the photo comes back byte for byte', async () => {
    const photo = cacheFile('seal-b.jpg');
    await enqueue(
      attempt({ selfieUri: photo.uri, mocked: true, rooted: true, reason: 'Client site' }),
    );
    const blob = (await (await getStore()).payload('req-1')) as Uint8Array;
    const payload = await openPayload(blob);
    expect(payload).toEqual({
      lat: 20.2961,
      lng: 85.8245,
      accuracy_m: 12.5,
      device_time: '2026-10-05T03:30:00.000Z',
      mocked: true,
      emulator: false,
      rooted: true,
      reason: 'Client site',
      note: null,
      selfie: Buffer.from(PHOTO).toString('base64'),
    });
  });

  it('deletes the photo from the phone cache once it is sealed', async () => {
    const photo = cacheFile('seal-c.jpg');
    expect(photo.exists).toBe(true);
    await enqueue(attempt({ selfieUri: photo.uri }));
    expect(photo.exists).toBe(false);
  });

  it('keeps the photo when it could not be sealed in the queue, so nothing is lost', async () => {
    const photo = cacheFile('seal-d.jpg');
    await enqueue(attempt({ selfieUri: photo.uri }));
    const again = cacheFile('seal-d.jpg');
    // The same request id again: the store refuses, and the photo stays where it is.
    await expect(enqueue(attempt({ selfieUri: again.uri }))).rejects.toThrow();
    expect(again.exists).toBe(true);
    again.delete();
  });

  it('tells the screens that the queue changed', async () => {
    const heard = jest.fn();
    const stop = onQueueChange(heard);
    await enqueue(attempt({ selfieUri: cacheFile('seal-e.jpg').uri }));
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('a payload that cannot be read', () => {
  it('throws for a blob that is not a sealed payload, never a half-read one', async () => {
    await enqueue(attempt({ selfieUri: cacheFile('seal-f.jpg').uri }));
    setStoredPayload(
      'req-1',
      Uint8Array.from([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
        26, 27, 28,
      ]),
    );
    const blob = (await (await getStore()).payload('req-1')) as Uint8Array;
    await expect(openPayload(blob)).rejects.toThrow();
  });
});

describe('retry and discard', () => {
  it('puts a failed punch back in the queue with its attempts and reason cleared', async () => {
    await enqueue(attempt({ selfieUri: cacheFile('seal-g.jpg').uri }));
    const store = await getStore();
    await store.update('req-1', {
      status: 'failed',
      attempts: 5,
      error_code: 'FACE_RETAKE',
      error_message: 'Take it again',
    });
    await retryRow('req-1');
    expect((await store.list(1))[0]).toMatchObject({
      status: 'queued',
      attempts: 0,
      error_code: null,
      error_message: null,
    });
  });

  it('removes a discarded punch for good', async () => {
    await enqueue(attempt({ selfieUri: cacheFile('seal-h.jpg').uri }));
    await discardRow('req-1');
    const store = await getStore();
    expect(await store.list(1)).toEqual([]);
    expect(await store.payload('req-1')).toBeNull();
  });

  it('lists only the rows of the employee who is asking', async () => {
    await enqueue(attempt({ id: 'mine', userId: 1, selfieUri: cacheFile('seal-i.jpg').uri }));
    await enqueue(attempt({ id: 'theirs', userId: 2, selfieUri: cacheFile('seal-j.jpg').uri }));
    expect((await (await getStore()).list(1)).map((row) => row.id)).toEqual(['mine']);
  });
});
