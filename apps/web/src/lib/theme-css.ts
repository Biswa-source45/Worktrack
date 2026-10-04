import { colors, motion, radius, shadow, typography, type ThemeName } from 'design-tokens';

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const rem = (px: number) => `${px / 16}rem`;

function themeVars(theme: ThemeName): string[] {
  const { color, ...levels } = shadow[theme];
  return [
    `color-scheme:${theme}`,
    ...Object.entries(colors[theme]).map(([role, value]) => `--wt-${kebab(role)}:${value}`),
    `--wt-shadow-color:${color}`,
    ...Object.entries(levels).map(
      ([level, s]) =>
        `--wt-shadow-${level}:0 ${s.y}px ${s.blur}px color-mix(in srgb,${color} ${Math.round(s.alpha * 100)}%,transparent)`,
    ),
  ];
}

const shared = [
  ...Object.entries(radius).map(([name, px]) => `--wt-radius-${name}:${px}px`),
  ...(['fast', 'base', 'slow'] as const).map((name) => `--wt-duration-${name}:${motion[name]}ms`),
  `--wt-ease-out:cubic-bezier(${motion.easeOut.join(',')})`,
  `--wt-press-scale:${motion.pressScale}`,
  ...Object.entries(typography.web).flatMap(([name, t]) => [
    `--wt-text-${name}:${rem(t.size)}`,
    `--wt-leading-${name}:${rem(t.line)}`,
    `--wt-weight-${name}:${t.weight}`,
  ]),
];

/** Every design token as a --wt-* CSS variable: light on :root, dark under .dark. */
export const themeCss = `:root{${[...shared, ...themeVars('light')].join(';')}}.dark{${themeVars('dark').join(';')}}`;
