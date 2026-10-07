import { File } from 'expo-file-system';
import { z } from 'zod';
import { deletePhotos } from '@/lib/face-upload';
import { openSqliteStore } from '@/lib/punch-sqlite';
import { open, seal } from '@/lib/queue-seal';

export type QueueKind = 'in' | 'out' | 'request';
export const TASK_ACTIONS = [
  'accept',
  'decline',
  'start',
  'hold',
  'resume',
  'notes',
  'complete',
  'reached',
  'comments',
] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];
/** A task action saved for later: `task_accept`, `task_complete` and so on (no ":" because i18n keys). */
export type TaskKind = `task_${TaskAction}`;
/** What a saved row is: a punch or a task action. */
export type RowKind = QueueKind | TaskKind;
export const isTaskKind = (kind: RowKind): kind is TaskKind => kind.startsWith('task_');
export type QueueStatus = 'queued' | 'syncing' | 'synced' | 'failed';

/** What the list shows: everything but the sealed payload, which is large and secret. */
export type QueueRow = {
  /** The request id, which is also the Idempotency-Key every send of this punch carries. */
  id: string;
  seq: number;
  user_id: number;
  kind: RowKind;
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

// A task action is sealed the same way: one AES-GCM blob with the form fields and the photos
// (as base64: the cache file is deleted at once, only the sealed copy waits for the connection).
const taskPayloadSchema = z.object({
  task_id: z.number().int(),
  action: z.enum(TASK_ACTIONS),
  /** The text parts of the form (lat, lng, accuracy_m, reason, remarks, note ...). */
  fields: z.record(z.string(), z.string()),
  device_time: z.string(),
  photos: z.array(z.object({ part: z.string(), data: z.string() })),
});
export type QueuedTaskPayload = z.infer<typeof taskPayloadSchema>;

/** One task action, from the moment the employee pressed the button. */
export type TaskAttempt = {
  /** Also the Idempotency-Key of every send. */
  id: string;
  userId: number;
  taskId: number;
  action: TaskAction;
  fields: Record<string, string>;
  /** Photos in this phone's cache, each as the form part it is sent in (`photo`, `photos`, `selfie`). */
  photos: { part: string; uri: string }[];
  deviceTime: string;
};

// Bounds the sealed blob (and the SQLite row) at 5 x 3 MB of photos, about 20 MB as base64. The
// camera's 4:3 HD photos are a few hundred KB; the server re-encodes every photo anyway.
export const MAX_QUEUED_PHOTOS = 5;
export const MAX_QUEUED_PHOTO_BYTES = 3_000_000;

// A note or a comment is new content every time; every other action moves the task once.
const WRITTEN_AGAIN: readonly TaskAction[] = ['notes', 'comments'];
const WAITING: readonly QueueStatus[] = ['queued', 'syncing'];

/**
 * The saved action of this employee that is still waiting to be sent for this task and action, or
 * null. A task is told at most once to accept, start, hold and so on, so a second tap while the
 * first is still saved would only be refused when both arrive.
 */
export async function findWaitingTaskAction(
  userId: number,
  taskId: number,
  action: TaskAction,
): Promise<string | null> {
  const store = await getStore();
  for (const row of await store.list(userId)) {
    if (row.kind !== `task_${action}` || !WAITING.includes(row.status)) continue;
    const blob = await store.payload(row.id);
    if (!blob) continue;
    try {
      if ((await openTaskPayload(blob)).task_id === taskId) return row.id;
    } catch {
      // An unreadable row is reported by the sync run; it is not this action's copy.
    }
  }
  return null;
}

// One at a time: two quick taps must not both find nothing waiting and both save.
let saving: Promise<unknown> = Promise.resolve();

/**
 * Seals the task action into the queue and deletes its cache photos: only the sealed copy remains.
 * Returns the id of the saved row. An action that is already waiting for the same task and person
 * is not saved again (its id is returned and the new photos are deleted).
 */
export function enqueueTask(attempt: TaskAttempt): Promise<string> {
  const run = saving.then(() => saveTask(attempt));
  saving = run.catch(() => undefined);
  return run;
}

async function saveTask(attempt: TaskAttempt): Promise<string> {
  if (attempt.photos.length > MAX_QUEUED_PHOTOS) {
    throw new Error(`a saved task action holds at most ${MAX_QUEUED_PHOTOS} photos`);
  }
  for (const { uri } of attempt.photos) {
    if (new File(uri).size > MAX_QUEUED_PHOTO_BYTES) {
      throw new Error('a photo is too large to save on this phone');
    }
  }
  if (!WRITTEN_AGAIN.includes(attempt.action)) {
    const waiting = await findWaitingTaskAction(attempt.userId, attempt.taskId, attempt.action);
    if (waiting) {
      deletePhotos(attempt.photos.map((photo) => photo.uri));
      return waiting;
    }
  }
  const payload: QueuedTaskPayload = {
    task_id: attempt.taskId,
    action: attempt.action,
    fields: attempt.fields,
    device_time: attempt.deviceTime,
    photos: await Promise.all(
      attempt.photos.map(async ({ part, uri }) => ({ part, data: await new File(uri).base64() })),
    ),
  };
  const sealed = await seal(encoder.encode(JSON.stringify(payload)));
  const store = await getStore();
  await store.insert(
    {
      id: attempt.id,
      user_id: attempt.userId,
      kind: `task_${attempt.action}`,
      created_at: attempt.deviceTime,
    },
    sealed,
  );
  deletePhotos(attempt.photos.map((photo) => photo.uri));
  notifyQueueChange();
  return attempt.id;
}

export async function openTaskPayload(blob: Uint8Array): Promise<QueuedTaskPayload> {
  return taskPayloadSchema.parse(JSON.parse(decoder.decode(await open(blob))));
}
