import { assess, type SeenFace, type Step, type Turn } from './face-guidance';

const VIEW = { width: 400, height: 800 };
// A face 200 px wide (half the screen) in the middle of the oval, eyes open, looking straight.
const good = (over: Partial<SeenFace> = {}): SeenFace => ({
  x: 100,
  y: 236,
  width: 200,
  height: 200,
  yaw: 0,
  roll: 0,
  leftEyeOpen: 0.9,
  rightEyeOpen: 0.9,
  ...over,
});
const hint = (faces: SeenFace[], step: Step = 0, firstTurn: Turn = 0) =>
  assess(faces, step, VIEW, firstTurn).hint;

describe('assess: finding one clear face', () => {
  it('accepts a centred, open-eyed face looking straight ahead', () => {
    expect(assess([good()], 0, VIEW, 0)).toEqual({ hint: 'ok', turn: 0 });
  });

  it('asks for a face when there is none, and for one face when there are two', () => {
    expect(hint([])).toBe('noFace');
    expect(hint([good(), good({ x: 0 })])).toBe('multiple');
  });

  it.each([
    [{ x: 130, width: 140, height: 140, y: 266 }, 'closer'], // 35% of the screen width
    [{ x: 30, width: 350, height: 350, y: 100 }, 'back'], // 87%
    [{ x: 0 }, 'center'],
    [{ x: 200 }, 'center'],
    [{ y: 0 }, 'center'],
    [{ y: 600 }, 'center'],
    [{ leftEyeOpen: 0.1 }, 'eyes'],
    [{ rightEyeOpen: 0.2 }, 'eyes'],
    [{ roll: 25 }, 'level'],
    [{ roll: -25 }, 'level'],
    [{ yaw: 20 }, 'straight'],
    [{ yaw: -20 }, 'straight'],
  ] as [Partial<SeenFace>, string][])('step 0 with %j asks: %s', (over, expected) => {
    expect(hint([good(over)])).toBe(expected);
  });

  it('does not block when the scanner gives no eye probabilities', () => {
    expect(hint([good({ leftEyeOpen: undefined, rightEyeOpen: undefined })])).toBe('ok');
    expect(hint([good({ leftEyeOpen: undefined, rightEyeOpen: 0.1 })])).toBe('eyes');
  });

  it('puts the framing problems before the eyes and the pose', () => {
    expect(hint([good({ x: 0, leftEyeOpen: 0.1, yaw: 30 })])).toBe('center');
    expect(hint([good({ leftEyeOpen: 0.1, yaw: 30 })], 0)).toBe('eyes');
  });
});

describe('assess: the turned photos', () => {
  it('step 1 wants a small turn to either side and remembers which one', () => {
    expect(assess([good({ yaw: 20 })], 1, VIEW, 0)).toEqual({ hint: 'ok', turn: 1 });
    expect(assess([good({ yaw: -20 })], 1, VIEW, 0)).toEqual({ hint: 'ok', turn: -1 });
    expect(hint([good({ yaw: 3 })], 1)).toBe('turn');
    expect(hint([good({ yaw: 50 })], 1)).toBe('turnLess');
    expect(hint([good({ yaw: -50 })], 1)).toBe('turnLess');
  });

  it('step 2 wants the other side', () => {
    expect(assess([good({ yaw: -20 })], 2, VIEW, 1)).toEqual({ hint: 'ok', turn: -1 });
    expect(assess([good({ yaw: 20 })], 2, VIEW, -1)).toEqual({ hint: 'ok', turn: 1 });
    expect(hint([good({ yaw: 20 })], 2, 1)).toBe('turnOther');
    expect(hint([good({ yaw: -20 })], 2, -1)).toBe('turnOther');
    expect(hint([good({ yaw: 0 })], 2, 1)).toBe('turnOther');
  });

  it('applies the same framing rules to the turned photos', () => {
    expect(hint([good({ yaw: 20, leftEyeOpen: 0.1 })], 1)).toBe('eyes');
    expect(hint([good({ yaw: 20, x: 0 })], 1)).toBe('center');
    expect(hint([], 1)).toBe('noFace');
  });
});
