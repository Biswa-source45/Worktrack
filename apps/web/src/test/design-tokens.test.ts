import { colors, type Colors, type ThemeName } from 'design-tokens';
import { describe, expect, it } from 'vitest';

// WCAG 2.2 relative luminance and contrast ratio.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

type Role = keyof Colors;
const SURFACES: Role[] = ['background', 'surface', 'raised'];
const STATUSES = ['success', 'warning', 'danger', 'info'] as const;

// Every pair of docs/DESIGN.md section 4: [foreground, background].
const TEXT_PAIRS: [Role, Role][] = [
  ...SURFACES.flatMap((s): [Role, Role][] => [
    ['text', s],
    ['muted', s],
    ['primaryText', s],
  ]),
  ['primaryForeground', 'primary'],
  ...STATUSES.flatMap((s): [Role, Role][] => [
    [`${s}Fg`, `${s}Subtle`],
    [`${s}Fg`, 'surface'],
  ]),
];
const UI_PAIRS: [Role, Role][] = SURFACES.flatMap((s): [Role, Role][] => [
  ['primary', s],
  ['borderStrong', s],
  ['ring', s],
]);

describe.each(['light', 'dark'] as ThemeName[])('%s theme', (theme) => {
  const c = colors[theme];

  it('defines every role as a six-digit hex colour', () => {
    expect(Object.keys(c).sort()).toEqual(Object.keys(colors.dark).sort());
    for (const value of Object.values(c)) expect(value).toMatch(/^#[0-9A-F]{6}$/);
  });

  it.each(TEXT_PAIRS)('text %s on %s is at least 4.5:1', (fg, bg) => {
    expect(contrast(c[fg], c[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(UI_PAIRS)('UI part %s against %s is at least 3:1', (fg, bg) => {
    expect(contrast(c[fg], c[bg])).toBeGreaterThanOrEqual(3);
  });

  it('keeps status colours clearly apart from copper and from each other', () => {
    const hues = [c.primary, ...STATUSES.map((s) => c[`${s}Fg`])];
    expect(new Set(hues).size).toBe(hues.length);
  });
});

it('the contrast helper matches known values', () => {
  expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
  // White on the dark-theme copper fails AA, which is why primaryForeground is charcoal there.
  expect(contrast('#FFFFFF', colors.dark.primary)).toBeLessThan(4.5);
  expect(contrast(colors.dark.primaryForeground, colors.dark.primary)).toBeCloseTo(5.61, 1);
});
