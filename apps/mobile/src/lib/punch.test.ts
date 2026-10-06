import { File, Paths } from 'expo-file-system';
import { ApiError } from './api-error';
import { isOffline, postPunch, precheck, submitPunch } from './punch';
import type { PunchFields } from './punch';
import { getStore } from './punch-queue';
import type { Attempt } from './punch-queue';
import {
  calls,
  failure,
  mockApi,
  precheckBody,
  punchResultBody,
  recordForms,
} from '@/test/fake-api';
import { resetMemoryStore } from '@/test/memory-queue-store';
import { resetSecureStore } from '@/test/secure-store-mock';

const FIELDS: PunchFields = {
  lat: 20.2961,
  lng: 85.8245,
  accuracy_m: 12.5,
  device_time: '2026-10-05T03:30:00.000Z',
  mocked: true,
  emulator: false,
  rooted: true,
  reason: null,
  note: null,
  offline: false,
};

function photo(name: string) {
  const file = new File(Paths.cache, name);
  file.create({ overwrite: true });
  file.write(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]));
  return file;
}

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  id: 'attempt-1',
  userId: 1,
  kind: 'in',
  selfieUri: photo('submit.jpg').uri,
  lat: 20.2961,
  lng: 85.8245,
  accuracyM: 12.5,
  mocked: false,
  emulator: false,
  rooted: false,
  deviceTime: '2026-10-05T03:30:00.000Z',
  ...over,
});

const created = () => Response.json(punchResultBody(), { status: 201 });
const HEALTH = 'GET /health';
const IN = 'POST /api/v1/attendance/punch-in';
const OUT = 'POST /api/v1/attendance/punch-out';
const REQUEST = 'POST /api/v1/attendance/punch-out-requests';

beforeEach(() => {
  resetMemoryStore();
  resetSecureStore();
});

describe('precheck', () => {
  it('sends the position and its accuracy, and nothing about the phone', async () => {
    mockApi({ 'POST /api/v1/attendance/precheck': () => Response.json(precheckBody()) });
    await precheck({ lat: 20.2961, lng: 85.8245, accuracyM: 12.5, mocked: true });
    expect(await calls[0].json()).toEqual({ lat: 20.2961, lng: 85.8245, accuracy_m: 12.5 });
  });
});

describe('postPunch', () => {
  it('posts a punch-in with the selfie as a File, every field, and the idempotency key', async () => {
    mockApi({ [IN]: created });
    const form = recordForms();
    const selfie = photo('post-in.jpg');

    const result = await postPunch('in', 'key-in', selfie, FIELDS);
    form.restore();

    expect(result.result).toBe('verified');
    expect(calls[0].headers.get('Idempotency-Key')).toBe('key-in');
    expect(form.parts[0][0]).toBe('selfie');
    expect(form.parts[0][1]).toBe(selfie);
    expect(form.fields()).toEqual({
      lat: '20.2961',
      lng: '85.8245',
      accuracy_m: '12.5',
      device_time: '2026-10-05T03:30:00.000Z',
      mocked: 'true',
      emulator: 'false',
      rooted: 'true',
      offline: 'false',
    });
  });

  it('posts a punch-out to its own path', async () => {
    mockApi({ [OUT]: created });
    const form = recordForms();
    await postPunch('out', 'key-out', photo('post-out.jpg'), FIELDS);
    form.restore();
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/attendance/punch-out');
  });

  it('posts a punch-out request with its reason and note', async () => {
    mockApi({ [REQUEST]: created });
    const form = recordForms();
    await postPunch('request', 'key-req', photo('post-req.jpg'), {
      ...FIELDS,
      reason: 'Client site',
      note: 'Back by 5',
    });
    form.restore();
    expect(new URL(calls[0].url).pathname).toBe('/api/v1/attendance/punch-out-requests');
    expect(form.fields()).toMatchObject({ reason: 'Client site', note: 'Back by 5' });
  });

  it('throws the server refusal with its own message', async () => {
    mockApi({
      [IN]: () => failure(422, 'OUTSIDE_GEOFENCE', 'You are 340 m away from Head Office.'),
    });
    const form = recordForms();
    const error = await postPunch('in', 'k', photo('post-no.jpg'), FIELDS).catch((e: unknown) => e);
    form.restore();
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      code: 'OUTSIDE_GEOFENCE',
      message: 'You are 340 m away from Head Office.',
    });
  });
});

