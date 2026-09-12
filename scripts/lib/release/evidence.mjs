import { createHash } from 'node:crypto';

export function fingerprintEvidence(input) {
  const safe = { sourceSha: input.sourceSha, runnerRevision: input.runnerRevision, publicConfigDigest: input.publicConfigDigest, tools: input.tools ?? {}, artifacts: input.artifacts ?? {} };
  return createHash('sha256').update(JSON.stringify(safe)).digest('hex');
}

export function invalidatedSteps(previous, current, dependencies) {
  const changed = new Set(Object.keys(current).filter(key => previous[key] !== current[key]));
  const invalid = new Set();
  for (const [step, fields] of Object.entries(dependencies)) if (fields.some(field => changed.has(field))) invalid.add(step);
  return invalid;
}

/** Published outputs are immutable facts, never instructions to rebuild. */
export function reusableEvidence(previous, current, { published = false } = {}) {
  if (published) return { reusable: true, action: 'preserve_published_output' };
  return {
    reusable: fingerprintEvidence(previous) === fingerprintEvidence(current),
    action: fingerprintEvidence(previous) === fingerprintEvidence(current) ? 'reuse' : 'revalidate'
  };
}
