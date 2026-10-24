import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { validateExecution, validateManifest } from './schema.mjs';
import { bindCampaignManifest } from './manifest.mjs';

/** One atomic, immutable file per run avoids torn JSONL tails and duplicate append races. */
export async function appendExecution(root, record, context) {
  if (!validateManifest(context).ok) throw new Error('ACCEPTANCE_MANIFEST_INVALID');
  if (!validateExecution(record, context).ok) throw new Error('ACCEPTANCE_RECORD_INVALID');
  const execution = JSON.parse(JSON.stringify(record));
  const binding = await bindCampaignManifest(root, context, { freeze: true });
  if (execution.manifestSha256 !== undefined && execution.manifestSha256 !== binding.sha256)
    throw new Error('ACCEPTANCE_RECORD_INVALID');
  const canonicalRoot = binding.root;
  await verifyEvidence(canonicalRoot, execution.evidence);
  const directory = path.join(canonicalRoot, 'runs');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await realpath(directory)) !== directory) throw new Error('ACCEPTANCE_RECORD_PATH_UNSAFE');
  const temporary = path.join(directory, `.pending-${randomUUID()}`);
  const destination = path.join(directory, `${execution.runId}.json`);
  let handle;
  let owned = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    owned = true;
    await handle.writeFile(JSON.stringify({ ...execution, manifestSha256: binding.sha256 }) + '\n');
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, destination);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
        throw new Error('ACCEPTANCE_RUN_EXISTS', { cause: error });
      throw error;
    }
  } finally {
    await handle?.close();
    if (owned) await unlink(temporary);
  }
  return { ok: true, runId: execution.runId };
}

export async function verifyEvidence(root, evidenceRefs) {
  const canonicalRoot = await realpath(root);
  for (const evidence of evidenceRefs) {
    const artifact = path.resolve(canonicalRoot, evidence.path);
    const actualPath = await realpath(artifact);
    if (!actualPath.startsWith(canonicalRoot + path.sep))
      throw new Error('ACCEPTANCE_EVIDENCE_UNSAFE');
    const info = await lstat(artifact);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024)
      throw new Error('ACCEPTANCE_EVIDENCE_UNSAFE');
    const digest = createHash('sha256')
      .update(await readFile(artifact))
      .digest('hex');
    if (digest !== evidence.sha256) throw new Error('ACCEPTANCE_EVIDENCE_MISMATCH');
  }
}
