import { describe, expect, it } from 'vitest';
import {
  clampPowerLimit,
  parsePersistedPowerState,
  parsePowerLimitRequest,
  powerModeFor,
  powerThrottleSupported,
  DEFAULT_POWER_LIMIT,
  POWER_LIMIT_MAX,
  POWER_LIMIT_MIN
} from '../packages/shared/src/types.js';

describe('clampPowerLimit', () => {
  it('passes an in-range integer through unchanged', () => {
    expect(clampPowerLimit(55)).toBe(55);
    expect(clampPowerLimit(POWER_LIMIT_MIN)).toBe(POWER_LIMIT_MIN);
    expect(clampPowerLimit(POWER_LIMIT_MAX)).toBe(POWER_LIMIT_MAX);
  });

  it('rounds to an integer', () => {
    expect(clampPowerLimit(55.4)).toBe(55);
    expect(clampPowerLimit(55.6)).toBe(56);
  });

  it('clamps below the minimum', () => {
    for (const value of [0, -10, 19]) expect(clampPowerLimit(value)).toBe(POWER_LIMIT_MIN);
  });

  it('clamps above the maximum', () => {
    for (const value of [101, 1000]) expect(clampPowerLimit(value)).toBe(POWER_LIMIT_MAX);
  });

  it('falls back to the default for non-finite input', () => {
    for (const value of [NaN, Infinity, -Infinity, 'nope', null, undefined, {}])
      expect(clampPowerLimit(value)).toBe(DEFAULT_POWER_LIMIT);
  });

  it('defaults to unrestricted', () => {
    expect(DEFAULT_POWER_LIMIT).toBe(POWER_LIMIT_MAX);
  });
});

describe('powerModeFor', () => {
  it('reports unrestricted only at the maximum', () => {
    expect(powerModeFor(POWER_LIMIT_MAX)).toBe('unrestricted');
    expect(powerModeFor(99)).toBe('limited');
    expect(powerModeFor(POWER_LIMIT_MIN)).toBe('limited');
  });
});

describe('parsePowerLimitRequest', () => {
  it('accepts a finite number', () => {
    expect(parsePowerLimitRequest({ limitPercent: 40 })).toEqual({
      ok: true,
      value: { limitPercent: 40 }
    });
  });

  it('accepts an out-of-range number so the caller can clamp it', () => {
    // A client sending 150 means "maximum"; rejecting that would be pedantic.
    expect(parsePowerLimitRequest({ limitPercent: 150 })).toEqual({
      ok: true,
      value: { limitPercent: 150 }
    });
    expect(parsePowerLimitRequest({ limitPercent: 5 })).toEqual({
      ok: true,
      value: { limitPercent: 5 }
    });
  });

  it('rejects anything that is not a finite number', () => {
    for (const body of [
      {},
      { limitPercent: '40' },
      { limitPercent: NaN },
      { limitPercent: Infinity },
      { limitPercent: null },
      null,
      'nope',
      [40]
    ]) {
      expect(parsePowerLimitRequest(body)).toEqual({ ok: false, error: 'POWER_LIMIT_INVALID' });
    }
  });
});

describe('parsePersistedPowerState', () => {
  it('round-trips a valid stored state', () => {
    const stored = { limitPercent: 40, updatedAt: '2026-08-20T09:00:00.000Z' };
    expect(parsePersistedPowerState(stored)).toEqual({ ok: true, value: stored });
  });

  it('supplies an epoch timestamp when the stored one is unusable', () => {
    const parsed = parsePersistedPowerState({ limitPercent: 40 });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.updatedAt).toBe(new Date(0).toISOString());
  });

  it('rejects a malformed file', () => {
    for (const stored of [null, 'nope', [], {}, { limitPercent: '40' }, { limitPercent: NaN }])
      expect(parsePersistedPowerState(stored)).toEqual({ ok: false, error: 'POWER_STATE_INVALID' });
  });

  it('rejects an out-of-range stored limit rather than clamping it', () => {
    // A stored value outside the bounds means the file was tampered with or
    // written by a different version; the caller falls back to unrestricted.
    for (const limitPercent of [0, 19, 101])
      expect(parsePersistedPowerState({ limitPercent })).toEqual({
        ok: false,
        error: 'POWER_STATE_OUT_OF_RANGE'
      });
  });
});

describe('powerThrottleSupported', () => {
  it('is true once the agent advertises the power contract', () => {
    expect(powerThrottleSupported({ power: 1 })).toBe(true);
    expect(powerThrottleSupported({ power: 2 })).toBe(true);
  });

  it('is false for an agent that predates the feature', () => {
    expect(powerThrottleSupported({})).toBe(false);
    expect(powerThrottleSupported({ compressor: 3, transcription: 5 })).toBe(false);
  });
});
