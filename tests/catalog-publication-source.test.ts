import { expect, it } from 'vitest';
import { catalogPublicationSourceIdentity } from '../packages/shared/src/team/catalog-publication-source';
const base = {
  materialId: '77000000-0000-4000-8000-000000000101',
  connectionId: '77000000-0000-4000-8000-000000000102',
  fileId: 'source-file',
  checksum: 'a'.repeat(32),
  mimeType: 'video/mp4',
  sizeBytes: 31331,
  driveVersion: '123'
};
it('survives a metadata-only sharing version bump only with the same proven content tuple', async () => {
  expect(await catalogPublicationSourceIdentity({ ...base, driveVersion: '124' })).toBe(
    await catalogPublicationSourceIdentity(base)
  );
});
it('separates content changes, material/file rebind and connection replacements', async () => {
  const original = await catalogPublicationSourceIdentity(base);
  for (const changed of [
    { ...base, checksum: 'b'.repeat(32) },
    { ...base, fileId: 'different-file' },
    { ...base, connectionId: '77000000-0000-4000-8000-000000000103' },
    { ...base, materialId: '77000000-0000-4000-8000-000000000104' }
  ])
    expect(await catalogPublicationSourceIdentity(changed)).not.toBe(original);
});
it('uses a strict identity-bound fallback without assuming missing checksums prove unchanged content', async () => {
  const unknown = { ...base, checksum: null, sizeBytes: null };
  const strict = await catalogPublicationSourceIdentity(unknown);
  expect(strict).toMatch(/^strict-v1:[a-f0-9]{64}$/);
  expect(await catalogPublicationSourceIdentity({ ...unknown, driveVersion: '124' })).not.toBe(
    strict
  );
  expect(await catalogPublicationSourceIdentity({ ...unknown, fileId: 'rebound-file' })).not.toBe(
    strict
  );
  expect(await catalogPublicationSourceIdentity(base, true)).toBe(strict);
});
it('refuses an unbound or unavailable strict identity', async () => {
  await expect(
    catalogPublicationSourceIdentity({ ...base, connectionId: 'not-uuid' })
  ).rejects.toThrow('SOURCE_CHANGED');
  await expect(
    catalogPublicationSourceIdentity({
      ...base,
      checksum: null,
      sizeBytes: null,
      driveVersion: null
    })
  ).rejects.toThrow('SOURCE_CHANGED');
});
