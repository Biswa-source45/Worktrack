import { File, Paths } from 'expo-file-system';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { ApiError } from '@/lib/api-error';
import { postPunch } from '@/lib/punch';
import {
  getStore,
  isTaskKind,
  notifyQueueChange,
  onQueueChange,
  openPayload,
  openTaskPayload,
} from '@/lib/punch-queue';
import type {
  QueueRow,
  QueueStore,
  QueuedPayload,
  QueuedTaskPayload,
  TaskAction,
} from '@/lib/punch-queue';
import { postTaskAction } from '@/lib/task-actions';

/** A punch the server keeps answering 5xx for is given up on after this many sends. */
export const MAX_ATTEMPTS = 5;
const KEEP_SYNCED_MS = 7 * 86_400_000;
// Automatic triggers (every successful call, the timer) are spaced out; "Sync now" and the app
// coming back to the foreground are not.
const MIN_GAP_MS = 5_000;
const EVERY_MS = 30_000;

export type Failure = 'network' | 'auth' | 'business' | 'server';

/**
 * What a failed send means for the queue. network: nothing reached the server, try again later.
 * auth: the session is not valid right now, try again after signing in. business: the server
 * answered with a refusal that will not change. server: a 5xx or something unexpected, which
 * is retried a few times.
 */
export function classify(error: unknown): Failure {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'auth';
    return error.status >= 500 ? 'server' : 'business';
  }
  if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {
    return 'network';
  }
  return 'server';
}

export type Send = (row: QueueRow, payload: QueuedPayload) => Promise<unknown>;
export type SendTask = (row: QueueRow, payload: QueuedTaskPayload) => Promise<unknown>;
type Deps = {
  send: Send;
  open?: typeof openPayload;
  /** Task rows only; the real sender when left out. */
  sendTask?: SendTask;
  openTask?: typeof openTaskPayload;
};

/** Sends one queued punch: the photo is written to the cache for the request and deleted after. */
export const sendQueued: Send = async (row, payload) => {
  if (isTaskKind(row.kind)) throw new Error('a task action is sent by sendQueuedTask');
  const photo = new File(Paths.cache, `queued-${row.id}.jpg`);
  photo.create({ overwrite: true });
  try {
    photo.write(payload.selfie, { encoding: 'base64' });
    // Offline punches carry the time the phone took the photo, not the time of sending.
    return await postPunch(row.kind, row.id, photo, { ...payload, offline: true });
  } finally {
    photo.delete();
  }
};

/** Sends one queued task action, its photos written to the cache for the request only. */
export const sendQueuedTask: SendTask = async (row, payload) => {
  const files = payload.photos.map(({ part, data }, index) => ({
    part,
    file: new File(Paths.cache, `queued-${row.id}-${index}.jpg`),
    data,
  }));
  try {
    for (const { file, data } of files) {
      file.create({ overwrite: true });
      file.write(data, { encoding: 'base64' });
    }
    // The server stamps its own receipt time and judges the phone's clock against the allowed age.
    return await postTaskAction(
      payload.task_id,
      payload.action,
      row.id,
      { ...payload.fields, device_time: payload.device_time, offline: 'true' },
      files,
    );
  } finally {
    for (const { file } of files) if (file.exists) file.delete();
  }
};

// Where each saved action leaves the person on the task. A refusal that says the person is
// already there (a double tap, or an action that did go out before) is the goal reached.
const LEAVES_AT: Partial<Record<TaskAction, string>> = {
  accept: 'accepted',
  decline: 'declined',
  start: 'in_progress',
  hold: 'on_hold',
  resume: 'in_progress',
  complete: 'completed',
  reached: 'reached',
};

/** True when the server refused this saved task action only because it is already in effect. */
export function alreadyInEffect(row: QueueRow, error: unknown): boolean {
  if (!(error instanceof ApiError) || error.code !== 'INVALID_TRANSITION') return false;
  if (!isTaskKind(row.kind)) return false;
  const action = row.kind.slice('task_'.length) as TaskAction;
  const details = (error.details ?? {}) as { from?: unknown; action?: unknown };
  return details.action === action && details.from === LEAVES_AT[action];
}

const failedWith = (error: unknown): { error_code: string; error_message: string | null } =>
  error instanceof ApiError
    ? { error_code: error.code, error_message: error.message || null }
    : {
        error_code: error instanceof Error ? error.name : 'UNKNOWN',
        error_message: error instanceof Error ? error.message.slice(0, 200) : null,
      };

