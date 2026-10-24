import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { preflightLocal } from './preflight.mjs';
import { provisionLocalFixtures } from './fixtures.mjs';
import { runArrivals } from './arrival.mjs';

/** Small real-Auth API calibration, explicitly not LOAD-01 or a browser performance verdict. */
export async function calibrateLocal(target) {
  const before = await preflightLocal(target);
  if (!before.ok) throw new Error('ACCEPTANCE_PREFLIGHT_FAILED');
  const { actors, state } = await provisionLocalFixtures(target);
  const baseline = await actors.A.rpc('list_team_accounts', { p_team: state.teams.W1 });
  if (!baseline.ok || !Array.isArray(baseline.data))
    throw new Error('ACCEPTANCE_CALIBRATION_FAILED');
  const ids = baseline.data
    .map(row => row.id)
    .sort()
    .join(',');
  const aliases = ['A', 'B', 'C'];
  const result = await runArrivals({
    count: 330,
    intervalMs: 50,
    concurrency: 4,
    warmup: 30,
    timeoutMs: 15000,
    execute: async (index, signal) => {
      if (signal.aborted) return false;
      const response = await actors[aliases[index % 3]].rpc(
        'list_team_accounts',
        {
          p_team: state.teams.W1
        },
        { signal }
      );
      return (
        response.ok &&
        Array.isArray(response.data) &&
        response.data
          .map(row => row.id)
          .sort()
          .join(',') === ids
      );
    }
  });
  const after = await preflightLocal(target);
  const evidence = {
    schemaVersion: 1,
    campaignId: target.namespace,
    kind: 'local-api-calibration',
    generatedAt: new Date().toISOString(),
    targetFingerprint: before.targetFingerprint,
    identityUnchanged: after.ok && after.targetFingerprint === before.targetFingerprint,
    ...result,
    limits: [
      'Three synthetic actors, one workspace, 330 offered reads.',
      'API-only, no Realtime delivery or native browser latency measurement.',
      'Does not satisfy LOAD-01–10 or hosted capacity acceptance.'
    ]
  };
  const directory = path.resolve('release/acceptance', target.namespace, 'load');
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `calibration-${Date.now()}.json`),
    JSON.stringify(evidence, null, 2) + '\n',
    { flag: 'wx' }
  );
  return evidence;
}
