import { useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useAuth } from '@/lib/auth';
import { findWaitingTaskAction } from '@/lib/punch-queue';
import type { TaskAction } from '@/lib/punch-queue';
import { newTaskRequestId, submitTaskAction } from '@/lib/task-actions';
import { TASKS_KEY, taskKey } from '@/lib/tasks';
import type { ActionOut, TaskDetail } from '@/lib/tasks';

export type TaskPhoto = { part: string; uri: string };
/** `sent`: the server's answer. `queued`: saved on this phone, sent when it is back online. */
export type Delivery =
  { type: 'queued'; rowId: string | null } | { type: 'sent'; task: TaskDetail };

/**
 * Sends one action of one task as the signed-in employee. A retry of the same action with the same
 * content reuses its Idempotency-Key, so a send the server already took never counts twice. A
 * lost connection saves the action on the phone ('queued'); every other failure is thrown, and the
 * photos stay where they are for the retry.
 */
export function useTaskAction(taskId: number) {
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const last = useRef<{ signature: string; id: string } | null>(null);

  return async function run(
    action: TaskAction,
    fields: Record<string, string> = {},
    photos: TaskPhoto[] = [],
  ): Promise<Delivery> {
    if (!me) throw new Error('not signed in');
    const signature = JSON.stringify([action, fields, photos.map((photo) => photo.uri)]);
    const id = last.current?.signature === signature ? last.current.id : newTaskRequestId();
    last.current = { signature, id };
    const sent = await submitTaskAction<ActionOut>({
      id,
      userId: me.id,
      taskId,
      action,
      fields,
      photos,
      // The moment the employee acted, on the phone's clock: for the audit, and the time a saved
      // action carries. The server's own clock decides what counts.
      deviceTime: new Date().toISOString(),
    });
    last.current = null;
    if (sent.type === 'queued') {
      return { type: 'queued', rowId: await findWaitingTaskAction(me.id, taskId, action) };
    }
    queryClient.setQueryData(taskKey(taskId), sent.result.task);
    // The lists change with the status; the detail was just replaced by the server's answer.
    void queryClient.invalidateQueries({
      queryKey: TASKS_KEY,
      predicate: (query) => query.queryKey[1] !== 'detail',
    });
    return { type: 'sent', task: sent.result.task };
  };
}
