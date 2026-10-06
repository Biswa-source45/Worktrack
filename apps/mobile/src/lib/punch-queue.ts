import { File } from 'expo-file-system';
import { z } from 'zod';
import { deletePhotos } from '@/lib/face-upload';
import { openSqliteStore } from '@/lib/punch-sqlite';
import { open, seal } from '@/lib/queue-seal';

export type QueueKind = 'in' | 'out' | 'request';
export type QueueStatus = 'queued' | 'syncing' | 'synced' | 'failed';

/** What the list shows: everything but the sealed payload, which is large and secret. */
export type QueueRow = {
  /** The request id, which is also the Idempotency-Key every send of this punch carries. */
  id: string;
  seq: number;
  user_id: number;
  kind: QueueKind;
  status: QueueStatus;
  attempts: number;
  error_code: string | null;
  error_message: string | null;
  /** When the phone took the photo (ISO, device clock): shown in IST. */
  created_at: string;
  updated_at: string;
};

export type RowPatch = Partial<
  Pick<QueueRow, 'status' | 'attempts' | 'error_code' | 'error_message'>
> & { /** Wipes the sealed payload: nothing is kept once the server has the punch. */ wipe?: true };

/** The queue's storage. SQLite on the phone (punch-sqlite.ts), an in-memory copy in Jest. */
export interface QueueStore {
  insert(
    row: Pick<QueueRow, 'id' | 'user_id' | 'kind' | 'created_at'>,
    payload: Uint8Array,
  ): Promise<void>;
  /** One employee's rows, oldest first. */
  list(userId: number): Promise<QueueRow[]>;
  payload(id: string): Promise<Uint8Array | null>;
  /** Also sets updated_at. */
  update(id: string, patch: RowPatch): Promise<void>;
  remove(id: string): Promise<void>;
  /** Drops synced rows last touched before `before` (ISO). */
  purge(before: string): Promise<void>;
}

let opening: Promise<QueueStore> | null = null;
export function getStore(): Promise<QueueStore> {
  opening ??= openSqliteStore().catch((error: unknown) => {
    opening = null;
    throw error;
  });
  return opening;
}

const listeners = new Set<() => void>();
/** Tells the screens showing the queue that it changed. Returns the way to stop listening. */
export function onQueueChange(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
export const notifyQueueChange = () => listeners.forEach((listener) => listener());

// The sealed payload: everything the server needs, including the selfie, behind one AES-GCM seal.
const payloadSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  accuracy_m: z.number(),
  device_time: z.string(),
  mocked: z.boolean(),
  emulator: z.boolean(),
  rooted: z.boolean(),
  reason: z.string().nullable(),
  note: z.string().nullable(),
  selfie: z.string(),
});
export type QueuedPayload = z.infer<typeof payloadSchema>;

/** What a punch needs, from the moment the photo is taken. */
export type Attempt = {
  id: string;
  userId: number;
  kind: QueueKind;
  /** The photo, a file in this phone's cache. */
  selfieUri: string;
  lat: number;
  lng: number;
  accuracyM: number;
  mocked: boolean;
  emulator: boolean;
  rooted: boolean;
  deviceTime: string;
  reason?: string;
  note?: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Seals the attempt into the queue and deletes the cache photo: only the sealed copy remains. */
export async function enqueue(attempt: Attempt): Promise<void> {
  const payload: QueuedPayload = {
    lat: attempt.lat,
    lng: attempt.lng,
    accuracy_m: attempt.accuracyM,
    device_time: attempt.deviceTime,
    mocked: attempt.mocked,
    emulator: attempt.emulator,
    rooted: attempt.rooted,
    reason: attempt.reason ?? null,
    note: attempt.note ?? null,
    selfie: await new File(attempt.selfieUri).base64(),
  };
  const sealed = await seal(encoder.encode(JSON.stringify(payload)));
  const store = await getStore();
  await store.insert(
    { id: attempt.id, user_id: attempt.userId, kind: attempt.kind, created_at: attempt.deviceTime },
    sealed,
  );
  deletePhotos([attempt.selfieUri]);
  notifyQueueChange();
}

/** The payload of a row. Throws when the key or the blob cannot be read (app data was cleared). */
export async function openPayload(blob: Uint8Array): Promise<QueuedPayload> {
  return payloadSchema.parse(JSON.parse(decoder.decode(await open(blob))));
}

export async function retryRow(id: string): Promise<void> {
  await (
    await getStore()
  ).update(id, { status: 'queued', attempts: 0, error_code: null, error_message: null });
  notifyQueueChange();
}

export async function discardRow(id: string): Promise<void> {
  await (await getStore()).remove(id);
  notifyQueueChange();
}
