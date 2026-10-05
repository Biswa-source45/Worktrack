// @vitest-environment node
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

// Runs the real apps/web ESLint config, so the rule cannot be dropped or loosened unnoticed.
const eslint = new ESLint({ cwd: fileURLToPath(new URL('../..', import.meta.url)) });

async function rawColourErrors(code: string, filePath = 'src/components/example.tsx') {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.ruleId === 'no-restricted-syntax').map((m) => m.message);
}

const jsx = (className: string) => `export const X = () => <div className="${className}" />;\n`;

// Loading the Next ESLint config on the first lint took 42 s on a busy machine (a few seconds on a
// quiet one). It happens once, in a setup hook with its own limit, so no test pays for it: that
// made the first test fail now and then on slow CI runners.
describe('no raw colour rule', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await rawColourErrors('export const warm = 1;');
  }, 180_000);

  it.each([
    ['a 3-digit hex colour', `export const c = '#abc';\n`, 'Hex colour'],
    ['a 6-digit hex colour', `export const c = '#A65A2E';\n`, 'Hex colour'],
    ['an 8-digit hex colour', `export const c = '#a65a2e80';\n`, 'Hex colour'],
    ['a hex colour in a template', 'export const c = (w: number) => `${w}px solid #fff`;\n', 'Hex'],
    ['rgb()', `export const c = 'rgb(0 0 0)';\n`, 'Colour function'],
    ['rgba()', `export const c = 'rgba(0, 0, 0, 0.5)';\n`, 'Colour function'],
    ['hsl()', `export const c = 'hsl(20 50% 40%)';\n`, 'Colour function'],
    ['oklch()', `export const c = 'oklch(0.7 0.1 50)';\n`, 'Colour function'],
    ['oklch() in a template', 'export const c = (l: number) => `oklch(${l} 0 0)`;\n', 'Colour'],
    ['a palette background', jsx('p-2 bg-red-500'), 'Tailwind palette class'],
    ['a palette text colour', jsx('text-zinc-400'), 'Tailwind palette class'],
    ['a palette border', jsx('border border-slate-200'), 'Tailwind palette class'],
    ['black with opacity', jsx('fixed inset-0 bg-black/50'), 'Tailwind palette class'],
    ['white text', jsx('text-white'), 'Tailwind palette class'],
    ['a palette class behind a variant', jsx('hover:bg-blue-600'), 'Tailwind palette class'],
    [
      'a palette class in a template',
      'export const c = (a: string) => `${a} ring-rose-300`;\n',
      'Tailwind',
    ],
  ])('reports %s', async (_, code, message) => {
    const errors = await rawColourErrors(code);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(message);
  });

  it.each([
    ['token classes', jsx('bg-primary text-muted-foreground bg-success-subtle')],
    ['token classes with opacity and variants', jsx('hover:bg-raised/50 border-danger/40')],
    ['layout classes that only look similar', jsx('text-h1 border-t whitespace-nowrap to-pink')],
    ['a CSS variable', `export const c = 'var(--wt-primary)';\n`],
    ['an id reference', 'export const c = (id: number) => `#${id}`;\n'],
    ['a fragment that is not a colour', `export const c = '#deadline';\n`],
  ])('accepts %s', async (_, code) => {
    expect(await rawColourErrors(code)).toEqual([]);
  });

  it('leaves test files alone, where colours are named on purpose', async () => {
    expect(await rawColourErrors(`export const c = '#FFFFFF';\n`, 'src/test/x.test.ts')).toEqual(
      [],
    );
  });
});
