#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
    if (code !== 0) process.exitCode = code;
    if (code !== 0) break;
  }
  if (!process.exitCode) {
    process.stdout.write('suite merge\n');
    process.exitCode = await run(
      unitSuiteMergeArgs({
        vitest,
        blobs,
        report: path.join(root, 'verification-suite.json'),
        coverageDir: path.join(root, 'coverage'),
        coverage
      })
    );
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
