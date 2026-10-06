import type { TFunction } from 'i18next';
import type { LucideIcon } from 'lucide-react-native';
import type { components, paths } from 'api-types';
import {
  Ban,
  CircleCheck,
  CircleMinus,
  CirclePause,
  CirclePlay,
  CircleX,
  Clock,
  Lock,
  MapPinCheck,
  UserRoundCheck,
} from '@/components/icons';
import type { BadgeStatus } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { ApiError, errorDetail, errorText, unwrap } from '@/lib/api-error';
import type { TaskAction } from '@/lib/punch-queue';

type Schemas = components['schemas'];
export type MyTask = Schemas['MyTask'];
export type TaskBrief = Schemas['TaskBrief'];
export type TaskDetail = Schemas['TaskDetail'];
export type ActionOut = Schemas['ActionOut'];
export type AssigneeOut = Schemas['AssigneeOut'];

// Every task action the phone can send must be a real path of the generated API (a compile error
// here means the backend renamed one and lib/task-actions.ts would send to nothing).
type MissingPaths = Exclude<`/api/v1/tasks/{task_id}/${TaskAction}`, keyof paths>;
export const ALL_ACTION_PATHS_EXIST: [MissingPaths] extends [never] ? true : never = true;

export type TaskList = 'active' | 'done' | 'assigned';
export const TASKS_KEY = ['tasks'] as const;
export const taskKey = (id: number) => ['tasks', 'detail', id] as const;
const PAGE = 30;

type Page = { items: (MyTask | TaskBrief)[]; next_cursor: string | null };

/** One page of the chosen list: my tasks (active or done) or the tasks I assigned (read-only). */
export function fetchTaskPage(list: TaskList, cursor: string | null): Promise<Page> {
  const query = { limit: PAGE, cursor };
  return list === 'assigned'
    ? unwrap(api.GET('/api/v1/tasks', { params: { query: { ...query, view: 'assigned_by_me' } } }))
    : unwrap(api.GET('/api/v1/me/tasks', { params: { query: { ...query, state: list } } }));
}

export const fetchTask = (id: number) =>
  unwrap(api.GET('/api/v1/tasks/{task_id}', { params: { path: { task_id: id } } }));

type Look = { status: BadgeStatus; icon: LucideIcon };
const LOOKS: Record<string, Look> = {
  assigned: { status: 'warning', icon: Clock },
  accepted: { status: 'info', icon: UserRoundCheck },
  reached: { status: 'info', icon: MapPinCheck },
  in_progress: { status: 'info', icon: CirclePlay },
  on_hold: { status: 'warning', icon: CirclePause },
  completed: { status: 'success', icon: CircleCheck },
  declined: { status: 'danger', icon: CircleX },
  cancelled: { status: 'neutral', icon: Ban },
  closed: { status: 'neutral', icon: Lock },
};

/** Status is icon + label + colour; a status the app does not know yet is shown neutral, as sent. */
export const statusLook = (status: string): Look =>
  LOOKS[status] ?? { status: 'neutral', icon: CircleMinus };

export const statusLabel = (t: TFunction, status: string) =>
  t(`tasks.status.${status}`, { defaultValue: status });

export type Step =
  'accept' | 'decline' | 'reach' | 'start' | 'hold' | 'resume' | 'note' | 'complete';

/** Which buttons the assignee is offered in each of their own statuses (the server checks again). */
const STEPS: Record<string, Step[]> = {
  assigned: ['accept', 'decline'],
  accepted: ['reach'],
  reached: ['start', 'note'],
  in_progress: ['hold', 'note', 'complete'],
  on_hold: ['resume', 'note'],
};
export const stepsFor = (status: string): Step[] => STEPS[status] ?? [];

/** Server messages are shown as they are; a bare code is explained in the app's words. */
export function taskErrorText(t: TFunction, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'PROOF_PHOTO_REQUIRED') {
      const kind = (error.details as { proof_kind?: string } | undefined)?.proof_kind;
      return t(kind === 'receipt' ? 'tasks.errors.receiptRequired' : 'tasks.errors.proofRequired');
    }
    if (error.message && error.message !== error.code) return error.message;
    return t(`tasks.errors.${error.code}`, { defaultValue: errorText(t, error) });
  }
  return errorText(t, error);
}

/** The short technical line shown under a failure, so it can be reported. */
export const taskErrorDetail = errorDetail;

/** The server gives file links relative to its own address; the phone opens them through the same base. */
export const absoluteUrl = (url: string) =>
  url.startsWith('/') ? `${process.env.EXPO_PUBLIC_API_URL ?? ''}${url}` : url;
