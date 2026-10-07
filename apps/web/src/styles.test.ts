import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs from apps/web.
const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

describe('scrollbars', () => {
  it('are thin everywhere and take their colour from a theme token at low opacity', () => {
    expect(css).toMatch(/scrollbar-width:\s*thin/);
    const colours = css.match(/scrollbar-color:[^;]+;/g) ?? [];
    expect(colours.length).toBeGreaterThanOrEqual(2);
    for (const rule of colours) {
      expect(rule).toContain('var(--muted-foreground)');
      expect(rule).toMatch(
        /color-mix\(in oklab, var\(--muted-foreground\) \d{1,2}%, transparent\)/,
      );
      expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    }
  });
});
