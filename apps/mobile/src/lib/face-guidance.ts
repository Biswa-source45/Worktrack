// What the phone tells the employee while it looks for a good enrollment photo. These are hints
// that save a round trip; the server checks every photo again and is the authority.

/** 0: straight at the camera, 1: head turned a little, 2: turned a little to the other side. */
export type Step = 0 | 1 | 2;
/** Which way the head was turned in step 1: -1 or 1 (the sign of the yaw), 0 before that. */
export type Turn = -1 | 0 | 1;

export type Hint =
  | 'ok'
  | 'noFace'
  | 'multiple'
  | 'closer'
  | 'back'
  | 'center'
  | 'eyes'
  | 'level'
  | 'straight'
  | 'turn'
  | 'turnLess'
  | 'turnOther';

/** A face as the scanner reports it, in the coordinates of the screen. */
export type SeenFace = {
  x: number;
  y: number;
  width: number;
  height: number;
  yaw: number;
  roll: number;
  leftEyeOpen?: number;
  rightEyeOpen?: number;
};

export type View = { width: number; height: number };

// Face width as a share of the screen width.
// Low on purpose: the scanner scales to the screen with the width and height of the camera
// picture separately, so on a tall phone the share it reports is smaller than what is seen.
const MIN_WIDTH = 0.25;
const MAX_WIDTH = 0.85;
// How far the face centre may be from the oval's centre, as a share of the screen.
const CENTER_TOLERANCE = 0.18;
// The oval sits a little above the middle, away from the buttons.
const OVAL_CENTER_Y = 0.42;
const EYES_OPEN = 0.4;
const MAX_ROLL = 15;
const STRAIGHT_YAW = 10;
const TURN_MIN = 12;
const TURN_MAX = 35;

/** How long everything must stay right before the photo is taken, in milliseconds. */
export const HOLD_MS = 700;

const sign = (value: number): -1 | 1 => (value < 0 ? -1 : 1);

/**
 * The most important thing to fix now, or 'ok'. `turn` is the head turn to remember when the
 * photo of step 1 is taken, so step 2 can ask for the other side. The turn direction is never
 * named to the employee (the front camera is mirrored and the sign differs between phones).
 */
export function assess(
  faces: SeenFace[],
  step: Step,
  view: View,
  firstTurn: Turn,
): { hint: Hint; turn: Turn } {
  const none = (hint: Hint) => ({ hint, turn: 0 as Turn });
  if (faces.length === 0) return none('noFace');
  if (faces.length > 1) return none('multiple');
  const face = faces[0];

  const share = face.width / view.width;
  if (share < MIN_WIDTH) return none('closer');
  if (share > MAX_WIDTH) return none('back');

  const dx = Math.abs(face.x + face.width / 2 - view.width / 2) / view.width;
  const dy = Math.abs(face.y + face.height / 2 - view.height * OVAL_CENTER_Y) / view.height;
  if (dx > CENTER_TOLERANCE || dy > CENTER_TOLERANCE) return none('center');

  // Eye probabilities are missing when the scanner could not tell: do not block on that.
  const eyes = [face.leftEyeOpen, face.rightEyeOpen].filter((v): v is number => v !== undefined);
  if (eyes.some((open) => open < EYES_OPEN)) return none('eyes');
  if (Math.abs(face.roll) > MAX_ROLL) return none('level');

  const yaw = Math.abs(face.yaw);
  if (step === 0) return yaw <= STRAIGHT_YAW ? { hint: 'ok', turn: 0 } : none('straight');
  if (yaw < TURN_MIN) return none(step === 2 ? 'turnOther' : 'turn');
  if (yaw > TURN_MAX) return none('turnLess');
  const turn = sign(face.yaw);
  if (step === 2 && turn === firstTurn) return none('turnOther');
  return { hint: 'ok', turn };
}
