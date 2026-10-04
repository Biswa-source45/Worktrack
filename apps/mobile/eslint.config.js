const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

// Colours come only from the design tokens through useTheme() ('transparent' is allowed).
// src/__tests__/no-raw-colors.test.ts scans for the same patterns.
const COLOUR_NAMES =
  'white|black|red|green|blue|yellow|orange|purple|pink|gr[ae]y|brown|cyan|magenta|silver|gold|navy|teal|maroon|olive|lime|aqua|fuchsia|indigo|violet|beige|ivory|coral|salmon|crimson|khaki|tan';
const HEX = '^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$';
const FUNCTION = '\\b(rgba?|hsla?)\\(';
const message = 'Raw colour: use a colour role from useTheme() instead.';

const noRawColours = [
  'error',
  { selector: `Literal[value=/${HEX}/i]`, message },
  { selector: `Literal[value=/${FUNCTION}/i]`, message },
  { selector: `TemplateElement[value.raw=/${FUNCTION}/i]`, message },
  { selector: `Property > Literal.value[value=/^(${COLOUR_NAMES})$/i]`, message },
  { selector: `JSXAttribute > Literal.value[value=/^(${COLOUR_NAMES})$/i]`, message },
];

module.exports = defineConfig([
  expoConfig,
  { ignores: ['dist/*', '.expo/*'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}', 'src/__tests__/**', 'src/test/**'],
    rules: { 'no-restricted-syntax': noRawColours },
  },
  {
    // The package index would bundle every lucide icon; icons come from src/components/icons.ts.
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'lucide-react-native',
              message:
                'Import icons from @/components/icons (one file per icon keeps the bundle small).',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
]);
