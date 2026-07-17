import { describe, expect, it } from 'vitest';
import { SUPPORTED_API_VERSION, versionState } from '../apps/web/src/connection';

describe('agent compatibility', () => {
  it('accepts the current API version', () => expect(versionState(SUPPORTED_API_VERSION)).toBe('connected'));
  it('offers an update for old or unknown agents', () => {
    expect(versionState(0)).toBe('incompatible_version');
    expect(versionState(SUPPORTED_API_VERSION - 1)).toBe('incompatible_version');
  });
});
