import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The theme bridge (024): Soty's tokens, handed to HeroUI.
 *
 * The library is themed by CSS custom properties, so the bridge is the whole of
 * the product's authority over how it looks. Two ways that authority can be
 * lost silently, and this file exists for both:
 *
 *  - a name goes stale. The bridge defines `--accent`; a library upgrade renames
 *    it; nothing breaks, nothing warns, and every accent quietly becomes the
 *    library's blue. So every name the bridge defines is checked against the
 *    installed stylesheet.
 *  - a literal creeps in. `tokens.css` is the one file the CSS gate exempts,
 *    which makes it the one place a hex could hide. So every right-hand side in
 *    the bridge is checked to be a token reference.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = path.join(root, 'apps/web/src/styles/tokens.css');
const ENTRY = path.join(root, 'apps/web/src/styles/index.css');
const HEROUI = path.join(root, 'node_modules/@heroui/styles/dist/heroui.min.css');

const tokens = readFileSync(TOKENS, 'utf8');
const entry = readFileSync(ENTRY, 'utf8');
const heroui = readFileSync(HEROUI, 'utf8');

/** The bridge block, as its own text — everything between its banner and the next one. */
function bridgeBlock(): string {
  const start = tokens.indexOf('The theme bridge (024)');
  expect(start, 'the bridge banner is gone from tokens.css').toBeGreaterThan(-1);
  const open = tokens.indexOf('{', start);
  const close = tokens.indexOf('\n}', open);
  return tokens.slice(open + 1, close);
}

function declarations(block: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of block.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gmu)) {
    found.set(match[1], match[2].trim());
  }
  return found;
}

const bridge = declarations(bridgeBlock());

describe('the theme bridge', () => {
  it('defines something', () => {
    expect(bridge.size).toBeGreaterThan(30);
  });

  it('defines only names the installed library actually reads', () => {
    // A name the library neither declares nor reads is a name that does
    // nothing — a typo, or a leftover from a version that has moved on.
    const stale = [...bridge.keys()].filter(name => !heroui.includes(name));
    expect(stale, 'the bridge names variables HeroUI does not use').toEqual([]);
  });

  it('covers every role the product has an opinion about', () => {
    const required = [
      '--background',
      '--foreground',
      '--surface',
      '--overlay',
      '--muted',
      '--border',
      '--separator',
      '--backdrop',
      '--accent',
      '--accent-foreground',
      '--success',
      '--warning',
      '--danger',
      '--focus',
      '--field-background',
      '--field-border',
      '--radius'
    ];
    const missing = required.filter(name => !bridge.has(name));
    expect(missing, 'the library would fall back to its own colour here').toEqual([]);
  });

  it('spells no value of its own', () => {
    // Everything is either a token reference, one of the few bare constants
    // that are themselves product facts (a hairline, the focus ring's offset),
    // or a keyword — `shimmer` names a behaviour, not a colour or a length, so
    // it is not the kind of literal the token layer exists to hold.
    const allowedBare = /^(?:0|1px|2px|[a-z-]+)$/u;
    const literals = [...bridge.entries()].filter(
      ([, value]) => !value.startsWith('var(') && !allowedBare.test(value)
    );
    expect(literals.map(([name, value]) => `${name}: ${value}`)).toEqual([]);
  });

  it('inherits the dark theme rather than repeating it', () => {
    // The bridge is written once. It works in dark because the Soty roles it
    // reads are themselves redefined under [data-theme='dark'] — so a role the
    // dark block forgets is a role that stays light inside the library.
    const darkStart = tokens.indexOf(":root[data-theme='dark']");
    const darkBlock = tokens.slice(darkStart, tokens.indexOf('\n}', darkStart));
    const roles = [...bridge.values()]
      .flatMap(value => [...value.matchAll(/var\((--color-[a-z0-9-]+)\)/gu)].map(m => m[1]))
      .filter(name =>
        /-(?:solid|text|on-solid|bg|surface|border|soft|softer|hover|ring)/u.test(name)
      );
    const unthemed = [...new Set(roles)].filter(name => !darkBlock.includes(`${name}:`));
    expect(unthemed, 'these roles keep their light value in the dark theme').toEqual([]);
  });
});

describe('the stylesheet entry', () => {
  it('declares the layer ladder before anything can land in it', () => {
    const ladder = entry.indexOf('@layer theme, base, soty-legacy, components, utilities, soty;');
    expect(ladder, 'the layer order is the whole coexistence story').toBeGreaterThan(-1);
    expect(ladder).toBeLessThan(entry.indexOf("@import 'tailwindcss'"));
  });

  it('puts every pre-024 stylesheet below the library, and the skin above it', () => {
    const legacy = [
      './base.css',
      './components.css',
      '../styles.css',
      './team-accounts.css',
      './team-tasks.css',
      './transcription.css',
      './landing-viewer.css'
    ];
    for (const sheet of legacy) {
      expect(entry, `${sheet} must be layered, or it outranks every component`).toContain(
        `@import '${sheet}' layer(soty-legacy);`
      );
    }
    expect(entry).toContain("@import './skin.css' layer(soty);");
  });

  it('leaves the token layer unlayered, which is what gives it the last word', () => {
    expect(entry).toContain("@import './tokens.css';");
    expect(entry).not.toContain("@import './tokens.css' layer");
  });

  it('binds dark mode to the attribute this product already commits before paint', () => {
    expect(entry).toContain(
      "@custom-variant dark (&:where([data-theme='dark'], [data-theme='dark'] *));"
    );
  });

  it('declares the Tailwind theme inline', () => {
    // Without `inline` a utility resolves its variable where the theme is
    // declared rather than where the class is used, so every colour would
    // resolve to its light value inside a dark subtree.
    expect(entry).toContain('@theme inline {');
    expect(entry).not.toMatch(/@theme\s*\{/u);
  });
});
