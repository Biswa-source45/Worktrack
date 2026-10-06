import type { Integrity } from '@/lib/integrity';
import type { Fix } from '@/lib/location';

/** What the Reached screens share: set on the task detail, read by the camera screen. */
export type ReachFlow = { taskId: number; fix: Fix; integrity: Integrity };

// Module state, not route params: the position must not end up in a URL or a navigation log.
let flow: ReachFlow | null = null;

export const startReach = (next: ReachFlow) => {
  flow = next;
};
export const currentReach = () => flow;
export const endReach = () => {
  flow = null;
};
