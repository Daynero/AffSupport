import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync('apps/web/src/styles.css', 'utf8');
// Comments are stripped first: a comment ahead of a rule would otherwise be
// read as part of its selector.
const source = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule as a `[selector list, declarations]` pair. */
const rules: Array<[string, string]> = [
  ...source.matchAll(/(?:^|\n)\s*([^{}@\s][^{}]*?)\s*\{([^{}]*)\}/g)
].map(match => [match[1].trim(), match[2]]);

/** Selector list split on its top-level commas — `:is(a, b)` stays one part. */
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

/** A selector with its line breaks and runs of spaces collapsed to one space,
 *  so a lookup here survives Prettier rewrapping a long selector. */
function normalize(selector: string): string {
  return selector.replace(/\s+/g, ' ').trim();
}

/** Declarations of the rule that sizes `selector` (or its only rule). */
function block(selector: string): string {
  const wanted = normalize(selector);
  const matching = rules
    .filter(([list]) => selectorParts(list).map(normalize).includes(wanted))
    .map(([, body]) => body);
  expect(matching.length, `missing rule for ${selector}`).toBeGreaterThan(0);
  return matching.find(body => body.includes('width:')) ?? matching[0];
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

describe('page shell width', () => {
  it('grows with the display instead of freezing at a pixel cap', () => {
    const root = block(':root');
    expect(root).toMatch(/--shell-width:\s*max\(1440px,\s*80vw\)/);
    expect(root).toMatch(/--shell-width-narrow:\s*max\(1120px,\s*80vw\)/);
    expect(root).toMatch(/--shell-width-team:\s*max\(1240px,\s*80vw\)/);
  });

  // Every full-page container reads one of the three shell tokens, so the shell
  // measure can only ever be changed in one place.
  it.each([
    ['.workspace', '--shell-width'],
    ['.launcher', '--shell-width'],
    ['.landing-gallery-welcome', '--shell-width'],
    ['.public-home-content', '--shell-width'],
    ['.page-container', '--shell-width-narrow'],
    ['.public-footer', '--shell-width-narrow'],
    ['.team-space-page', '--shell-width-team'],
    ['.team-workspace-page', '--shell-width-team']
  ])('sizes %s from var(%s)', (selector, token) => {
    const rule = block(selector);
    expect(rule).toMatch(new RegExp(`width:\\s*min\\([^;]*var\\(${token}\\)`));
    expect(rule).not.toMatch(/width:\s*min\((1440|1240|1120)px/);
  });

  it('keeps the topbar controls on the shell axis on wide displays', () => {
    expect(block(':root')).toMatch(
      /--shell-gutter:\s*max\(var\(--app-header-padding-inline\), calc\(\(100% - var\(--shell-width\)\) \/ 2\)\)/
    );
    expect(block('.topbar')).toMatch(/padding:\s*0 var\(--shell-gutter\)/);
    expect(block('.login-topbar.public-topbar')).toMatch(/padding-inline:\s*var\(--shell-gutter\)/);
  });
});

describe('dialog width ladder', () => {
  it('defines every rung once, each scaling with the viewport', () => {
    const root = block(':root');
    expect(root).toMatch(/--dialog-sm:\s*clamp\(552px, 38vw, 760px\)/);
    expect(root).toMatch(/--dialog-md:\s*clamp\(576px, 40vw, 820px\)/);
    expect(root).toMatch(/--dialog-lg:\s*clamp\(624px, 43vw, 900px\)/);
    expect(root).toMatch(/--dialog-xl:\s*clamp\(880px, 61vw, 1240px\)/);
    expect(root).toMatch(/--dialog-wide:\s*clamp\(1180px, 72vw, 1600px\)/);
    expect(root).toMatch(/--dialog-full:\s*var\(--shell-width\)/);
  });

  // A `max()` of a pixel floor and a vw share only engages once the viewport
  // passes floor / share — which for the old rungs was ~2900px, so every
  // dialog was a fixed width on any display anyone actually owns. Each rung
  // must reach its vw share by the time a laptop is plugged into a monitor.
  it('starts growing before the viewport reaches a laptop-plus-monitor width', () => {
    const root = block(':root');
    const rungs = [...root.matchAll(/--dialog-(\w+):\s*clamp\((\d+)px,\s*(\d+)vw/g)];
    expect(rungs.length).toBe(5);
    for (const [, name, floor, share] of rungs) {
      const engagesAt = Number(floor) / (Number(share) / 100);
      expect(engagesAt, `--dialog-${name} only grows past ${Math.round(engagesAt)}px`).toBeLessThan(
        1700
      );
    }
  });

  it('sizes the Modal primitive from the ladder', () => {
    expect(block('.modal')).toMatch(
      /width:\s*min\(100%, var\(--modal-width, var\(--dialog-md\)\)\)/
    );
    expect(block('.modal-sm')).toMatch(/--modal-width:\s*var\(--dialog-sm\)/);
    expect(block('.modal-lg')).toMatch(/--modal-width:\s*var\(--dialog-lg\)/);
    expect(block('.modal-xl')).toMatch(/--modal-width:\s*var\(--dialog-xl\)/);
  });

  // The surfaces that style themselves instead of using the Modal primitive
  // are the ones that used to drift; they read the same rungs. The team
  // dialogs left this list when they moved onto `Modal`, which picks their rung
  // through `size` — one fewer place a width can be invented.
  it.each([
    ['.windows-coming-soon-modal', '--dialog-sm'],
    ['.confirm-dialog', '--dialog-sm'],
    ['.transcript-modal', '--dialog-xl'],
    ['.team-preview-dialog', '--dialog-wide'],
    ['.landing-compare-modal', '--dialog-wide'],
    ['.transcript-modal.transcript-split', '--dialog-full']
  ])('sizes %s from var(%s)', (selector, token) => {
    expect(block(selector)).toMatch(new RegExp(`var\\(${token}\\)`));
  });

  /**
   * Parts of a dialog that legitimately carry a pixel size — icon buttons, a
   * heading measure, the device frames of the landing preview — none of which
   * decide how wide the surface itself is.
   */
  const NOT_A_SURFACE =
    /(-close|-heading|-toolbar|::backdrop|[\s>+~]|\.tooltip-|\.transcription-copy-)/;

  it('leaves no dialog surface sized by a pixel value of its own', () => {
    const offenders = rules
      .filter(([selectors]) =>
        selectorParts(selectors).some(
          part => /modal|dialog/.test(part) && !NOT_A_SURFACE.test(part)
        )
      )
      .filter(([, body]) =>
        [...body.matchAll(/(?:^|[\s;])(?:max-)?width:([^;]*)/g)].some(
          ([, value]) => /\d+px/.test(value) && !/var\(--(dialog|shell)-/.test(value)
        )
      )
      .map(([selectors]) => selectors);
    expect(offenders).toEqual([]);
  });
});

describe('dialog fit', () => {
  const SURFACES =
    ":is(dialog, [role='dialog'], .team-operation-overlay, .team-text-editor, .team-process-dialog)";

  it('lets dialog content shrink and wrap instead of overflowing sideways', () => {
    expect(block('.modal')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(block('.team-preview-dialog')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(block(SURFACES)).toMatch(/overflow-wrap:\s*break-word/);
    expect(block(`${SURFACES} *`)).toMatch(/min-width:\s*0/);
    // Matched by name, not by a list: the list is what left every row added
    // later (the transcript column head, the library heading) overflowing.
    expect(block(`${SURFACES} [class*='actions']`)).toMatch(/flex-wrap:\s*wrap/);
  });

  // A per-dialog width that fights the size class is what made the model
  // download dialog narrower than its own button row. Dialogs pick a width by
  // setting --modal-width, never by capping the surface.
  it('never lets a single dialog override the ladder with a fixed width', () => {
    const classes = new Set<string>();
    for (const file of tsxFiles('apps/web/src')) {
      const source = readFileSync(file, 'utf8');
      for (const [element] of source.matchAll(/<Modal\b[\s\S]*?>/g)) {
        if (/\bbare\b/.test(element)) continue; // bare surfaces style themselves
        const className = element.match(/className=(?:"([^"]*)"|\{`([^`]*)`\})/);
        for (const token of (className?.[1] ?? className?.[2] ?? '').split(/\s+/)) {
          if (token && !token.includes('${')) classes.add(token);
        }
      }
    }
    expect(classes.size).toBeGreaterThan(0);

    const offenders = [...classes].filter(name => {
      const rule = css.match(new RegExp(`(?:^|\\n)\\.${name}\\s*\\{([^}]*)\\}`))?.[1];
      return rule ? /(?:max-width|width):\s*(?:min\()?\d/.test(rule) : false;
    });
    expect(offenders).toEqual([]);
  });
});
