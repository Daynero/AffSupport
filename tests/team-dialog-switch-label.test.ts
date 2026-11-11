import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const css = readFileSync(new URL('../apps/web/src/styles.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//gu,
  ''
);

/** The rule body of the first block whose selector list names `selector`. */
function ruleFor(selector: string): string | null {
  for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/gu)) {
    const selectors = match[1]!.split(',').map(part => part.trim());
    if (selectors.includes(selector)) return match[2]!;
  }
  return null;
}

it('keeps a switch caption in a team dialog on the line of its track (1.4.3)', () => {
  // `.team-dialog-form label` makes every label a grid; the switch's caption is a label.
  expect(ruleFor('.team-dialog-form label')).toMatch(/display:\s*grid/u);
  for (const selector of [
    '.team-dialog-form .ui-switch-label',
    '.team-dialog-form .ui-checkbox-content',
    '.team-invite-form .ui-switch-label'
  ])
    expect(ruleFor(selector), selector).toMatch(/display:\s*inline-flex/u);
});
