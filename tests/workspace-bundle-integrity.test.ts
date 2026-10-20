import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  honeycombViewBox,
  honeycombGrid,
  honeycombCells,
  honeycombTraces
} from '../apps/web/src/components/honeycomb-data';

it('preserves every original backdrop contour, tier and trace exactly', () => {
  expect(
    createHash('sha256')
      .update(JSON.stringify([honeycombViewBox, honeycombGrid, honeycombCells, honeycombTraces]))
      .digest('hex')
  ).toBe('2803a1fefef8766763833e97876df01c7d1ed78c8de74761236fd6440f0026f0');
});
it('includes structures for every imported HeroUI component and its component dependencies', () => {
  const styles = readFileSync('apps/web/src/styles/heroui.css', 'utf8');
  const required = new Set<string>();
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.tsx?$/u.test(entry.name)) {
        for (const match of readFileSync(file, 'utf8').matchAll(/@heroui\/react\/([a-z-]+)/gu))
          required.add(match[1]!);
      }
    }
  };
  visit('apps/web/src');
  const pending = [...required];
  while (pending.length) {
    const component = pending.pop()!;
    const directory = path.join('node_modules/@heroui/react/dist/components', component);
    for (const entry of readdirSync(directory).filter(name => name.endsWith('.js'))) {
      for (const match of readFileSync(path.join(directory, entry), 'utf8').matchAll(
        /from ['"]\.\.\/([a-z-]+)\//gu
      )) {
        if (!required.has(match[1]!)) {
          required.add(match[1]!);
          pending.push(match[1]!);
        }
      }
    }
  }
  for (const component of required)
    expect(styles, component).toContain(`@heroui/styles/components/${component}.css`);
  expect(styles).toContain('@heroui/styles/themes/default');
});
