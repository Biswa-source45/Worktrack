'use client';

import { useRef, useState, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FaceBadge, Selfie } from '@/components/attendance/shared';
import { Field } from '@/components/field';
import { StatusBadge } from '@/components/status-badge';
import { Badge, type Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { formatIst } from '@/lib/ist';
import { newKey } from './task-api';
import { TaskStatusBadge } from './task-status';
import { useApplyResult } from './use-task';

type Task = Schemas['TaskDetail'];
type Assignee = Schemas['AssigneeOut'];
type Reach = NonNullable<Assignee['reach']>;

const REVIEW_TONE: Record<Reach['review'], Tone> = {
  none: 'neutral',
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
};

function ReviewBadge({ review }: { review: Reach['review'] }) {
  const { t } = useTranslation();
  return <StatusBadge tone={REVIEW_TONE[review]} label={t(`tasks.review.${review}`)} />;
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-small">
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** What the person did on arrival, shared by the card and the review dialog. */
function ReachFacts({ reach, radiusM }: { reach: Reach; radiusM: number }) {
  const { t } = useTranslation();
  return (
    <Facts
      rows={[
        [t('tasks.reach.at'), formatIst(reach.at)],
        [
          t('tasks.reach.distance'),
          reach.distance_m === null
            ? null
            : t('tasks.reach.distanceValue', { m: reach.distance_m, radius: radiusM }),
        ],
        [
          t('tasks.reach.accuracy'),
          reach.accuracy_m == null
            ? null
            : t('tasks.reach.accuracyValue', { m: Math.round(reach.accuracy_m) }),
        ],
        [t('tasks.reach.reason'), reach.reason],
        [
          t('tasks.reach.face'),
          reach.face_decision && <FaceBadge decision={reach.face_decision} />,
        ],
        // Only sent to someone with face.review; the employee never sees it.
        [t('tasks.reach.score'), reach.face_score == null ? null : reach.face_score.toFixed(2)],
      ]}
    />
  );
}

export function ReachFlags({ flags }: { flags: Reach['flags'] }) {
  const { t } = useTranslation();
  return flags.map((flag) => (
    <Badge key={flag} tone="warning">
      <TriangleAlert aria-hidden="true" />
      {t(`tasks.reachFlag.${flag}`)}
    </Badge>
  ));
}

function Metrics({ metrics }: { metrics: Assignee['metrics'] }) {
  const { t } = useTranslation();
  const minutes = (m: number | null) => (m === null ? null : t('tasks.metric.minutes', { m }));
  return (
    <Facts
      rows={[
        [t('tasks.metric.toAccept'), minutes(metrics.time_to_accept_min)],
        // Honest labels: this includes any wait before the person left, and the distance is a
        // straight line, not the road travelled (that needs tracking, M6).
        [t('tasks.metric.acceptToReached'), minutes(metrics.accept_to_reached_min)],
        [t('tasks.metric.onSite'), minutes(metrics.time_on_site_min)],
        [
          t('tasks.metric.straightLine'),
          metrics.straight_line_m === null
            ? null
            : t('tasks.metric.metres', { m: metrics.straight_line_m }),
        ],
      ]}
    />
  );
}

type ReviewProps = { task: Task; assignee: Assignee; onClose: () => void };

/** The selfie, the distance and the flags of one Reached, and the manager's decision on it. */
export function ReachReviewDialog({ task, assignee, onClose }: ReviewProps) {
  const { t } = useTranslation();
  const apply = useApplyResult(task.id);
  const key = useRef(newKey());
  const [remarks, setRemarks] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const reach = assignee.reach;

  async function decide(decision: 'approve' | 'reject') {
    const text = remarks.trim();
    if (decision === 'reject' && text === '') {
      setProblem('validation.reasonRequired');
      return;
    }
    setProblem(null);
    setError(null);
    setPending(true);
    try {
      apply(
        await unwrap(
          proxyApi().POST('/api/v1/tasks/{task_id}/assignees/{user_id}/reach-review', {
            params: {
              path: { task_id: task.id, user_id: assignee.user.id },
              header: { 'Idempotency-Key': key.current },
            },
            body: { decision, remarks: text || null },
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
      <DialogContent className="max-w-xl">
        <DialogTitle>{t('tasks.reach.reviewTitle')}</DialogTitle>
        <DialogDescription>
          {t('tasks.reach.reviewHint', { name: assignee.user.name, code: task.code })}
        </DialogDescription>
        {reach && (
          <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
            {reach.selfie_url ? (
              <Selfie
                url={reach.selfie_url}
                alt={t('tasks.reach.selfieAlt', { name: assignee.user.name })}
              />
            ) : (
              <p className="text-small text-muted-foreground">{t('tasks.reach.noSelfie')}</p>
            )}
            <div className="grid content-start gap-2">
              <div className="flex flex-wrap gap-1">
                <ReachFlags flags={reach.flags} />
              </div>
              <ReachFacts reach={reach} radiusM={task.site.radius_m} />
            </div>
          </div>
        )}
        <Field id="reach-remarks" label={t('tasks.reach.remarks')} error={problem ?? undefined}>
          <Textarea
            id="reach-remarks"
            maxLength={255}
            value={remarks}
            invalid={problem !== null}
            onChange={(e) => setRemarks(e.target.value)}
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
          <Button variant="destructive" onClick={() => void decide('reject')} disabled={pending}>
            {t('tasks.reach.reject')}
          </Button>
          <Button onClick={() => void decide('approve')} disabled={pending}>
            {t('tasks.reach.approve')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type CardProps = {
  task: Task;
  assignee: Assignee;
  myId: number;
  onReview: () => void;
  onRemove: () => void;
};

function AssigneeCard({ task, assignee, myId, onReview, onRemove }: CardProps) {
  const { t } = useTranslation();
  const reach = assignee.reach;
  const closed = task.status === 'closed' || task.status === 'cancelled';
  // The server refuses to remove anyone past Accepted, and to review your own Reached.
  const canRemove =
    task.can_manage && !closed && ['assigned', 'accepted'].includes(assignee.status);
  const canReview = task.can_manage && reach?.review === 'pending' && assignee.user.id !== myId;
  return (
    <Card
      role="group"
      aria-label={assignee.user.name}
      className="grid content-start gap-3"
      data-testid={`assignee-${assignee.user.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto leading-tight">
          <p className="font-semibold">{assignee.user.name}</p>
          <p className="text-caption text-muted-foreground">{assignee.user.emp_code}</p>
        </div>
        <TaskStatusBadge status={assignee.status} />
        {assignee.escalated_at && assignee.status === 'assigned' && (
          <Badge tone="warning">
            <TriangleAlert aria-hidden="true" />
            {t('tasks.flag.notAccepted')}
          </Badge>
        )}
      </div>
      <Facts
        rows={[
          [t('tasks.when.assigned'), formatIst(assignee.assigned_at)],
          [t('tasks.when.accepted'), assignee.accepted_at && formatIst(assignee.accepted_at)],
          [t('tasks.when.started'), assignee.started_at && formatIst(assignee.started_at)],
          [t('tasks.when.completed'), assignee.completed_at && formatIst(assignee.completed_at)],
          [t('tasks.when.declinedBecause'), assignee.declined_reason],
          [t('tasks.when.remarks'), assignee.completion_remarks],
        ]}
      />
      {reach && (
        <section
          aria-label={t('tasks.reach.title')}
          className="grid gap-2 rounded-md bg-raised p-3"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="mr-auto text-small font-semibold">{t('tasks.reach.title')}</h3>
            <ReachFlags flags={reach.flags} />
            <ReviewBadge review={reach.review} />
          </div>
          {reach.selfie_url && (
            <div className="w-24">
              <Selfie
                url={reach.selfie_url}
                alt={t('tasks.reach.selfieAlt', { name: assignee.user.name })}
              />
            </div>
          )}
          <ReachFacts reach={reach} radiusM={task.site.radius_m} />
          {reach.review_remarks && (
            <p className="text-small">
              <span className="text-muted-foreground">{t('tasks.reach.reviewedNote')}: </span>
              {reach.review_remarks}
              {reach.reviewed_by && ` (${reach.reviewed_by.name})`}
            </p>
          )}
        </section>
      )}
      <Metrics metrics={assignee.metrics} />
      {(canReview || canRemove) && (
        <div className="flex flex-wrap gap-2">
          {canReview && (
            <Button size="sm" onClick={onReview}>
              {t('tasks.reach.review')}
            </Button>
          )}
          {canRemove && (
            <Button size="sm" variant="outline" onClick={onRemove}>
              {t('tasks.assignee.remove', { name: assignee.user.name })}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

export function TaskAssignees({
  task,
  myId,
  onReview,
  onRemove,
}: {
  task: Task;
  myId: number;
  onReview: (assignee: Assignee) => void;
  onRemove: (assignee: Assignee) => void;
}) {
  const { t } = useTranslation();
  return (
    <section aria-label={t('tasks.assignee.title')} className="space-y-3">
      <h2 className="text-h3">{t('tasks.assignee.title')}</h2>
      <div className="grid gap-3 lg:grid-cols-2">
        {task.assignees.map((assignee) => (
          <AssigneeCard
            key={assignee.user.id}
            task={task}
            assignee={assignee}
            myId={myId}
            onReview={() => onReview(assignee)}
            onRemove={() => onRemove(assignee)}
          />
        ))}
      </div>
    </section>
  );
}
