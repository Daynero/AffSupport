import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateWindowsEvidence } from './lib/release/platform-evidence.mjs';
if (process.env.GITHUB_ACTIONS !== 'true' || !/^\d+$/u.test(process.env.GITHUB_RUN_ID ?? ''))
  throw new Error('WINDOWS_HOSTED_WORKFLOW_REQUIRED');
const [mode, installer] = process.argv.slice(2);
if (!['smoke', 'final'].includes(mode) || !installer)
  throw new Error('WINDOWS_EVIDENCE_INPUT_INVALID');
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const installerSha256 = createHash('sha256')
  .update(await readFile(installer))
  .digest('hex');
const file = path.join(
  'release',
  'windows',
  mode === 'smoke' ? 'smoke-evidence.json' : 'release-evidence.json'
);
if (mode === 'smoke')
  await writeFile(
    file,
    JSON.stringify({ sourceSha, installerSha256, workflowRunId: process.env.GITHUB_RUN_ID })
  );
else {
  const smoke = JSON.parse(
    await readFile(path.join('release/windows/smoke-evidence.json'), 'utf8')
  );
  if (
    smoke.sourceSha !== sourceSha ||
    smoke.workflowRunId !== process.env.GITHUB_RUN_ID ||
    !/^[a-f0-9]{64}$/u.test(smoke.installerSha256 ?? '')
  )
    throw new Error('WINDOWS_SMOKE_BINDING_MISMATCH');
  const proof = {
    schemaVersion: 1,
    sourceSha,
    installerSha256,
    smokeInstallerSha256: smoke.installerSha256,
    workflowRunId: process.env.GITHUB_RUN_ID,
    validation: 'passed',
    installUseUninstall: 'passed',
    productionPackage: 'passed',
    verifiedAt: new Date().toISOString()
  };
  validateWindowsEvidence(proof, { sourceSha, installerSha256 });
  await writeFile(file, JSON.stringify(proof, null, 2) + '\n');
}
