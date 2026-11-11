import { createHash } from 'node:crypto';
import {
  PREVIEW_BRANCH,
  PREVIEW_SITE_ORIGIN,
  PRODUCTION_SITE_ORIGIN
} from '../../../packages/shared/dist/release.js';

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
  // 051: the candidate address is part of the same production, so it is pinned
  // to release identity exactly like the main origin. A sandbox may name its own
  // preview, but never one that production uses.
  if (intent.targetKind === 'production') {
    for (const [field, pinned] of [['previewSiteOrigin', PREVIEW_SITE_ORIGIN], ['previewBranch', PREVIEW_BRANCH]])
      if (binding[field] !== undefined && binding[field] !== pinned) throw new TargetError(`Production ${field} is not pinned to release identity`);
  }
  for (const field of ['previewSiteOrigin', 'previewBranch']) if (binding[field] !== undefined && (typeof binding[field] !== 'string' || !binding[field])) throw new TargetError(`Target binding has an invalid ${field}`);
  if (binding.previewBranch !== undefined && (binding.previewBranch === 'main' || !/^[a-z0-9-]{1,28}$/u.test(binding.previewBranch))) throw new TargetError('Preview branch must be a non-production Pages branch name');
  if (intent.targetKind === 'sandbox') {
    const production = Object.values(bindings).filter(candidate => candidate?.kind === 'production');
    for (const candidate of production) {
      for (const field of ['repository', 'releaseRepository', 'siteOrigin', 'cloudflareProject', 'supabaseProject', 'artifactUrlBase', 'signingKeyFingerprint']) if (candidate[field] === binding[field]) throw new TargetError(`Sandbox target intersects production ${field}`);
      if (binding.previewSiteOrigin !== undefined && [candidate.siteOrigin, candidate.previewSiteOrigin].includes(binding.previewSiteOrigin)) throw new TargetError('Sandbox target intersects production previewSiteOrigin');
    }
  }
  // A binding file written before 051 names no preview; production's is derived
  // from the tracked release identity, never from configuration.
  const resolved = intent.targetKind === 'production'
    ? { ...binding, previewSiteOrigin: PREVIEW_SITE_ORIGIN, previewBranch: PREVIEW_BRANCH }
    : binding;
  return Object.freeze({ ...resolved, digest: createHash('sha256').update(JSON.stringify(resolved)).digest('hex') });
}