/**
 * Sends the queued punches of one employee, oldest first and one at a time (a punch-out must not
 * arrive before its punch-in). A refusal marks that punch failed and the run goes on; a lost
 * connection, an expired session or a failing server stops it, with the punch still queued.
 */
export async function syncQueue(store: QueueStore, userId: number, deps: Deps) {
  const open = deps.open ?? openPayload;
  const handled = new Set<string>();
  // Rows left "syncing" are from a run the app did not finish.
  for (const row of await store.list(userId)) {
    if (row.status === 'syncing') await store.update(row.id, { status: 'queued' });
  }

  for (;;) {
    const row = (await store.list(userId)).find((r) => r.status === 'queued' && !handled.has(r.id));
    if (!row) break;
    handled.add(row.id);
    await store.update(row.id, { status: 'syncing' });
    notifyQueueChange();

    let deliver: () => Promise<unknown>;
    try {
      const blob = await store.payload(row.id);
      if (!blob) throw new Error('the sealed punch is missing');
      if (isTaskKind(row.kind)) {
        const task = await (deps.openTask ?? openTaskPayload)(blob);
        deliver = () => (deps.sendTask ?? sendQueuedTask)(row, task);
      } else {
        const punch = await open(blob);
        deliver = () => deps.send(row, punch);
      }
    } catch {
      // The key or the blob is gone (the app's data was cleared): said, never dropped silently.
      await store.update(row.id, {
        status: 'failed',
        error_code: 'UNREADABLE',
        error_message: null,
        wipe: true,
      });
      notifyQueueChange();
      continue;
    }

    let stop = false;
    try {
      await deliver();
      await store.update(row.id, {
        status: 'synced',
        error_code: null,
        error_message: null,
        wipe: true,
      });
    } catch (error) {
      const kind = classify(error);
      if (kind === 'business' && alreadyInEffect(row, error)) {
        await store.update(row.id, {
          status: 'synced',
          error_code: null,
          error_message: null,
          wipe: true,
        });
      } else if (kind === 'business') {
        await store.update(row.id, { status: 'failed', ...failedWith(error) });
      } else if (kind === 'server') {
        const attempts = row.attempts + 1;
        const exhausted = attempts >= MAX_ATTEMPTS;
        await store.update(row.id, {
          status: exhausted ? 'failed' : 'queued',
          attempts,
          ...failedWith(error),
        });
        stop = !exhausted;
      } else {
        await store.update(row.id, { status: 'queued' });
        stop = true;
      }
    }
    notifyQueueChange();
    if (stop) break;
  }
  await store.purge(new Date(Date.now() - KEEP_SYNCED_MS).toISOString());
}

/** Whether an automatic trigger may start a run now. */
export const dueForSync = (now: number, lastRun: number, force: boolean) =>
  force || now - lastRun >= MIN_GAP_MS;

let owner: number | null = null;
let running: Promise<void> | null = null;
let lastRun = 0;

/** Runs the queue now, or joins the run in progress. Does nothing while no one is signed in. */
export function requestSync({ force = false } = {}): Promise<void> {
  if (running) return running;
  if (owner === null || !dueForSync(Date.now(), lastRun, force)) return Promise.resolve();
  lastRun = Date.now();
  const userId = owner;
  running = getStore()
    .then((store) => syncQueue(store, userId, { send: sendQueued }))
    .catch((error: unknown) => {
      // Not a failed punch but a failed run (the database could not be opened, for one).
      console.warn('[punch-sync] the run failed', error);
    })
    .finally(() => {
      running = null;
      notifyQueueChange();
    });
  return running;
}

/**
 * While an employee is signed in: syncs at the start, when the app returns to the foreground,
 * and every 30 seconds. The queue is only ever sent as the account that took the punches.
 */
export function useQueueAutoSync(userId: number | undefined) {
  useEffect(() => {
    owner = userId ?? null;
    if (owner === null) return;
    void requestSync({ force: true });
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') void requestSync({ force: true });
    });
    const timer = setInterval(() => void requestSync(), EVERY_MS);
    return () => {
      foreground.remove();
      clearInterval(timer);
      owner = null;
    };
  }, [userId]);
}

/** The signed-in employee's queue, kept current while the screen is open. */
export function usePunchQueue(userId: number | undefined) {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (userId === undefined) return;
    let live = true;
    const load = async () => {
      try {
        const list = await (await getStore()).list(userId);
        if (live) {
          setRows(list);
          setError(null);
        }
      } catch (failure) {
        if (live) setError(failure);
      }
    };
    void load();
    const stop = onQueueChange(() => void load());
    return () => {
      live = false;
      stop();
    };
  }, [userId]);

  return { rows, error };
}
