import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The token layer's own tests (021, T012).
 *
 * Three things prose cannot check: that every role has a value in both themes,
 * that the pairs a component actually puts together meet AA, and that no
 * duration exceeds the ceiling `docs/DESIGN-PRINCIPLES.md` sets. A token that
 * exists in one theme only is invisible until someone switches theme on the one
 * screen that uses it — which is how this product got violet text on a violet
 * wash and shipped it.
 */

const TOKENS = readFileSync(
  path.resolve(import.meta.dirname, '../apps/web/src/styles/tokens.css'),
  'utf8'
);

/** Declarations inside one selector block, as a name → value map. */
function block(selector: string): Map<string, string> {
  const start = TOKENS.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no such block: ${selector}`);
  const end = TOKENS.indexOf('\n}', start);
  const body = TOKENS.slice(start, end);
  const found = new Map<string, string>();
  for (const match of body.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gm)) {
    found.set(match[1]!, match[2]!.trim());
  }
  return found;
}

/** Every `:root` declaration, including the alias block at the end. */
function allRootDeclarations(): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, selector, body] of TOKENS.matchAll(/(:root(?:\[[^\]]+\])?)\s*\{([^}]*)\}/g)) {
    if (selector !== ':root') continue;
    for (const match of body.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gm)) {
      found.set(match[1]!, match[2]!.trim());
    }
  }
  return found;
}

const light = allRootDeclarations();
const dark = block(":root[data-theme='dark']");

const ROLES = ['primary', 'secondary', 'success', 'info', 'warning', 'error'] as const;
const ROLE_SHADES = ['solid', 'soft', 'border', 'text', 'on-solid'] as const;

/** sRGB relative luminance, per WCAG 2.1. */
function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map(character => character + character)
          .join('')
      : value;
  const channels = [0, 2, 4].map(offset => parseInt(full.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map(channel =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

/** Resolves a token to a hex literal, following `var()` chains within a theme. */
function resolve(name: string, theme: Map<string, string>): string | null {
  let value = theme.get(name) ?? light.get(name);
  for (let hops = 0; value && hops < 8; hops += 1) {
    if (value.startsWith('#')) return value;
    const reference = /^var\((--[a-z0-9-]+)\)$/.exec(value.trim());
    if (!reference) return null;
    value = theme.get(reference[1]!) ?? light.get(reference[1]!);
  }
  return null;
}

describe('the token layer', () => {
  it('gives every colour role every shade a component asks for', () => {
    for (const role of ROLES) {
      for (const shade of ROLE_SHADES) {
        expect(light.has(`--color-${role}-${shade}`), `light --color-${role}-${shade}`).toBe(true);
      }
    }
    for (const name of [
      'bg',
      'surface',
      'surface-raised',
      'surface-subtle',
      'surface-muted',
      'border',
      'border-strong',
      'text',
      'text-muted'
    ]) {
      expect(light.has(`--color-neutral-${name}`), `light --color-neutral-${name}`).toBe(true);
    }
  });

  it('redefines every role in the dark theme', () => {
    // A role whose dark value is missing renders the light value on a dark
    // surface — the failure mode that is invisible until someone switches.
    for (const role of ROLES) {
      for (const shade of ROLE_SHADES) {
        expect(dark.has(`--color-${role}-${shade}`), `dark --color-${role}-${shade}`).toBe(true);
      }
    }
  });

  it('keeps every duration inside the 300ms ceiling', () => {
    /*
     * The ceiling is about the moments a person waits through — a transition
     * from one state to another. A spinner's loop is not one of those: it is
     * the signal that work is still running, and it turns for as long as the
     * work does. It is named here rather than excluded silently.
     */
    const AMBIENT = new Set(['--motion-spin', '--motion-spin-reduced']);
    for (const [name, value] of light) {
      if (!name.startsWith('--motion-') || AMBIENT.has(name)) continue;
      const ms = /^(\d+(?:\.\d+)?)ms$/.exec(value);
      expect(ms, `${name} should be a plain millisecond value`).not.toBeNull();
      expect(Number(ms![1]), name).toBeLessThanOrEqual(300);
    }
    /*
     * The loop still has to read as one: fast enough to look alive, slow enough
     * not to strobe. Read from the sheet rather than from the flattened map,
     * because `--motion-spin` is declared twice on purpose — once at its own
     * speed, once under reduced motion pointing at the slower of the two.
     */
    for (const name of AMBIENT) {
      const declared = new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)ms`).exec(TOKENS);
      expect(declared, `${name} should be declared as a millisecond value`).not.toBeNull();
      expect(Number(declared![1]), name).toBeGreaterThanOrEqual(400);
    }
  });

  it('collapses reduced motion in one place', () => {
    const reduced = TOKENS.slice(TOKENS.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const name of ['--motion-fast', '--motion-base', '--motion-slow']) {
      expect(reduced).toContain(`${name}: 1ms`);
    }
    expect(reduced).toContain('--press-scale: 1');
  });

  it('meets AA on the pairs components actually put together', () => {
    const pairs: Array<[string, string]> = [
      ['--color-neutral-text', '--color-neutral-bg'],
      ['--color-neutral-text', '--color-neutral-surface'],
      ['--color-neutral-text-muted', '--color-neutral-bg'],
      ['--color-neutral-text-muted', '--color-neutral-surface'],
      ...ROLES.map(
        role => [`--color-${role}-on-solid`, `--color-${role}-solid`] as [string, string]
      )
    ];
    for (const [theme, name] of [
      [light, 'light'],
      [dark, 'dark']
    ] as const) {
      for (const [foreground, background] of pairs) {
        const front = resolve(foreground, theme);
        const back = resolve(background, theme);
        // color-mix() values cannot be resolved statically; those pairs are
        // verified on the demo surface instead (T030).
        if (!front || !back) continue;
        expect(
          contrast(front, back),
          `${name}: ${foreground} on ${background}`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps the legacy aliases pointing at roles rather than at values', () => {
    // The aliases are what unmigrated screens read. If one of them holds a raw
    // value again, that screen has quietly left the system.
    for (const name of [
      '--color-accent',
      '--color-action',
      '--color-surface',
      '--color-text',
      '--dur-control',
      '--ease-standard',
      '--text-lg'
    ]) {
      const value = light.get(name);
      expect(value, `${name} must exist`).toBeDefined();
      expect(value!.startsWith('var('), `${name} must resolve through a token`).toBe(true);
    }
  });
});
