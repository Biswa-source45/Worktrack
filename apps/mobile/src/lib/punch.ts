import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import type { components } from 'api-types';
import { api } from '@/lib/api';
import { ApiError, unwrap } from '@/lib/api-error';
import type { Fix } from '@/lib/location';
import { enqueue } from '@/lib/punch-queue';
import type { Attempt, QueueKind, QueuedPayload } from '@/lib/punch-queue';

export type PunchResult = components['schemas']['PunchResult'];
export type Precheck = components['schemas']['PrecheckOut'];
export type Today = components['schemas']['TodayOut'];

// A punch that has not been answered by now is treated like a lost connection. The punch may
// still have reached the server: the same Idempotency-Key makes the later retry harmless.
const SEND_TIMEOUT_MS = 30_000;

export const newRequestId = () => Crypto.randomUUID();

/** The server's verdict on the position; nothing is stored by it. */
export const precheck = (fix: Fix) =>
  unwrap(
    api.POST('/api/v1/attendance/precheck', {
      body: { lat: fix.lat, lng: fix.lng, accuracy_m: fix.accuracyM },
    }),
  );

export const fetchToday = () => unwrap(api.GET('/api/v1/attendance/today'));

/** The fields a punch carries besides the selfie, as the server's form expects them. */
export type PunchFields = Omit<QueuedPayload, 'selfie'> & { offline: boolean };

function punchForm(selfie: File, fields: PunchFields): FormData {
  const form = new FormData();
  // A File, not React Native's `{ uri }` part: see photoForm in face-upload.ts.
  form.append('selfie', selfie);
  form.append('lat', String(fields.lat));
  form.append('lng', String(fields.lng));
  form.append('accuracy_m', String(fields.accuracy_m));
  form.append('device_time', fields.device_time);
  for (const flag of ['mocked', 'emulator', 'rooted', 'offline'] as const) {
    form.append(flag, String(fields[flag]));
  }
  if (fields.reason) form.append('reason', fields.reason);
  if (fields.note) form.append('note', fields.note);
  return form;
}

/**
 * Sends one punch. `key` is the Idempotency-Key: the same key again returns the first result, so
 * a retry of a punch the server already took never counts twice.
 */
export async function postPunch(
  kind: QueueKind,
  key: string,
  selfie: File,
  fields: PunchFields,
): Promise<PunchResult> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS);
  // The typed body only lists the fields; the serializer sends the real parts.
  const options = {
    body: {
      selfie: '',
      lat: 0,
      lng: 0,
      accuracy_m: 0,
      mocked: false,
      emulator: false,
      rooted: false,
      offline: false,
    },
    bodySerializer: () => punchForm(selfie, fields),
    params: { header: { 'Idempotency-Key': key } },
    signal: abort.signal,
  };
  try {
    return await unwrap(
      kind === 'in'
        ? api.POST('/api/v1/attendance/punch-in', options)
        : kind === 'out'
          ? api.POST('/api/v1/attendance/punch-out', options)
          : api.POST('/api/v1/attendance/punch-out-requests', {
              ...options,
              body: { ...options.body, reason: '' },
            }),
    );
  } finally {
    clearTimeout(timer);
  }
}

/** True when the failure is the phone's connection, not an answer from the server. */
export async function isOffline(error: unknown): Promise<boolean> {
  if (error instanceof ApiError) return false;
  if (error instanceof TypeError) return true;
  // Anything else (a timeout, a refresh that could not reach the server) is told apart by asking
  // the server whether it is there at all.
  try {
    await api.GET('/health'); // any answer, even a 503, means the server is there
    return false;
  } catch {
    return true;
  }
}

export type Sent = { type: 'sent'; result: PunchResult } | { type: 'queued' };

/**
 * Sends the punch now; when the phone is offline the punch is sealed into the queue instead and
 * goes out later with the same key. Any other failure is thrown for the screen to show.
 */
export async function submitPunch(attempt: Attempt): Promise<Sent> {
  const fields: PunchFields = {
    lat: attempt.lat,
    lng: attempt.lng,
    accuracy_m: attempt.accuracyM,
    device_time: attempt.deviceTime,
    mocked: attempt.mocked,
    emulator: attempt.emulator,
    rooted: attempt.rooted,
    reason: attempt.reason ?? null,
    note: attempt.note ?? null,
    offline: false,
  };
  try {
    const result = await postPunch(attempt.kind, attempt.id, new File(attempt.selfieUri), fields);
    return { type: 'sent', result };
  } catch (error) {
    if (!(await isOffline(error))) throw error;
    await enqueue(attempt);
    return { type: 'queued' };
  }
}
