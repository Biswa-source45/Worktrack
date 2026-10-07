import { describe, expect, it } from 'vitest';
import { fadeIn, itemEnter, pageEnter, slide, STAGGER_LIMIT } from './motion';

// setup.ts turns animations off for the whole suite; these tests switch them back on to see the
// presets as a visitor gets them.
import { MotionGlobalConfig } from 'motion/react';

function withAnimations<T>(run: () => T): T {
  MotionGlobalConfig.skipAnimations = false;
  try {
    return run();
  } finally {
    MotionGlobalConfig.skipAnimations = true;
  }
}

describe('motion presets', () => {
  it('slides in 200 ms on the shared ease-out curve', () => {
    expect(slide.duration).toBe(0.2);
    expect(slide.ease).toEqual([0.22, 1, 0.36, 1]);
  });

  it('fades a page up 8 px in 250 ms, and a skeleton or tab change in over 200 ms', () => {
    const page = withAnimations(pageEnter);
    expect(page.initial).toEqual({ opacity: 0, y: 8 });
    expect(page.transition.duration).toBe(0.25);
    const fade = withAnimations(fadeIn);
    expect(fade.initial).toEqual({ opacity: 0 });
    expect(fade.transition.duration).toBe(0.2);
  });

  it('staggers the first ten items 25 ms apart and leaves the rest still', () => {
    withAnimations(() => {
      expect(itemEnter(0).transition?.delay).toBe(0);
      expect(itemEnter(9).transition?.delay).toBeCloseTo(0.225);
      expect(itemEnter(STAGGER_LIMIT)).toEqual({});
      expect(itemEnter(40)).toEqual({});
    });
  });

  it('starts at the final state when animations are off, so tests see content at once', () => {
    expect(pageEnter().initial).toBe(false);
    expect(itemEnter(3).initial).toBe(false);
    expect(fadeIn().initial).toBe(false);
  });
});
