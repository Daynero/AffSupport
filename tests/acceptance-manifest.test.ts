import { describe, expect, it } from 'vitest';
import { validateManifest } from '../scripts/acceptance/schema.mjs';
const manifest = {
  schemaVersion: 1,
  campaignId: 'acceptance-test-001',
  candidateSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  baseTag: 'v1.2.6',
  createdAt: '2026-10-20T20:00:00.000Z',
  dirty: true,
  mode: 'development',
  targetFingerprint: 'c'.repeat(64),
  fixtureVersion: 'v1',
  includedCases: ['SET-001'],
  exclusions: []
};
describe('immutable campaign manifest boundary', () => {
  it('accepts explicit development scope', () => expect(validateManifest(manifest).ok).toBe(true));
  it.each([
    { candidateSha: '' },
    { dirty: 'false' },
    { dirty: true, mode: 'final' },
    { targetFingerprint: 'unknown' },
    { includedCases: ['SET-001', 'SET-001'] },
    { includedCases: ['BOGUS-001'] },
    { exclusions: ['ACL-001'] },
    { createdAt: 'yesterday' },
    { serviceRole: 'secret' },
    { campaignId: '../test' }
  ])('rejects malformed or misleading scope %o', patch => {
    expect(validateManifest({ ...manifest, ...patch }).ok).toBe(false);
  });
});
