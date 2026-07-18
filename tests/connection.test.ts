import { describe, expect, it } from 'vitest';
import { pairingPath, SUPPORTED_API_VERSION, versionState } from '../apps/web/src/connection';

describe('agent compatibility', () => {
  it('accepts the current API version', () => expect(versionState(SUPPORTED_API_VERSION)).toBe('connected'));
  it('offers an update for old or unknown agents', () => {
    expect(versionState(0)).toBe('incompatible_version');
    expect(versionState(SUPPORTED_API_VERSION - 1)).toBe('incompatible_version');
  });
  it('pairs hosted pages through the production redirect and local pages locally', () => {
    expect(pairingPath('http://127.0.0.1:43120', 'https://local-video-compressor-test.pages.dev')).toBe('/pair');
    expect(pairingPath('http://127.0.0.1:43120', 'http://127.0.0.1:43120')).toBe('/local');
  });
});
