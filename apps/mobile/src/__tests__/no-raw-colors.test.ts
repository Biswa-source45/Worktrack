import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

// Colours come only from the design tokens through useTheme(). The same rule runs in ESLint
// (eslint.config.js); this test also covers anything the linter is told to ignore.
const SRC = join(__dirname, '..');

const NAMES =
  'white|black|red|green|blue|yellow|orange|purple|pink|gr[ae]y|brown|cyan|magenta|silver|gold|navy|teal|maroon|olive|lime|aqua|fuchsia|indigo|violet|beige|ivory|coral|salmon|crimson|khaki|tan';

const RAW_COLOURS: [string, RegExp][] = [
  ['hex colour', /['"`]#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})['"`]/i],
  ['colour function', /\b(?:rgba?|hsla?)\(/i],
  ['colour name', new RegExp(`['"\`](?:${NAMES})['"\`]`, 'i')],
];

function findRawColours(source: string): string[] {
  return source
    .split('\n')
    .flatMap((line, index) =>
      RAW_COLOURS.filter(([, pattern]) => pattern.test(line)).map(
        ([kind]) => `line ${index + 1}: ${kind}: ${line.trim()}`,
      ),
    );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' || entry.name === 'test' ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('no raw colours', () => {
  it.each([
    ["{ color: '#b00020' }", 'hex colour'],
    ['{ borderColor: "#ccc" }', 'hex colour'],
    ["{ backgroundColor: '#FFF3CD80' }", 'hex colour'],
    ["{ color: 'rgb(0, 0, 0)' }", 'colour function'],
    ["{ color: 'rgba(0,0,0,0.5)' }", 'colour function'],
    ['{ color: `hsl(20 50% 50%)` }', 'colour function'],
    ["{ backgroundColor: 'white' }", 'colour name'],
    ["{ color: 'black' }", 'colour name'],
    ['<Icon color="red" />', 'colour name'],
  ])('the scanner catches %s', (sample, kind) => {
    expect(findRawColours(sample)).toEqual([expect.stringContaining(kind)]);
  });

  it.each([
    "{ backgroundColor: 'transparent' }",
    '{ color: colors.primaryText }',
    "const id = '#12';",
    "t('theme.dark')",
  ])('the scanner allows %s', (sample) => {
    expect(findRawColours(sample)).toEqual([]);
  });

  it('finds the source files and none of them has a raw colour', () => {
    const files = sourceFiles(SRC);
    const names = files.map((file) => relative(SRC, file).replace(/\\/g, '/'));
    expect(names).toEqual(
      expect.arrayContaining(['app/_layout.tsx', 'components/ui/button.tsx', 'lib/theme.tsx']),
    );
    expect(names.filter((name) => /(^|\/)(__tests__|test)\/|\.test\./.test(name))).toEqual([]);

    const offences = files.flatMap((file) =>
      findRawColours(readFileSync(file, 'utf8')).map((hit) => `${relative(SRC, file)} ${hit}`),
    );
    expect(offences).toEqual([]);
  });
});
