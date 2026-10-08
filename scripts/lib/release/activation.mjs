import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readJournal } from './journal.mjs';
import { validTaskId } from './task-store.mjs';
const exec = promisify(execFile);
/** Evidence check, not an approval boolean or dry-run bypass. */
export async function validateProductionActivation(root, repositoryRoot) {
  let evidence;
  try { evidence = JSON.parse(await readFile(path.join(root, 'activation.json'), 'utf8')); }
  catch { throw new Error('PRODUCTION_ACTIVATION_NOT_PROVEN'); }
  if (evidence.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(evidence.governanceSha ?? '') ||
      !Array.isArray(evidence.sandboxRunIds) || new Set(evidence.sandboxRunIds).size < 3) throw new Error('PRODUCTION_ACTIVATION_NOT_PROVEN');
  const { stdout } = await exec('git', ['show', `${evidence.governanceSha}:.specify/memory/constitution.md`], { cwd: repositoryRoot, timeout: 10000, maxBuffer: 65536 });
  if (!stdout.includes('2.0.0')) throw new Error('G0_RATIFICATION_NOT_PROVEN');
  await exec('git', ['merge-base', '--is-ancestor', evidence.governanceSha, 'HEAD'], { cwd: repositoryRoot, timeout: 10000 });
  for (const runId of evidence.sandboxRunIds) {
    validTaskId(runId);
    const directory = path.join(root, runId);
    const snapshot = JSON.parse(await readFile(path.join(directory, 'snapshot.json'), 'utf8'));
    const events = await readJournal(path.join(directory, 'journal.ndjson'), runId);
    const worker = events.find((e) => e.type === 'worker_started' && e.payload.executionMode === 'live' && e.payload.adapterOverride === false);
    if (snapshot.targetKind !== 'sandbox' || snapshot.state !== 'completed' || !worker ||
        !events.some((e) => e.type === 'step_completed' && e.payload.stepId === 'live_verify') ||
        !events.some((e) => e.type === 'run_completed')) throw new Error('SANDBOX_ACCEPTANCE_NOT_PROVEN');
  }
}
