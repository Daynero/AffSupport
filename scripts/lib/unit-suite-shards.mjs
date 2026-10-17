import path from 'node:path';

export const UNIT_SUITE_SHARDS = 8;

export function unitSuiteShardArgs({
  vitest,
  root,
  shard,
  total = UNIT_SUITE_SHARDS,
  blob,
  coverageDir,
  coverage
}) {
  return [
    vitest,
    'run',
    '--project=unit',
    '--maxWorkers=1',
    '--no-file-parallelism',
    `--shard=${shard}/${total}`,
    '--reporter=dot',
    `--reporter=${path.join(root, 'scripts/lib/suite-progress-reporter.mjs')}`,
    '--reporter=blob',
    `--outputFile.blob=${blob}`,
    '--silent=passed-only',
    ...(coverage ? ['--coverage', `--coverage.reportsDirectory=${coverageDir}`] : [])
  ];
}

export function unitSuiteMergeArgs({ vitest, blobs, report, coverageDir, coverage }) {
  return [
    vitest,
    `--mergeReports=${blobs}`,
    '--reporter=dot',
    '--reporter=json',
    `--outputFile.json=${report}`,
    ...(coverage ? ['--coverage', `--coverage.reportsDirectory=${coverageDir}`] : [])
  ];
}
