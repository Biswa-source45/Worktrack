import type { TFunction } from 'i18next';
import type { ApiError } from '@/lib/api-error';
import type { Integrity } from '@/lib/integrity';
import type { Fix } from '@/lib/location';
import type { PunchResult } from '@/lib/punch';
import type { QueueKind } from '@/lib/punch-queue';

/** What the screens of one punch share: set on Home, read by the camera, cleared on the result. */
export type Flow = {
  kind: QueueKind;
  fix: Fix;
  integrity: Integrity;
  reason?: string;
  note?: string;
};

export type Outcome =
  | { type: 'sent'; kind: QueueKind; result: PunchResult }
  | { type: 'queued'; kind: QueueKind }
  | { type: 'rejected'; error: ApiError };

// Module state, not route params: the position must not end up in a URL or a navigation log.
let flow: Flow | null = null;
let outcome: Outcome | null = null;

export const startFlow = (next: Flow) => {
  flow = next;
  outcome = null;
};
export const currentFlow = () => flow;
export const addReason = (reason: string, note?: string) => {
  if (flow) flow = { ...flow, reason, note };
};
export const finishAttempt = (result: Outcome) => {
  outcome = result;
};
export const currentOutcome = () => outcome;
export const endFlow = () => {
  flow = null;
  outcome = null;
};

/**
 * The server's own sentence when it has one; a message that only repeats the code is no help,
 * so the code is then explained in the app's words.
 */
export function punchErrorText(t: TFunction, error: ApiError): string {
  if (error.message && error.message !== error.code) return error.message;
  return t(`punch.errors.${error.code}`, {
    defaultValue: t('errors.server', { status: error.status }),
  });
}
