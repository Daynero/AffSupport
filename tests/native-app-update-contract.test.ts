import { describe, expect, it } from 'vitest';
import {
  isNativeUpdateCommand,
  isNativeUpdateDescriptor,
  isNativeUpdateSnapshot,
  nativeUpdateMatchesManifest
} from '../packages/shared/src/native-app-updates';
import { nativeCandidate, nativeSnapshot } from './support/native-app-updates';
describe('native update trust boundaries', () => {
  it('accepts the complete correlated contract', () => {
    expect(isNativeUpdateDescriptor(nativeCandidate())).toBe(true);
    expect(isNativeUpdateSnapshot(nativeSnapshot())).toBe(true);
    expect(
      nativeUpdateMatchesManifest(nativeCandidate(), {
        channel: 'stable',
        version: '9.0.0',
        buildNumber: '999',
        buildId: '9.0.0+999'
      })
    ).toBe(true);
  });
  it.each([
    { schemaVersion: 2 },
    { target: 'windows-x64' },
    { buildId: '9.0.0+998' },
    { sourceRevision: 'main' },
    { publisherTeamId: 'unknown' },
    { minimumSystemVersion: 'latest' },
    { archive: { ...nativeCandidate().archive, url: 'https://github.com.evil.test/archive.zip' } },
    { archive: { ...nativeCandidate().archive, length: 2 ** 40 } },
    { archive: { ...nativeCandidate().archive, edSignature: 'invalid' } }
  ])('refuses malformed or mismatched archive identity %j', patch =>
    expect(isNativeUpdateDescriptor({ ...nativeCandidate(), ...patch })).toBe(false)
  );
  it('refuses forged success, unknown outcomes and unbounded bytes', () => {
    expect(isNativeUpdateSnapshot({ ...nativeSnapshot(), uiSuccess: true })).toBe(false);
    expect(isNativeUpdateSnapshot({ ...nativeSnapshot(), stage: 'done' })).toBe(false);
    expect(isNativeUpdateSnapshot({ ...nativeSnapshot(), downloadedBytes: 6 })).toBe(false);
    expect(
      isNativeUpdateSnapshot({ ...nativeSnapshot(), candidateId: `macos-x64:${'a'.repeat(64)}` })
    ).toBe(false);
  });
  it('refuses executable/browser authority and requires explicit revision and key', () => {
    const body = {
      schemaVersion: 1,
      idempotencyKey: '10000000-0000-4000-8000-000000000001',
      expectedRevision: 1,
      candidateId: null
    };
    expect(isNativeUpdateCommand(body)).toBe(true);
    expect(isNativeUpdateCommand({ ...body, url: 'https://evil.test' })).toBe(false);
    expect(isNativeUpdateCommand({ ...body, expectedRevision: -1 })).toBe(false);
    expect(isNativeUpdateCommand({ ...body, idempotencyKey: 'same' })).toBe(false);
  });
});
