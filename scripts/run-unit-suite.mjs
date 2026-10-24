#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UNIT_SUITE_SHARDS,
  unitSuiteMergeArgs,
  unitSuiteShardArgs
} from './lib/unit-suite-shards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
const coverage = process.argv.includes('--coverage');
const report = path.join(root, 'verification-suite.json');
rmSync(report, { force: true });
const temp = mkdtempSync(path.join(tmpdir(), 'soty-unit-suite-'));
const blobs = path.join(temp, 'blobs');
mkdirSync(blobs);

function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
}

let executedShards = 0;
try {
  for (let shard = 1; shard <= UNIT_SUITE_SHARDS; shard += 1) {
    const args = unitSuiteShardArgs({
      vitest,
      root,
      shard,
      blob: path.join(blobs, `${shard}.blob`),
      coverageDir: path.join(temp, `coverage-${shard}`),
      coverage
    });
    process.stdout.write(`suite shard ${shard}/${UNIT_SUITE_SHARDS}\n`);
    const code = await run(args, { SOTY_VERIFY_SHARD: `${shard}/${UNIT_SUITE_SHARDS}` });
    executedShards += 1;
    if (code !== 0) process.exitCode = code;
    if (code !== 0) break;
  }
  const completedShards = readdirSync(blobs).filter(name => /^[1-8]\.blob$/u.test(name)).length;
  const shardFailure = process.exitCode || (completedShards !== UNIT_SUITE_SHARDS ? 1 : 0);
  if (completedShards > 0) {
    // Failed shards also produce useful reports. Merge before removing scratch,
    // keeping the original failure and never publishing partial coverage.
    process.stdout.write(shardFailure ? 'suite partial merge\n' : 'suite merge\n');
    const mergeCode = await run(
      unitSuiteMergeArgs({
        vitest,
        blobs,
        report,
        coverageDir: path.join(root, 'coverage'),
        coverage: coverage && !shardFailure
      })
    );
    process.exitCode = shardFailure || mergeCode;
    if (existsSync(report)) {
      const result = JSON.parse(readFileSync(report, 'utf8'));
      result.sotySuite = {
        plannedShards: UNIT_SUITE_SHARDS,
        executedShards,
        completedShards,
        complete: completedShards === UNIT_SUITE_SHARDS && executedShards === UNIT_SUITE_SHARDS
      };
      writeFileSync(report, JSON.stringify(result));
    }
  } else {
    process.exitCode = shardFailure;
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
