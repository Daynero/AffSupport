import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

/**
 * 1.4.3 QA: the corner stack of long-work panels is a box around them, gaps
 * included, fixed over the file grid. A press on a card under that box went to
 * the stack instead, and with three panels the first title left the window.
 */
const css = readFileSync(path.join(__dirname, '../apps/web/src/styles.css'), 'utf8');
const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(css);
  return match?.[1] ?? '';
};

it('lets only the panels in the corner stack take the pointer', () => {
  expect(rule('.team-process-stack')).toMatch(/pointer-events:\s*none/u);
  expect(rule('.team-process-stack > *')).toMatch(/pointer-events:\s*auto/u);
});

it('keeps the corner stack inside the window and scrolls it inside itself', () => {
  const stack = rule('.team-process-stack');
  expect(stack).toMatch(/max-height:\s*calc\(100dvh - 2 \* var\(--space-4\)\)/u);
  expect(stack).toMatch(/overflow-y:\s*auto/u);
});
