import { expect, it } from 'vitest';
import { assembleFinalManifest } from '../scripts/lib/release/adapters/manifest.mjs';

it('accepts only real published digests into final manifest assembly', () => {
  expect(() =>
    assembleFinalManifest({
      base: { artifacts: {} },
      artifacts: { x: { url: 'https://example.test/x', sha256: 'future' } }
    })
  ).toThrow('PUBLISHED_ARTIFACT_INVALID');
});
