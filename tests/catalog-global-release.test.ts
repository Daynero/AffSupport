import { it, expect } from 'vitest';
import {
  evaluateCatalogGlobalCutoverEvidence,
  inspectCatalogGlobalRelease
} from '../scripts/lib/release/catalog-global-cutover.mjs';
it('blocks T0 on missing installed, rollback, provider, deletion or diagnostic proof', () => {
  const expected = {
    sourceSha: 'a'.repeat(40),
    environment: 'beta',
    routingRevision: 'r1',
    manifestDigest: 'b'.repeat(64)
  };
  const absent = evaluateCatalogGlobalCutoverEvidence(
    {
      schema: 1,
      source_sha: expected.sourceSha,
      environment: 'beta',
      routing_revision: 'r1',
      manifest_digest: expected.manifestDigest,
      observed_at: new Date().toISOString()
    },
    expected
  );
  expect(absent.ok).toBe(false);
  expect(absent.failures).toContain('GLOBAL_IMAGE_ROLLBACK_BUILD_INCOMPATIBLE');
  expect(absent.failures).toContain('GLOBAL_IMAGE_DRAINED_LEGACY_DELETIONS_UNVERIFIED');
  expect(inspectCatalogGlobalRelease({}, expected.sourceSha)).toMatchObject({
    ok: true,
    state: 'inactive_no_activation_requested'
  });
  expect(
    inspectCatalogGlobalRelease(
      {
        kind: 'sandbox',
        catalogGlobalCutover: {
          environment: 'beta',
          routingRevision: 'r1',
          manifestDigest: expected.manifestDigest,
          evidence: { schema: 1 }
        }
      },
      expected.sourceSha
    )
  ).toMatchObject({ ok: false, state: 'blocked', automaticActivation: false });
});
