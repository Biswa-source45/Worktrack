import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import { isOffline } from '@/lib/punch';
import { enqueueTask } from '@/lib/punch-queue';
import type { TaskAction, TaskAttempt } from '@/lib/punch-queue';

// Same rule as a punch: an action not answered by now is treated like a lost connection, and the
// same Idempotency-Key makes the later retry harmless. Photos need longer than a punch selfie.
const SEND_TIMEOUT_MS = 60_000;

export const newTaskRequestId = () => Crypto.randomUUID();

type Part = { part: string; file: File };

/** Every task action is multipart/form-data: the text fields, then the photo parts. */
export function taskForm(fields: Record<string, string>, photos: Part[]): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  // A File, not React Native's `{ uri }` part: see photoForm in face-upload.ts.
  for (const { part, file } of photos) form.append(part, file);
  return form;
}

// One sender for all nine actions, because they share the wire format: the path differs, the typed
// client only knows the paths one by one. The body is built by the serializer below.
type RawPost = <T>(
  path: string,
  init: {
    body: unknown;
    bodySerializer: () => FormData;
    headers: Record<string, string>;
    signal: AbortSignal;
  },
) => Promise<{ data?: T; error?: unknown; response: Response }>;
const rawPost = api as unknown as { POST: RawPost };

/** Sends one task action. `key` is the Idempotency-Key: the same key again returns the first result. */
export async function postTaskAction<T = unknown>(
  taskId: number,
  action: TaskAction,
  key: string,
  fields: Record<string, string>,
  photos: Part[],
): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS);
  try {
    return await unwrap(
      rawPost.POST<T>(`/api/v1/tasks/${taskId}/${action}`, {
        body: {},
        bodySerializer: () => taskForm(fields, photos),
        headers: { 'Idempotency-Key': key },
        signal: abort.signal,
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}

export type TaskSent<T> = { type: 'sent'; result: T } | { type: 'queued' };

/**
 * Sends the action now; when the phone is offline it is sealed into the queue instead and goes out
 * later with the same key (and `offline`, which the server stamps with its own receipt time). Any
 * other failure is thrown for the screen to show, with the photos kept for a retry.
 */
export async function submitTaskAction<T = unknown>(attempt: TaskAttempt): Promise<TaskSent<T>> {
  try {
    const result = await postTaskAction<T>(
      attempt.taskId,
      attempt.action,
      attempt.id,
      { ...attempt.fields, device_time: attempt.deviceTime, offline: 'false' },
      attempt.photos.map(({ part, uri }) => ({ part, file: new File(uri) })),
    );
    return { type: 'sent', result };
  } catch (error) {
    if (!(await isOffline(error))) throw error;
    await enqueueTask(attempt);
    return { type: 'queued' };
  }
}
