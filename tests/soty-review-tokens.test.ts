import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  renderTokenCss,
  resolveTokenDocument
} from '../apps/soty-review/scripts/generate-tokens.mjs';

const source = JSON.parse(readFileSync('specs/003-rebrand-soty-ui/design-tokens.json', 'utf8'));

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/../g)!
    .map(channel => Number.parseInt(channel, 16) / 255)
    .map(channel => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('Soty token generation', () => {
  it('resolves aliases and emits only scoped color variables', () => {
    const resolved = resolveTokenDocument(source);
    expect(resolved.get('semantic.light.action.default')).toBe('#F5A318');
    const css = renderTokenCss(source, 'test');
    expect(css).toContain('.soty-review');
    expect(css).not.toContain('{primitives.');
    expect(css).not.toContain('Ready = purple');
  });

  it('rejects cyclic and missing aliases', () => {
    expect(() => resolveTokenDocument({ a: { $value: '{b}' }, b: { $value: '{a}' } })).toThrow(
      /Cyclic/
    );
    expect(() => resolveTokenDocument({ a: { $value: '{missing}' } })).toThrow(/Unknown/);
  });

  it('keeps generated output current and component source free of primitive hex colors', () => {
    expect(readFileSync('apps/soty-review/src/generated/soty-tokens.css', 'utf8')).toMatch(
      /sha256:[a-f0-9]{64}/
    );
    const componentSource = readFileSync('apps/soty-review/src/components/Action.tsx', 'utf8');
    expect(componentSource).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it('meets the computed contrast policy for text, actions, hover, focus and statuses', () => {
    const resolved = resolveTokenDocument(source);
    const value = (theme: 'light' | 'dark', role: string) =>
      resolved.get(`semantic.${theme}.${role}`) as string;

    for (const theme of ['light', 'dark'] as const) {
      expect(
        contrast(value(theme, 'text.primary'), value(theme, 'background.page'))
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(value(theme, 'text.secondary'), value(theme, 'background.surface'))
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(value(theme, 'text.onAction'), value(theme, 'action.default'))
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(value(theme, 'text.onAction'), value(theme, 'action.hover'))
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(value(theme, 'brand.focus'), value(theme, 'background.page'))
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrast(value(theme, 'text.primary'), value(theme, 'brand.subtle'))
      ).toBeGreaterThanOrEqual(4.5);

      // Disabled controls are exempt from WCAG contrast and retain native disabled
      // semantics. Subtle borders are not the sole focus cue because the ring above is 3:1.
      expect(
        contrast(value(theme, 'disabled.foreground'), value(theme, 'disabled.background'))
      ).toBeGreaterThan(1);
      expect(
        contrast(value(theme, 'border.strong'), value(theme, 'background.surface'))
      ).toBeLessThan(3);
    }
  });
});
