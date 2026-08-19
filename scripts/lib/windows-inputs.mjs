// Pure validation rules for packaging/windows/inputs.json.
//
// Kept separate from scripts/fetch-windows-inputs.mjs so the rules can be unit
// tested without executing the downloader's CLI entrypoint.

/**
 * Narrows the manifest from `unknown`. Untrusted-at-the-boundary data is
 * validated, never cast: a malformed manifest must name the offending field
 * rather than blow up later with an unhelpful runtime error.
 */
export function parseInputsManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'manifest must be an object' };
  }
  const source = value;
  if (source.schemaVersion !== 1) {
    return { ok: false, error: `unsupported schemaVersion ${String(source.schemaVersion)}` };
  }
  if (!Array.isArray(source.inputs) || source.inputs.length === 0) {
    return { ok: false, error: 'manifest.inputs must be a non-empty array' };
  }

  const inputs = [];
  const seen = new Set();
  for (const [index, entry] of source.inputs.entries()) {
    const at = `inputs[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: `${at} must be an object` };
    }
    const id = entry.id;
    if (typeof id !== 'string' || !/^[a-z0-9-]+$/u.test(id)) {
      return { ok: false, error: `${at}.id must be a kebab-case string` };
    }
    if (seen.has(id)) return { ok: false, error: `duplicate input id ${id}` };
    seen.add(id);

    if (!['pinned', 'built', 'pending'].includes(entry.status)) {
      return { ok: false, error: `${id}.status must be "pinned", "built" or "pending"` };
    }
    if (!['raw', 'zip', 'tar.gz', 'git', 'none'].includes(entry.archiveKind)) {
      return { ok: false, error: `${id}.archiveKind must be raw, zip, tar.gz, git or none` };
    }
    if (!Array.isArray(entry.staging) || entry.staging.length === 0) {
      return { ok: false, error: `${id}.staging must be a non-empty array` };
    }
    for (const target of entry.staging) {
      if (!target || typeof target.env !== 'string' || !/^[A-Z0-9_]+$/u.test(target.env)) {
        return { ok: false, error: `${id}.staging[].env must be an environment variable name` };
      }
      if (target.memberPath !== null && typeof target.memberPath !== 'string') {
        return { ok: false, error: `${id}.staging[].memberPath must be a string or null` };
      }
      if (target.kind !== undefined && target.kind !== 'directory') {
        return { ok: false, error: `${id}.staging[].kind must be omitted or "directory"` };
      }
    }
    if (typeof entry.license !== 'string' || !entry.license) {
      return { ok: false, error: `${id}.license is required for attribution` };
    }
    if (typeof entry.provenance !== 'string' || !entry.provenance) {
      return { ok: false, error: `${id}.provenance is required for attribution` };
    }
    if (entry.sourceArchiveFor !== null && typeof entry.sourceArchiveFor !== 'string') {
      return { ok: false, error: `${id}.sourceArchiveFor must be an input id or null` };
    }

    // A git source is pinned by commit hash, which is itself cryptographic —
    // no separate file checksum exists or is needed.
    if (entry.status === 'pinned' && entry.archiveKind === 'git') {
      if (typeof entry.gitRevision !== 'string' || !/^[a-f0-9]{40}$/u.test(entry.gitRevision)) {
        return { ok: false, error: `${id}.gitRevision must be a full 40-character commit hash` };
      }
      if (typeof entry.upstreamUrl !== 'string' || !entry.upstreamUrl.startsWith('https://')) {
        return { ok: false, error: `${id} needs an https upstreamUrl to clone from` };
      }
    } else if (entry.status === 'pinned') {
      if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
        return { ok: false, error: `${id}.sha256 must be 64 lowercase hex characters` };
      }
      if (!Number.isInteger(entry.sizeBytes) || entry.sizeBytes <= 0) {
        return { ok: false, error: `${id}.sizeBytes must be a positive integer` };
      }
      const url = entry.mirrorUrl ?? entry.upstreamUrl;
      if (typeof url !== 'string' || !url.startsWith('https://')) {
        return { ok: false, error: `${id} needs an https mirrorUrl or upstreamUrl` };
      }
      if (entry.archiveKind !== 'raw') {
        for (const target of entry.staging) {
          if (typeof target.memberPath !== 'string' || !target.memberPath) {
            return { ok: false, error: `${id}.staging[].memberPath is required for an archive` };
          }
        }
      }
    }

    // A built input is compiled in CI from other inputs rather than downloaded,
    // so what has to be pinned is its sources.
    if (entry.status === 'built') {
      if (!Array.isArray(entry.builtFrom) || entry.builtFrom.length === 0) {
        return { ok: false, error: `${id}.builtFrom must name the inputs it is compiled from` };
      }
    }
    inputs.push(entry);
  }

  for (const entry of inputs) {
    if (entry.sourceArchiveFor && !seen.has(entry.sourceArchiveFor)) {
      return { ok: false, error: `${entry.id}.sourceArchiveFor names unknown input` };
    }
    for (const source of entry.builtFrom ?? []) {
      if (!seen.has(source)) {
        return { ok: false, error: `${entry.id}.builtFrom names unknown input ${source}` };
      }
    }
  }

  return { ok: true, value: { schemaVersion: 1, mirrorRelease: source.mirrorRelease, inputs } };
}

/** Copyleft binaries may only ship with their complete corresponding source. */
export function copyleftSourceGaps(manifest) {
  const gaps = [];
  for (const entry of manifest.inputs) {
    if (entry.sourceArchiveFor) continue;
    if (!/gpl|lgpl/iu.test(entry.license)) continue;
    const companions = manifest.inputs.filter(
      candidate => candidate.sourceArchiveFor === entry.id && candidate.status === 'pinned'
    );
    if (companions.length === 0) gaps.push(entry.id);
  }
  return gaps;
}

/** Inputs that still block a release build. */
export function releaseBlockers(manifest) {
  const byId = new Map(manifest.inputs.map(entry => [entry.id, entry]));
  const pending = manifest.inputs
    .filter(
      entry =>
        entry.status === 'pending' ||
        // A built input is blocked when any of its sources is.
        (entry.builtFrom ?? []).some(source => byId.get(source)?.status !== 'pinned')
    )
    .map(e => e.id);
  const sourceGaps = copyleftSourceGaps(manifest)
    .filter(id => !pending.includes(id))
    .map(id => `${id} (no pinned source archive)`);
  return [...pending, ...sourceGaps];
}
