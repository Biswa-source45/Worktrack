import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// docs/DESIGN.md: colour values exist only in packages/design-tokens; components use role
// classes (bg-primary, text-muted-foreground, bg-success-subtle). The patterns have no "/"
// because esquery ends a regex at the first one.
const HEX = '#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\\b';
const COLOR_FUNCTION = '\\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\\(';
const PALETTE_CLASS =
  '(^|[\\s:])-?(bg|text|border|outline|ring|ring-offset|divide|decoration|accent|caret|fill|stroke|shadow|inset-shadow|from|via|to|placeholder)-(black|white|(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3})\\b';

const rawColour = [
  [HEX, 'Hex colour'],
  [COLOR_FUNCTION, 'Colour function'],
  [PALETTE_CLASS, 'Tailwind palette class'],
].flatMap(([pattern, what]) =>
  [`Literal[value=/${pattern}/]`, `TemplateElement[value.raw=/${pattern}/]`].map((selector) => ({
    selector,
    message: `${what}: use a design-token role class or CSS variable instead (docs/DESIGN.md).`,
  })),
);

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ['src/**/*.{ts,tsx}'],
    // Tests name raw colours on purpose (the contrast test, this rule's own test).
    ignores: ['src/**/*.test.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...rawColour] },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    '.next-e2e/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
  ]),
]);

export default eslintConfig;