describe('isOffline', () => {
  it('is true for a lost connection and false for an answer from the server', async () => {
    expect(await isOffline(new TypeError('Network request failed'))).toBe(true);
    expect(await isOffline(new ApiError(500, 'HTTP_500', ''))).toBe(false);
  });

  it('asks the server whether it is there for any other error', async () => {
    mockApi({ [HEALTH]: () => Response.json({ status: 'ok' }) });
    expect(await isOffline(new Error('something odd'))).toBe(false);

    mockApi({
      [HEALTH]: () => {
        throw new TypeError('Network request failed');
      },
    });
    expect(await isOffline(new Error('timed out'))).toBe(true);
  });

  it('counts a 503 from the health check as the server being there', async () => {
    mockApi({ [HEALTH]: () => Response.json({ status: 'degraded' }, { status: 503 }) });
    expect(await isOffline(new Error('something odd'))).toBe(false);
  });
});

describe('submitPunch', () => {
  it('returns the result when the server takes the punch', async () => {
    mockApi({ [IN]: created });
    const form = recordForms();
    const sent = await submitPunch(attempt());
    form.restore();
    expect(sent).toMatchObject({ type: 'sent', result: { result: 'verified' } });
    expect(await (await getStore()).list(1)).toEqual([]);
  });

  it('sends it online with offline=false and the key of the attempt', async () => {
    mockApi({ [IN]: created });
    const form = recordForms();
    await submitPunch(attempt({ id: 'the-key' }));
    form.restore();
    expect(calls[0].headers.get('Idempotency-Key')).toBe('the-key');
    expect(form.fields().offline).toBe('false');
  });

  it('saves the punch on the phone when the connection is lost, keeps its key, and deletes the photo', async () => {
    mockApi({
      [IN]: () => {
        throw new TypeError('Network request failed');
      },
    });
    const taken = attempt({ id: 'offline-key' });
    const form = recordForms();
    const sent = await submitPunch(taken);
    form.restore();

    expect(sent).toEqual({ type: 'queued' });
    expect(await (await getStore()).list(1)).toEqual([
      expect.objectContaining({ id: 'offline-key', kind: 'in', status: 'queued' }),
    ]);
    expect(new File(taken.selfieUri).exists).toBe(false);
  });

  it('saves the punch when an unexpected error happens and the server cannot be reached', async () => {
    mockApi({
      [IN]: () => {
        throw new Error('socket closed');
      },
      [HEALTH]: () => {
        throw new TypeError('Network request failed');
      },
    });
    const form = recordForms();
    expect(await submitPunch(attempt())).toEqual({ type: 'queued' });
    form.restore();
  });

  it('shows the real error, and saves nothing, when the server is reachable', async () => {
    mockApi({
      [IN]: () => {
        throw new Error('socket closed');
      },
      [HEALTH]: () => Response.json({ status: 'ok' }),
    });
    const form = recordForms();
    await expect(submitPunch(attempt())).rejects.toThrow('socket closed');
    form.restore();
    expect(await (await getStore()).list(1)).toEqual([]);
  });

  it.each([
    [422, 'FACE_RETAKE'],
    [409, 'ALREADY_PUNCHED_IN'],
    [503, 'UNAVAILABLE'],
  ])('throws a %s answer (%s) and saves nothing', async (status, code) => {
    mockApi({ [IN]: () => failure(status, code, `${code} text`) });
    const form = recordForms();
    await expect(submitPunch(attempt())).rejects.toMatchObject({ status, code });
    form.restore();
    expect(await (await getStore()).list(1)).toEqual([]);
  });
});
