import { expect, it } from 'vitest';
import { DeliveryLedger } from '../scripts/acceptance/delivery.mjs';
import { realtimeCalibrationProfile } from '../scripts/acceptance/realtime-calibrate.mjs';

it('keeps independent named calibration rates bounded and rejects arbitrary workload input', () => {
  expect(realtimeCalibrationProfile('steady')).toMatchObject({
    count: 110,
    warmup: 10,
    intervalMs: 1000
  });
  expect(realtimeCalibrationProfile('burst')).toMatchObject({
    count: 110,
    warmup: 10,
    intervalMs: 200
  });
  expect(() => realtimeCalibrationProfile('--duration=86400')).toThrow(
    'ACCEPTANCE_LOAD_CONFIG_INVALID'
  );
});

const id = '11111111-1111-4111-8111-111111111111';
it('retains an authoritative delivery that precedes the HTTP acknowledgement', () => {
  const ledger = new DeliveryLedger(['B', 'C'], [{ index: 0, name: 'own-action' }]);
  ledger.observe('B', [{ id, name: 'own-action' }], 12);
  ledger.observe('C', [{ id, name: 'own-action' }], 15);
  expect(ledger.delivered(0)).toBe(false);
  ledger.accept(0, id);
  expect(ledger.delivered(0)).toBe(true);
  expect(
    ledger.samples([{ index: 0, scheduledMs: 0, warmup: false, outcome: 'success' }], 100)
  ).toEqual([
    { receiver: 'B', index: 0, scheduledMs: 0, completedMs: 12, warmup: false, outcome: 'success' },
    { receiver: 'C', index: 0, scheduledMs: 0, completedMs: 15, warmup: false, outcome: 'success' }
  ]);
});

it('does not credit a matching name from a different result or invent missing delivery', () => {
  const ledger = new DeliveryLedger(['B', 'C'], [{ index: 0, name: 'own-action' }]);
  ledger.accept(0, id);
  ledger.observe('B', [{ id: '22222222-2222-4222-8222-222222222222', name: 'own-action' }], 10);
  ledger.observe('C', [{ id, name: 'own-action' }], 150);
  expect(ledger.delivered(0)).toBe(false);
  const samples = ledger.samples(
    [{ index: 0, scheduledMs: 0, warmup: false, outcome: 'timeout' }],
    100
  );
  expect(samples.map(sample => sample.outcome)).toEqual(['timeout', 'timeout']);
  expect(samples.map(sample => sample.completedMs)).toEqual([100, 150]);
});

it('keeps dropped work and warmup in each receiver denominator, excluding unoffered work', () => {
  const ledger = new DeliveryLedger(
    ['B', 'C'],
    [
      { index: 0, name: 'warmup' },
      { index: 1, name: 'dropped' },
      { index: 2, name: 'future' }
    ]
  );
  ledger.accept(0, id);
  ledger.observe('B', [{ id, name: 'warmup' }], 5);
  const samples = ledger.samples(
    [
      { index: 0, scheduledMs: 0, warmup: true, outcome: 'timeout' },
      { index: 1, scheduledMs: 10, warmup: false, outcome: 'dropped' }
    ],
    100
  );
  expect(samples).toHaveLength(4);
  expect(samples.filter(sample => sample.index === 0).map(sample => sample.outcome)).toEqual([
    'success',
    'timeout'
  ]);
  expect(samples.filter(sample => sample.index === 1).map(sample => sample.outcome)).toEqual([
    'dropped',
    'dropped'
  ]);
  expect(samples.some(sample => sample.index === 2)).toBe(false);
});

it('refuses unknown receivers and duplicate correlation names', () => {
  expect(
    () =>
      new DeliveryLedger(
        ['B'],
        [
          { index: 0, name: 'same' },
          { index: 1, name: 'same' }
        ]
      )
  ).toThrow('ACCEPTANCE_DELIVERY_INVALID');
  const ledger = new DeliveryLedger(['B'], [{ index: 0, name: 'own-action' }]);
  expect(() => ledger.observe('X', [], 0)).toThrow('ACCEPTANCE_DELIVERY_INVALID');
});
