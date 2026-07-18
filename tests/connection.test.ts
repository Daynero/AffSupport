import { describe, expect, it } from 'vitest';
import {
  agentFetchOptions,
  MAX_SUPPORTED_API_VERSION,
  MIN_SUPPORTED_API_VERSION,
  pairingPath,
  versionState
} from '../apps/web/src/connection';

describe('agent compatibility', () => {
  it('accepts every API version in the declared compatibility range', () => {
    expect(versionState(MIN_SUPPORTED_API_VERSION)).toBe('connected');
    expect(versionState(MAX_SUPPORTED_API_VERSION)).toBe('connected');
  });
  it('distinguishes an old agent from a web client that is too old', () => {
    expect(versionState(0)).toBe('agent_update_required');
    expect(versionState(Number.NaN)).toBe('agent_update_required');
    expect(versionState(MIN_SUPPORTED_API_VERSION - 1)).toBe('agent_update_required');
    expect(versionState(MAX_SUPPORTED_API_VERSION + 1)).toBe('web_update_required');
  });
  it('pairs hosted pages through the production redirect and local pages locally', () => {
    expect(pairingPath('http://127.0.0.1:43120', 'https://local-video-compressor-test.pages.dev')).toBe('/pair');
    expect(pairingPath('http://127.0.0.1:43120', 'http://127.0.0.1:43120')).toBe('/local');
  });
  it('lets browsers classify the loopback Agent instead of mislabeling it as local', () => {
    expect(agentFetchOptions('http://127.0.0.1:43120', 'https://local-video-compressor-test.pages.dev')).toEqual({});
    expect(agentFetchOptions('http://localhost:43120', 'https://local-video-compressor-test.pages.dev')).toEqual({});
    expect(agentFetchOptions('http://[::1]:43120', 'https://local-video-compressor-test.pages.dev')).toEqual({});
  });
});
