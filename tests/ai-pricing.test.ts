import { describe, expect, it } from 'vitest';
import {
  AI_CREDIT_USD,
  assistantMessagePrice,
  ASSISTANT_MESSAGE_MAX_CHARACTERS,
  parseAiCreditsStatus,
  translationPrice
} from '@video-compressor/shared';

describe('064 credit prices', () => {
  it('prices a translation per started minute of text, rounded up, at least one', () => {
    expect(translationPrice(1, 'en')).toBe(1);
    expect(translationPrice(900, 'en')).toBe(1);
    expect(translationPrice(901, 'en')).toBe(2);
    // quickstart: a 2 300-character transcript shows «Перекласти · 3»
    expect(translationPrice(2_300, 'uk')).toBe(3);
    expect(translationPrice(0, 'en')).toBe(1);
  });

  it('prices an assistant message by its length and refuses an empty or too long one', () => {
    expect(assistantMessagePrice('')).toBeNull();
    expect(assistantMessagePrice('   ')).toBeNull();
    expect(assistantMessagePrice('5 запусків ProCaps на G2')).toBe(1);
    expect(assistantMessagePrice('я'.repeat(1_500))).toBe(1);
    expect(assistantMessagePrice('я'.repeat(1_501))).toBe(2);
    expect(assistantMessagePrice('я'.repeat(ASSISTANT_MESSAGE_MAX_CHARACTERS))).toBe(2);
    expect(assistantMessagePrice('я'.repeat(ASSISTANT_MESSAGE_MAX_CHARACTERS + 1))).toBeNull();
  });

  it('counts code points, not UTF-16 units, so an emoji is one character', () => {
    expect(assistantMessagePrice('🙂'.repeat(1_500))).toBe(1);
  });

  it('keeps the worst assistant call within the two credits it can be charged', () => {
    // Haiku 5.5: 8 000 input tokens at $0.10/MTok + 2 048 output tokens at $0.50/MTok.
    const worst = 8_000 * 0.1e-6 + 2_048 * 0.5e-6;
    expect(worst).toBeLessThanOrEqual(2 * AI_CREDIT_USD);
  });

  it('reads the status the server returns and rejects anything else', () => {
    const status = {
      grant: 100,
      available: 87,
      day: '2026-11-21',
      resetsAt: '2026-11-21T22:00:00Z',
      paidOpen: true,
      recent: [{ feature: 'launch_assistant', kind: 'debit', amount: 1, at: '2026-11-21T10:00:00Z' }]
    };
    expect(parseAiCreditsStatus(status)).toEqual(status);
    expect(parseAiCreditsStatus({ ...status, available: -1 })).toBeNull();
    expect(
      parseAiCreditsStatus({ ...status, recent: [{ ...status.recent[0], feature: 'wallet' }] })
    ).toBeNull();
  });
});
