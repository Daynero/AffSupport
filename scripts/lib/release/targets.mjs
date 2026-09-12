import { createHash } from 'node:crypto';
import { PRODUCTION_SITE_ORIGIN } from '../../../packages/shared/dist/release.js';

const REQUIRED = ['bindingId', 'repository', 'releaseRepository', 'siteOrigin', 'cloudflareProject', 'supabaseProject', 'signingKeyFingerprint', 'artifactUrlBase'];

export class TargetError extends Error {
  constructor(message) { super(message); this.code = 'TARGET_MISMATCH'; }
}

export function resolveTargetBinding(intent, bindings) {
  const binding = bindings?.[intent.targetId];
  if (!binding || typeof binding !== 'object') throw new TargetError(`No configured target binding for ${intent.targetId}`);
  for (const field of REQUIRED) if (typeof binding[field] !== 'string' || !binding[field]) throw new TargetError(`Target binding is missing ${field}`);
  if (binding.kind !== intent.targetKind) throw new TargetError('Intent target kind does not match configured binding');
  if (intent.targetKind === 'production' && binding.siteOrigin !== PRODUCTION_SITE_ORIGIN) throw new TargetError('Production origin is not pinned to release identity');
  if (intent.targetKind === 'sandbox') {
    const production = Object.values(bindings).filter(candidate => candidate?.kind === 'production');
    for (const candidate of production) {
      for (const field of ['repository', 'releaseRepository', 'siteOrigin', 'cloudflareProject', 'supabaseProject', 'artifactUrlBase', 'signingKeyFingerprint']) if (candidate[field] === binding[field]) throw new TargetError(`Sandbox target intersects production ${field}`);
    }
  }
  return Object.freeze({ ...binding, digest: createHash('sha256').update(JSON.stringify(binding)).digest('hex') });
}
