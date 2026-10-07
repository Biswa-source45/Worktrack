'use client';

import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from '@/components/field';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { AssigneePicker } from './assignee-picker';
import { newKey } from './task-api';
import { useApplyResult } from './use-task';

type Task = Schemas['TaskDetail'];
type Result = Schemas['ActionOut'];

const MIN = 3;
const MAX = 500;

type CommentProps = {
  title: string;
  description: string;
  label: string;
  confirm: string;
  destructive?: boolean;
  /** An empty text is refused. */
  required: boolean;
  /** Extra controls above the text box (e.g. which people to reopen). */
  children?: ReactNode;
  /** A reason the action cannot be sent yet. */
  blocked?: string;
  /** The key is the same for every retry of this dialog. */
  send: (text: string, key: string) => Promise<Result>;
  taskId: number;
  onClose: () => void;
};

/** A dialog that asks for a written reason and sends one action: the shape of cancel, close, reopen. */
export function CommentDialog({
  title,
  description,
  label,
  confirm,
  destructive,
  required,
  children,
  blocked,
  send,
  taskId,
  onClose,
}: CommentProps) {
  const { t } = useTranslation();
  const apply = useApplyResult(taskId);
  const key = useRef(newKey());
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit() {
    const value = text.trim();
    if ((required || value !== '') && value.length < MIN) {
      setProblem(t(value === '' ? 'validation.required' : 'tasks.dialog.tooShort', { min: MIN }));
      return;
    }
    setProblem(null);
    setError(null);
    setPending(true);
    try {
      apply(await send(value, key.current));
      onClose();
    } catch (e) {
      setError(errorMessage(t, e, 'tasks'));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        {blocked && (
          <p role="status" className="text-small text-warning">
            {blocked}
          </p>
        )}
        {children}
        <Field id="task-comment" label={label} error={problem ?? undefined}>
          <Textarea
            id="task-comment"
            maxLength={MAX}
            value={text}
            invalid={problem !== null}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        {error && (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={() => void submit()}
            disabled={pending || !!blocked}
          >
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const idem = (key: string) => ({ 'Idempotency-Key': key });

export function CancelDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <CommentDialog
      taskId={task.id}
      title={t('tasks.dialog.cancelTitle')}
      description={t('tasks.dialog.cancelHint', { code: task.code })}
      label={t('tasks.dialog.reason')}
      confirm={t('tasks.dialog.cancelAction')}
      destructive
      required
      onClose={onClose}
      send={(reason, key) =>
        unwrap(
          proxyApi().POST('/api/v1/tasks/{task_id}/cancel', {
            params: { path: { task_id: task.id }, header: idem(key) },
            body: { reason },
          }),
        )
      }
    />
  );
}

export function CloseDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const { t } = useTranslation();
  const rejected = task.assignees.some((a) => a.reach?.review === 'rejected');
  const pending = task.assignees.some((a) => a.reach?.review === 'pending');
  return (
    <CommentDialog
      taskId={task.id}
      title={t('tasks.dialog.closeTitle')}
      description={t('tasks.dialog.closeHint', { code: task.code })}
      label={t(rejected ? 'tasks.dialog.closeCommentRequired' : 'tasks.dialog.closeComment')}
      confirm={t('tasks.dialog.closeAction')}
      required={rejected}
      blocked={pending ? t('tasks.errors.REACH_REVIEW_PENDING') : undefined}
      onClose={onClose}
      send={(remarks, key) =>
        unwrap(
          proxyApi().POST('/api/v1/tasks/{task_id}/close', {
            params: { path: { task_id: task.id }, header: idem(key) },
            body: { remarks: remarks || null },
          }),
        )
      }
    />
  );
}

export function ReopenDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const { t } = useTranslation();
  const completed = task.assignees.filter((a) => a.status === 'completed');
  const [chosen, setChosen] = useState(() => completed.map((a) => a.user.id));
  const toggle = (id: number) =>
    setChosen((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]));
  return (
    <CommentDialog
      taskId={task.id}
      title={t('tasks.dialog.reopenTitle')}
      description={t('tasks.dialog.reopenHint', { code: task.code })}
      label={t('tasks.dialog.reopenComment')}
      confirm={t('tasks.dialog.reopenAction')}
      required
      blocked={chosen.length === 0 ? t('tasks.dialog.reopenNobody') : undefined}
      onClose={onClose}
      send={(comment, key) =>
        unwrap(
          proxyApi().POST('/api/v1/tasks/{task_id}/reopen', {
            params: { path: { task_id: task.id }, header: idem(key) },
            // Everyone who completed is the server's default.
            body: {
              comment,
              ...(chosen.length === completed.length ? {} : { user_ids: chosen }),
            },
          }),
        )
      }
    >
      {completed.length > 1 && (
        <fieldset className="grid gap-1">
          <legend className="text-small font-medium">{t('tasks.dialog.reopenWho')}</legend>
          {completed.map((a) => (
            <label key={a.user.id} className="flex items-center gap-2 text-small">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={chosen.includes(a.user.id)}
                onChange={() => toggle(a.user.id)}
              />
              {a.user.name}
            </label>
          ))}
        </fieldset>
      )}
    </CommentDialog>
  );
}

export function AssignDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const { t } = useTranslation();
  const apply = useApplyResult(task.id);
  const key = useRef(newKey());
  const [ids, setIds] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Declined and removed people can be added again; the ones still on the task cannot.
  const onTask = task.assignees
    .filter((a) => a.status !== 'declined' && a.status !== 'cancelled')
    .map((a) => a.user.id);

  async function submit() {
    setError(null);
    setPending(true);
    try {
      apply(
        await unwrap(
          proxyApi().POST('/api/v1/tasks/{task_id}/assignees', {
            params: { path: { task_id: task.id }, header: idem(key.current) },
            body: { user_ids: ids },
          }),
        ),
      );
      onClose();
    } catch (e) {
      setError(errorMessage(t, e, 'tasks'));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle>{t('tasks.dialog.assignTitle')}</DialogTitle>
        <DialogDescription>{t('tasks.dialog.assignHint', { code: task.code })}</DialogDescription>
        <AssigneePicker value={ids} onChange={setIds} exclude={onTask} />
        {error && (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={pending || ids.length === 0}>
            {t('tasks.dialog.assignAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
