import { MotionGlobalConfig } from 'motion/react';
import { motion as tokens } from 'design-tokens';

// The web motion presets (docs/DESIGN.md 9f). Durations and the curve come from the shared tokens;
// only transform and opacity ever animate. `MotionConfig reducedMotion="user"` (MotionProvider)
// drops the movement, and keeps a plain fade, for people who ask for less.

const ease = tokens.easeOut;
const seconds = (ms: number) => ms / 1000;

/** The sliding active indicator (sidebar, tabs, theme toggle): `layoutId` plus this transition. */
export const slide = { duration: seconds(tokens.base), ease } as const;

export const STAGGER_S = 0.025;
export const STAGGER_LIMIT = 10;

// Tests turn animations off globally (setup.ts). Entrances then start at their final state, so
// content is there on the first render instead of one frame later.
const still = () => MotionGlobalConfig.skipAnimations === true;

/** Fades in while rising `y` px: the page, and (with a delay) the items of a list. */
function rise(y: number, delay: number, duration: number) {
  return {
    initial: still() ? false : { opacity: 0, y },
    animate: { opacity: 1, y: 0 },
    transition: { duration: seconds(duration), ease, delay },
  };
}

/** A screen arriving: fades up 8 px in 250 ms. */
export const pageEnter = () => rise(8, 0, tokens.slow);

/**
 * The i-th row or card of a list: fades up 4 px, 25 ms after the one before. Items past the tenth
 * (and every later "load more") appear at once. Only opacity and position move, so a control is
 * clickable from the first frame.
 */
export function itemEnter(index: number): Partial<ReturnType<typeof rise>> {
  if (index >= STAGGER_LIMIT) return {};
  return rise(4, index * STAGGER_S, tokens.base);
}

/** Content arriving where a skeleton was, and a tab's panel after a tab change: a 200 ms fade. */
export const fadeIn = () => ({
  initial: still() ? (false as const) : { opacity: 0 },
  animate: { opacity: 1 },
  transition: { duration: seconds(tokens.base), ease },
});
