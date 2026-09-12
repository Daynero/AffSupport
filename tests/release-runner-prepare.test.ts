import { describe, expect, it } from 'vitest';
import { PRODUCT_VERSION } from '../packages/shared/src/release';
import { prepareProjection } from '../scripts/lib/release/prepare.mjs';

describe('release preparation projection', () => {
  it('projects one frozen release identity and deterministic notes without protocol edits', async () => {
    const projection = await prepareProjection({
      version: PRODUCT_VERSION,
      notes: { commitRange: 'abcdef0..1234567' }
    });
    expect(projection.productVersion).toBe(PRODUCT_VERSION);
    expect(projection.notesDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(projection.generatedFiles).toContain('packages/shared/package.json');
  });
  it('rejects a source/candidate version divergence', async () => {
    await expect(
      prepareProjection({ version: '99.0.0', notes: { digest: 'a'.repeat(64) } })
    ).rejects.toThrow('frozen release identity');
  });
});
