import { describe, expect, it } from 'vitest';
import { generateApparelTexts } from '../apps/web/src/team/product-catalog/apparelTexts';

/** The clothing name generator (024): distinct, 4–6 word names, 10–100 word descriptions, English. */

describe('generated clothing names and descriptions', () => {
  it('makes the number asked for, all names different', () => {
    const texts = generateApparelTexts(200);
    expect(texts).toHaveLength(200);
    expect(new Set(texts.map(text => text.title.toLowerCase())).size).toBe(200);
  });

  it('keeps names to four to six words and descriptions to ten to a hundred', () => {
    for (const text of generateApparelTexts(300)) {
      const titleWords = text.title.split(/\s+/u).length;
      const descriptionWords = text.description.split(/\s+/u).length;
      expect(titleWords).toBeGreaterThanOrEqual(4);
      expect(titleWords).toBeLessThanOrEqual(6);
      expect(descriptionWords).toBeGreaterThanOrEqual(10);
      expect(descriptionWords).toBeLessThanOrEqual(100);
      expect(text.title + text.description).toMatch(/^[\x20-\x7E]+$/u);
    }
  });

  it('never makes more than a thousand', () => {
    expect(generateApparelTexts(5000)).toHaveLength(1000);
  });
});
