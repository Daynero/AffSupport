import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PRODUCT_VERSION } from '../../../packages/shared/dist/release.js';

/** @param {{version?: string, notes?: {digest?: string, commitRange?: string}, releaseModule?: string}} options */
export async function prepareProjection({ version, notes, releaseModule = 'packages/shared/dist/release.js' } = {}) {
  await readFile(releaseModule, 'utf8');
  if (version && version !== PRODUCT_VERSION) throw new Error('Intent version must match the frozen release identity');
  const notesDigest = notes?.digest ?? (notes?.commitRange ? createHash('sha256').update(notes.commitRange).digest('hex') : null);
  if (!notesDigest) throw new Error('Release notes digest or commit range is required');
  return Object.freeze({ productVersion: PRODUCT_VERSION, notesDigest, generatedFiles: ['package.json', 'apps/agent/package.json', 'apps/web/package.json', 'packages/shared/package.json'] });
}
