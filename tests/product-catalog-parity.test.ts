import { describe, expect, it } from 'vitest';
import * as web from '../apps/web/src/team/product-catalog/limits.js';
import * as edge from '../supabase/functions/_shared/product-catalog.js';

/**
 * Feature 022 keeps the catalog rules in two places — the Edge Function decides, the web warns —
 * because the shared package cannot change in a web-only release. This is what keeps them one
 * rule: every limit equal, and both sides giving the same verdict on the same input.
 */

describe('web and edge agree', () => {
  it('on every limit', () => {
    for (const name of [
      'PRODUCT_COUNT_MIN',
      'PRODUCT_COUNT_MAX',
      'PRODUCT_COUNT_DEFAULT',
      'PRICE_MIN',
      'PRICE_MAX',
      'TITLE_MAX',
      'DESCRIPTION_MAX',
      'IMAGE_LINK_MAX',
      'SOURCE_LINK_MAX'
    ] as const) {
      expect(web[name], name).toBe(edge[name]);
    }
  });

  it.each(['1', '007', ' 12 ', '400', '0', '401', '-1', '2.5', 'abc', '', '1000'])(
    'on the product count %j',
    input => {
      const verdict = web.validateProductCount(input);
      const expected = edge.parseProductCount(input);
      expect(verdict.ok).toBe(expected.ok);
      if (verdict.ok && expected.ok) expect(verdict.value).toBe(expected.value);
    }
  );

  it.each([
    'https://a.test/x?y=1',
    ' http://a.test ',
    'ftp://a.test',
    'https://a b.test',
    'a.test',
    'javascript:alert(1)',
    ''
  ])('on the link %j', input => {
    const verdict = web.validateWebLink(input, web.SOURCE_LINK_MAX);
    const expected = edge.parseWebLink(input, edge.SOURCE_LINK_MAX);
    expect(verdict.ok).toBe(expected.ok);
    if (verdict.ok && expected.ok) expect(verdict.value).toBe(expected.value);
  });

  it('on how a price is written', () => {
    for (const price of [1, 10, 999999]) {
      expect(web.formatPricePreview(price)).toBe(edge.formatPrice(price));
    }
  });
});

describe('the price field', () => {
  it.each([
    ['10', 10],
    [' 42 ', 42],
    ['999999', 999999]
  ])('accepts %j', (input, value) => {
    expect(web.validatePrice(input)).toEqual({ ok: true, value });
  });

  it.each(['10.5', '10,00', 'USD 10', '-3', '0', '1000000', '1e3'])('refuses %j', input => {
    expect(web.validatePrice(input)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('asks for a value when empty', () => {
    expect(web.validatePrice('  ')).toEqual({ ok: false, reason: 'required' });
  });
});
