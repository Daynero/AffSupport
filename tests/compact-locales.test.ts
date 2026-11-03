import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  compactLocaleSources,
  compactLocalesPlugin,
  COMPACT_LOCALE_KEYS_ID
} from '../scripts/lib/compact-locales.mjs';
import { en } from '../apps/web/src/locales/en';
import { uk } from '../apps/web/src/locales/uk';

function reconstruct(compact: ReturnType<typeof compactLocaleSources>, language: 'en' | 'uk') {
  const keys = new Function(compact.keys.replace('export const', 'const') + 'return keys;')();
  const code = compact[language]
    .replace(/^import\{keys\}from[^;]+;/u, '')
    .replace('export const', 'const');
  return new Function('keys', code + `return ${language};`)(keys) as Record<string, string>;
}

it('preserves every authored key, value, order, prototype and descriptor for both languages', () => {
  const compact = compactLocaleSources(
    readFileSync('apps/web/src/locales/en.ts', 'utf8'),
    readFileSync('apps/web/src/locales/uk.ts', 'utf8')
  );
  for (const [name, original] of [
    ['en', en],
    ['uk', uk]
  ] as const) {
    const rebuilt = reconstruct(compact, name);
    expect(Reflect.ownKeys(rebuilt)).toEqual(Reflect.ownKeys(original));
    expect(rebuilt).toEqual(original);
    expect(Object.getPrototypeOf(rebuilt)).toBe(Object.getPrototypeOf(original));
    expect(Object.getOwnPropertyDescriptors(rebuilt)).toEqual(
      Object.getOwnPropertyDescriptors(original)
    );
    expect(Object.isExtensible(rebuilt)).toBe(Object.isExtensible(original));
  }
  expect(Object.keys(en).length).toBeGreaterThan(4000);
  const base = `const en=${JSON.stringify(en)},uk=${JSON.stringify(uk)};`;
  const packed = compact.keys + compact.en + compact.uk;
  // All content remains represented. Savings come from one copy of the keys,
  // never from excluding a locale, dropping text or changing a budget baseline.
  expect(gzipSync(base).length - gzipSync(packed).length).toBeGreaterThan(15_000);
  expect(
    compactLocaleSources(
      readFileSync('apps/web/src/locales/en.ts', 'utf8'),
      readFileSync('apps/web/src/locales/uk.ts', 'utf8')
    )
  ).toEqual(compact);
  expect(compactLocalesPlugin().apply).toBe('build');
});

it('evaluates only static string concatenation and preserves escaped and Unicode text', () => {
  const compact = compactLocaleSources(
    'export const en = { first: "a" + ("\\n" + "😀"), second: `literal` } as const;',
    'import type {en} from "./en"; export const uk: Record<keyof typeof en,string> = { first: "б" + "\\u2028", second: "" };'
  );
  expect(reconstruct(compact, 'en')).toEqual({ first: 'a\n😀', second: 'literal' });
  expect(reconstruct(compact, 'uk')).toEqual({ first: 'б\u2028', second: '' });
});

it('creates own data properties without invoking inherited setters', () => {
  const key = '__localeInheritedSetterFixture';
  const setter = vi.fn();
  Object.defineProperty(Object.prototype, key, { set: setter, configurable: true });
  try {
    const compact = compactLocaleSources(
      `export const en = {${key}:"english"};`,
      `export const uk = {${key}:"українська"};`
    );
    const rebuilt = reconstruct(compact, 'en');
    expect(setter).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(rebuilt, key)).toEqual({
      value: 'english',
      enumerable: true,
      configurable: true,
      writable: true
    });
  } finally {
    Reflect.deleteProperty(Object.prototype, key);
  }
});

it.each([
  'export const en = {a: sideEffect()};',
  'export const en = {a: `${sideEffect()}`};',
  'export const en = {...other,a:"x"};',
  'export const en = {get a(){return "x"}};',
  'export const en = {["a"]:"x"};',
  'export const en = {a:"x",a:"y"};',
  'export const en = {"__proto__":"x"};',
  'export const en = {constructor:"x"};',
  'export const en = {prototype:"x"};',
  'export const en = {"1":"x"};',
  'export const en = {a:1 + "x"};',
  'export const en = {a:"x"};sideEffect();',
  'import "side-effect";export const en = {a:"x"};',
  'export let en = {a:"x"};',
  'export const en = {a:"x";',
  'export const en = {};'
])('refuses unsupported dictionary shape without executing it: %s', source => {
  expect(() => compactLocaleSources(source, 'export const uk = {a:"б"};')).toThrow(
    /static string dictionaries/
  );
});

it('refuses mismatched keys or declaration order instead of assigning a translation to the wrong key', () => {
  const en = 'export const en = {a:"x",b:"y"};';
  expect(() => compactLocaleSources(en, 'export const uk = {a:"б"};')).toThrow();
  expect(() => compactLocaleSources(en, 'export const uk = {b:"б",a:"а"};')).toThrow();
});

it('limits build transformation to watched exact inputs and refuses a changed snapshot', () => {
  const plugin = compactLocalesPlugin();
  const context = { addWatchFile: vi.fn() };
  const invoke = (name: string, ...args: unknown[]) => {
    const hook = Reflect.get(plugin, name);
    expect(typeof hook).toBe('function');
    return hook.call(context, ...args);
  };
  const root = path.resolve('apps/web');
  const file = path.join(root, 'src/locales/en.ts');
  const source = readFileSync(file, 'utf8');
  invoke('configResolved', { root });
  invoke('buildStart');
  expect(context.addWatchFile.mock.calls.map(([file]) => file)).toEqual([
    path.join(root, 'src/locales/en.ts'),
    path.join(root, 'src/locales/uk.ts')
  ]);
  expect(invoke('resolveId', 'soty:compact-locale-keys')).toBe(COMPACT_LOCALE_KEYS_ID);
  expect(invoke('resolveId', 'another-module')).toBeNull();
  expect(invoke('load', COMPACT_LOCALE_KEYS_ID)).toMatch(/^export const keys=/u);
  expect(invoke('load', 'another-module')).toBeNull();
  const transformed = invoke('transform', source, file.replaceAll('\\', '/'));
  expect(transformed.code).toContain('export const en={};');
  expect(invoke('transform', source, file + '?unrelated')).toBeNull();
  expect(invoke('transform', source, path.join(root, 'another.ts'))).toBeNull();
  expect(() => invoke('transform', source + '\n', file.replaceAll('\\', '/'))).toThrow(
    /static string dictionaries/
  );
  invoke('buildStart');
  expect(invoke('transform', source, file.replaceAll('\\', '/'))).toEqual(transformed);
});
