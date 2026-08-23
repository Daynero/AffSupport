import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('apps/web/src/styles.css', 'utf8');
const source = css.replace(/\/\*[\s\S]*?\*\//g, '');

const rules: Array<[string, string]> = [
  ...source.matchAll(/(?:^|\n)\s*([^{}@\s][^{}]*?)\s*\{([^{}]*)\}/g)
].map(match => [match[1].trim(), match[2]]);

function selectorParts(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of list) {
    if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  return [...parts, current.trim()];
}

const normalize = (selector: string) => selector.replace(/\s+/g, ' ').trim();

function blocks(selector: string): string[] {
  const wanted = normalize(selector);
  const matching = rules
    .filter(([list]) => selectorParts(list).map(normalize).includes(wanted))
    .map(([, body]) => body);
  expect(matching.length, `missing rule for ${selector}`).toBeGreaterThan(0);
  return matching;
}

const joined = (selector: string) => blocks(selector).join('\n');

/**
 * A catalog row is `name | actions | category`. The shared list rule puts an
 * auto margin on the name and another on the trailing `small`, which splits the
 * free space between them — so each row's actions began at a different x and the
 * whole catalog read as ragged. These rules pin the three parts into columns.
 */
describe('catalog material row alignment', () => {
  it('lets the name take the row instead of pushing the actions around', () => {
    const rule = joined('.team-material-browser .team-material-list li > :first-child');
    expect(rule).toMatch(/flex:\s*1\s+1\s+/);
    // The inherited `margin-right: auto` is what made the actions float.
    expect(rule).toMatch(/margin-right:\s*0/);
  });

  it('anchors the action group to one edge in every row', () => {
    const rule = joined('.team-material-row-actions');
    expect(rule).toMatch(/margin-left:\s*auto/);
    expect(rule).toMatch(/flex:\s*0\s+0\s+auto/);
  });

  it('gives the category a fixed column rather than a floating auto margin', () => {
    const rule = joined('.team-material-browser .team-material-list small');
    expect(rule).toMatch(/flex:\s*0\s+0\s+/);
    expect(rule).toMatch(/text-align:\s*right/);
    expect(rule).not.toMatch(/margin-left:\s*auto/);
  });
});
