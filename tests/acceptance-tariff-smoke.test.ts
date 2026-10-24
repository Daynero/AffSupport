import { describe, expect, it } from 'vitest';
import { findPauseReceipt } from '../scripts/acceptance/tariff-smoke.mjs';
describe('tariff pause mutation receipt reconciliation', () => {
  const event = {
    id: 'new',
    tariffId: 'tariff',
    actorId: 'admin',
    kind: 'ended_now',
    undoable: true
  };
  const receipt = (rows: unknown[]) =>
    findPauseReceipt({ ok: true, data: rows }, new Set(['old']), 'tariff', 'admin');
  it('uses the unique newly committed admin event without trusting a missing reply eventId', () => {
    expect(receipt([{ ...event, id: 'old' }, event])).toBe('new');
  });
  it('does not undo an unrelated, ambiguous or no longer undoable mutation', () => {
    for (const patch of [
      { actorId: 'other' },
      { tariffId: 'other' },
      { kind: 'extended' },
      { undoable: false }
    ])
      expect(receipt([{ ...event, ...patch }])).toBeNull();
    expect(receipt([event, { ...event, id: 'another' }])).toBeNull();
    expect(findPauseReceipt({ ok: false }, new Set(), 'tariff', 'admin')).toBeNull();
  });
});
