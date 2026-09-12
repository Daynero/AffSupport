import { expect, it } from 'vitest';
import { releaseDispatch, verifyWindowsAsset } from '../scripts/lib/release/adapters/github.mjs';

it('dispatches only an exact Windows workflow identity and verifies its asset', () => {
  expect(
    releaseDispatch({
      workflow: 'release-windows.yml',
      sourceSha: 'a'.repeat(40),
      releaseId: 'v1',
      mode: 'build-only'
    }).inputs.publish
  ).toBe(false);
  expect(
    verifyWindowsAsset({ name: 'a.exe', sha256: 'b'.repeat(64) }, 'a.exe', 'b'.repeat(64))
  ).toEqual({ ok: true });
});
