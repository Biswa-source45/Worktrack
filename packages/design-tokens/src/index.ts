// Single source of the WorkTrack design tokens for web and mobile.
// Colour values exist only in this file; components use the role names.

export type ThemeName = 'light' | 'dark';

const dark = {
  background: '#131417',
  surface: '#1C1E22',
  raised: '#25282D',
  text: '#F5F3F0',
  muted: '#9C9690',
  primary: '#C67C4E',
  // Charcoal, not white: white on the dark-theme copper is only 3.28:1.
  primaryForeground: '#131417',
  // Copper as text or links (the button copper is too dark for small text on raised surfaces).
  primaryText: '#DB9970',
  // Decorative separators and card edges only (1.2-1.4:1).
  border: '#2C2F35',
  // Form-control borders, which need 3:1 against their surroundings.
  borderStrong: '#6E727B',
  ring: '#C67C4E',
  successFg: '#62C48B',
  successSubtle: '#17291F',
  warningFg: '#E3B24B',
  warningSubtle: '#2C2514',
  dangerFg: '#F2766C',
  dangerSubtle: '#2F1C1B',
  infoFg: '#6EAEF2',
  infoSubtle: '#172335',
};

export type Colors = typeof dark;

const light: Colors = {
  background: '#F8F5F1',
  surface: '#FFFFFF',
  raised: '#F1ECE6',
  text: '#1C1B1A',
  muted: '#6B6560',
  primary: '#A65A2E',
  primaryForeground: '#FFFFFF',
  primaryText: '#8F4D26',
  border: '#E6DFD7',
  borderStrong: '#8A837C',
  ring: '#A65A2E',
  successFg: '#1B7A45',
  successSubtle: '#E4F3EA',
  warningFg: '#855600',
  warningSubtle: '#FAEFD2',
  dangerFg: '#B3261E',
  dangerSubtle: '#FBE5E3',
  infoFg: '#1C5CA8',
  infoSubtle: '#E2EDFA',
};

export const colors: Record<ThemeName, Colors> = { light, dark };

/** Fixed meanings: success = verified/active, warning = pending, danger = rejected/revoked/alert, info = on field. */
export type Status = 'success' | 'warning' | 'danger' | 'info';

export const radius = { sm: 8, md: 12, lg: 16, xl: 24, pill: 9999 } as const;

/** 4px base. */
export const spacing = [4, 8, 12, 16, 20, 24, 32, 40, 48, 64] as const;

type Shadow = { y: number; blur: number; alpha: number };
/** Warm brown on light, black on dark. Levels: sm = cards at rest, md = hover/raised, lg = dialogs. */
export const shadow: Record<ThemeName, { color: string; sm: Shadow; md: Shadow; lg: Shadow }> = {
  light: {
    color: '#3B2A1E',
    sm: { y: 1, blur: 3, alpha: 0.08 },
    md: { y: 6, blur: 16, alpha: 0.1 },
    lg: { y: 16, blur: 40, alpha: 0.14 },
  },
  dark: {
    color: '#000000',
    sm: { y: 1, blur: 3, alpha: 0.35 },
    md: { y: 6, blur: 16, alpha: 0.42 },
    lg: { y: 16, blur: 40, alpha: 0.5 },
  },
};

/** Milliseconds. Only transform and opacity animate; colours cross-fade on a theme switch. */
export const motion = {
  fast: 150,
  base: 200,
  slow: 250,
  /** cubic-bezier control points of the one ease-out curve. */
  easeOut: [0.22, 1, 0.36, 1],
  pressScale: 0.97,
} as const;

export const fontFamily = 'Plus Jakarta Sans';

type TypeStyle = { size: number; line: number; weight: 400 | 500 | 600 | 700 };
const type = (size: number, line: number, weight: TypeStyle['weight'] = 400): TypeStyle => ({
  size,
  line,
  weight,
});

export const typography = {
  web: {
    caption: type(12, 16),
    small: type(13, 20),
    body: type(14, 22),
    large: type(16, 24),
    h3: type(18, 26, 600),
    h2: type(22, 30, 700),
    h1: type(28, 36, 700),
  },
  mobile: {
    caption: type(12, 16),
    small: type(14, 20),
    body: type(16, 24),
    large: type(18, 26),
    h3: type(20, 28, 600),
    h2: type(24, 32, 700),
    h1: type(28, 36, 700),
  },
} as const;

export type TypeToken = keyof typeof typography.web;

/** Smallest touch target on mobile, in points. */
export const minTouchTarget = 44;
