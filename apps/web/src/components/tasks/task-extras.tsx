'use client';

import { useRef, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { errorMessage, type Schemas } from '@/lib/api-client';
import { formatIst } from '@/lib/ist';
import { BRIEF_ACCEPT, BRIEF_MAX_BYTES, newKey, postForm } from './task-api';
import { useApplyResult } from './use-task';

type Task = Schemas['TaskDetail'];
type Attachment = Schemas['AttachmentOut'];

const KINDS = ['brief', 'work_photo', 'proof', 'receipt', 'comment'] as const;

/** The signed links are relative; the portal's proxy adds the backend's base. */
const href = (url: string) => `/api/proxy${url}`;

function AttachmentView({ attachment }: { attachment: Attachment }) {
  const { t } = useTranslation();
  const isImage = attachment.content_type.startsWith('image/');
  const name = attachment.filename ?? t(`tasks.kind.${attachment.kind}`);
  return (
    <li className="grid gap-1">
      <a
        href={href(attachment.url)}
        target="_blank"
        rel="noreferrer"
        className="block rounded-md border bg-raised p-1 hover:border-border-strong"
      >
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={href(attachment.url)}
            alt={name}
            className="aspect-square w-full rounded-sm object-cover"
          />
        ) : (
          <span className="flex aspect-square flex-col items-center justify-center gap-1 p-2 text-center text-small">
            <Paperclip aria-hidden="true" className="size-6" />
            <span className="line-clamp-2 break-all">{name}</span>
          </span>
        )}
      </a>
      <p className="text-caption text-muted-foreground">
        {attachment.uploaded_by.name}, {formatIst(attachment.created_at)}
      </p>
    </li>
  );
}

/** Briefs, work photos, proof and receipts, each kind under its own heading. */
export function TaskAttachments({ task }: { task: Task }) {
  const { t } = useTranslation();
  const apply = useApplyResult(task.id);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const closed = task.status === 'closed' || task.status === 'cancelled';

  async function upload(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > BRIEF_MAX_BYTES) {
      setError(t('tasks.form.briefTooBig', { name: file.name }));
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      apply(await postForm(`/tasks/${task.id}/attachments`, form, newKey()));
    } catch (e) {
      setError(errorMessage(t, e, 'tasks'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card role="group" aria-label={t('tasks.attachments.title')} className="space-y-3">
      <h2 className="text-h3">{t('tasks.attachments.title')}</h2>
      {task.attachments.length === 0 && (
        <p className="text-small text-muted-foreground">{t('tasks.attachments.none')}</p>
      )}
      {KINDS.map((kind) => {
        const items = task.attachments.filter((a) => a.kind === kind);
        if (items.length === 0) return null;
        return (
          <section key={kind} aria-label={t(`tasks.kind.${kind}`)} className="space-y-2">
            <h3 className="text-small font-semibold">{t(`tasks.kind.${kind}`)}</h3>
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4">
              {items.map((a) => (
                <AttachmentView key={a.id} attachment={a} />
              ))}
            </ul>
          </section>
        );
      })}
      {task.can_manage && !closed && (
        <div className="grid gap-1.5">
          <label htmlFor="add-brief" className="text-small font-medium">
            {t('tasks.attachments.add')}
          </label>
          <Input
            id="add-brief"
            type="file"
            accept={BRIEF_ACCEPT}
            disabled={busy}
            onChange={(e) => {
              void upload(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          {error && (
            <p role="alert" className="text-caption text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

/** What happened, oldest first, with who did it and the note they left. */
export function TaskTimeline({ task }: { task: Task }) {
  const { t } = useTranslation();
  return (
    <Card role="group" aria-label={t('tasks.timeline.title')} className="space-y-3">
      <h2 className="text-h3">{t('tasks.timeline.title')}</h2>
      <ol className="grid gap-3">
        {task.events.map((event) => (
          <li key={event.id} className="grid gap-0.5 border-l-2 border-border-strong pl-3">
            <p className="flex flex-wrap items-center gap-1.5 text-small font-medium">
              {t(`tasks.event.${event.event}`, { defaultValue: event.event })}
              {event.subject && (
                <span className="font-normal text-muted-foreground">: {event.subject.name}</span>
              )}
              {event.offline && <Badge tone="warning">{t('tasks.timeline.offline')}</Badge>}
            </p>
            {event.note && <p className="text-small">{event.note}</p>}
            <p className="text-caption text-muted-foreground">
              {formatIst(event.at)}
              {event.actor ? `, ${event.actor.name}` : `, ${t('tasks.timeline.system')}`}
            </p>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** The thread between the assigner and the people on the task, with an optional photo. */
export function TaskComments({ task }: { task: Task }) {
  const { t } = useTranslation();
  const apply = useApplyResult(task.id);
  const key = useRef(newKey());
  const [body, setBody] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Counts sent comments: a new key empties the file input.
  const [sent, setSent] = useState(0);
  const closed = task.status === 'closed' || task.status === 'cancelled';

  async function send() {
    if (body.trim() === '' && !photo) {
      setError(t('tasks.errors.EMPTY_COMMENT'));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.append('body', body.trim());
      if (photo) form.append('photo', photo);
      apply(await postForm(`/tasks/${task.id}/comments`, form, key.current));
      // The next comment is a new action: a new key.
      key.current = newKey();
      setBody('');
      setPhoto(null);
      setSent((n) => n + 1);
    } catch (e) {
      setError(errorMessage(t, e, 'tasks'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card role="group" aria-label={t('tasks.comments.title')} className="space-y-3">
      <h2 className="text-h3">{t('tasks.comments.title')}</h2>
      {task.comments.length === 0 && (
        <p className="text-small text-muted-foreground">{t('tasks.comments.none')}</p>
      )}
      <ul className="grid gap-3">
        {task.comments.map((comment) => (
          <li key={comment.id} className="grid gap-1 rounded-md bg-raised p-3">
            <p className="text-caption text-muted-foreground">
              <span className="font-medium text-foreground">{comment.author.name}</span>,{' '}
              {formatIst(comment.created_at)}
            </p>
            {comment.body && <p className="text-small whitespace-pre-wrap">{comment.body}</p>}
            {comment.attachment && (
              <a
                href={href(comment.attachment.url)}
                target="_blank"
                rel="noreferrer"
                className="w-40"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={href(comment.attachment.url)}
                  alt={t('tasks.comments.photoAlt', { name: comment.author.name })}
                  className="aspect-square w-full rounded-sm border object-cover"
                />
              </a>
            )}
          </li>
        ))}
      </ul>
      {task.can_manage && !closed && (
        <div className="grid gap-2">
          <label htmlFor="comment-body" className="text-small font-medium">
            {t('tasks.comments.write')}
          </label>
          <Textarea
            id="comment-body"
            maxLength={1000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <Input
            key={sent}
            aria-label={t('tasks.comments.photo')}
            type="file"
            accept="image/*"
            onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
          />
          {error && (
            <p role="alert" className="text-caption text-danger">
              {error}
            </p>
          )}
          <Button className="w-fit" onClick={() => void send()} disabled={busy}>
            {t('tasks.comments.send')}
          </Button>
        </div>
      )}
    </Card>
  );
}
