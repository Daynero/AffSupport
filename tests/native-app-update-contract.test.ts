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

  it('accepts beta only from the exact loopback archive and preserves target identity', () => {
    const candidate = nativeCandidate();
    const beta = {
      ...candidate,
      channel: 'beta',
      target: 'macos-x64',
      archive: {
        ...candidate.archive,
        url: 'http://127.0.0.1:43140/v9.0.0/Soty-v9.0.0-macOS-x64.zip'
      }
    };
    expect(isNativeUpdateDescriptor(beta)).toBe(true);
    for (const url of [
      'not a URL',
      beta.archive.url.replace('127.0.0.1', 'localhost'),
      beta.archive.url.replace('127.0.0.1', '127.0.0.1.evil.test'),
      beta.archive.url.replace('127.0.0.1', 'user:password@127.0.0.1'),
      `${beta.archive.url}?redirect=1`,
      `${beta.archive.url}#fragment`,
      beta.archive.url.replace('macOS-x64', 'macOS-arm64')
    ])
      expect(isNativeUpdateDescriptor({ ...beta, archive: { ...beta.archive, url } })).toBe(false);
    expect(isNativeUpdateDescriptor({ ...beta, channel: 'stable' })).toBe(false);
  });

  it('rejects incomplete identities and malformed download metadata before preparation', () => {
    for (const value of [null, [], {}, { ...nativeCandidate(), archive: null }])
      expect(isNativeUpdateDescriptor(value)).toBe(false);
    for (const patch of [
      { version: 'latest' },
      { version: '1'.repeat(65) },
      { buildNumber: '-1' },
      { channel: 'preview' },
      { archive: { ...nativeCandidate().archive, length: 0 } },
      { archive: { ...nativeCandidate().archive, length: 1.5 } },
      { archive: { ...nativeCandidate().archive, sha256: 'unknown' } }
    ])
      expect(isNativeUpdateDescriptor({ ...nativeCandidate(), ...patch })).toBe(false);
    expect(
      nativeUpdateMatchesManifest(nativeCandidate(), {
        version: '9.0.0',
        buildNumber: '999',
        buildId: '9.0.0+999'
      })
    ).toBe(true);
    expect(
      nativeUpdateMatchesManifest(nativeCandidate(), {
        channel: 'beta',
        version: '9.0.0',
        buildNumber: '999',
        buildId: '9.0.0+999'
      })
    ).toBe(false);
  });

  it('rejects uncorrelated and impossible snapshots while accepting explicit failure evidence', () => {
    for (const value of [null, [], { ...nativeSnapshot(), installationId: 'missing' }])
      expect(isNativeUpdateSnapshot(value)).toBe(false);
    for (const patch of [
      { revision: -1 },
      { revision: 1.5 },
      { operationId: 'missing' },
      { attemptId: 'missing' },
      { candidate: {} },
      { lastProvenStage: 'done' },
      { code: 'UNKNOWN_FAILURE' },
      { downloadedBytes: -1 },
      { downloadedBytes: 2 ** 40 },
      { totalBytes: 2 ** 40 },
      { totalBytes: 4.5 },
      { nativeSuccess: 'yes' },
      { automaticDownload: 'yes' },
      { availableActions: ['execute'] },
      { availableActions: null }
    ])
      expect(isNativeUpdateSnapshot({ ...nativeSnapshot(), ...patch })).toBe(false);
    expect(
      isNativeUpdateSnapshot({ ...nativeSnapshot(), code: 'APP_UPDATE_DISK_FULL', stage: 'failed' })
    ).toBe(true);
    expect(
      isNativeUpdateSnapshot({
        ...nativeSnapshot(),
        candidate: null,
        candidateId: null,
        operationId: null,
        attemptId: null,
        totalBytes: null,
        downloadedBytes: 0,
        stage: 'idle',
        availableActions: ['check']
      })
    ).toBe(true);
  });

  it('requires bounded command authority and accepts explicit automatic-download preference', () => {
    const command = {
      schemaVersion: 1,
      idempotencyKey: '10000000-0000-4000-8000-000000000001',
      expectedRevision: 0,
      candidateId: `macos-arm64:${'a'.repeat(64)}`,
      automaticDownload: false
    };
    expect(isNativeUpdateCommand(command)).toBe(true);
    for (const value of [
      null,
      [],
      { ...command, automaticDownload: 'yes' },
      { ...command, candidateId: 'latest' },
      { ...command, expectedRevision: 0.5 }
    ])
      expect(isNativeUpdateCommand(value)).toBe(false);
  });
});
