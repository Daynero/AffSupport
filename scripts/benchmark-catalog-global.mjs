#!/usr/bin/env node
/** Full052 benchmark uses only the canonical disposable schema/roles clone, never source rows. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const args = process.argv.slice(2),
  position = args.indexOf('--output'),
  output = position < 0 ? undefined : args[position + 1];
if (
  args.some((value, index) => value !== '--output' && !(position >= 0 && index === position + 1)) ||
  (position >= 0 && !output)
) {
  process.stderr.write(
    'Use nice -n15 node scripts/benchmark-catalog-global.mjs [--output REPORT_JSON]\n'
  );
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ['scripts/test-db-isolated.mjs'], {
    env: {
      ...process.env,
      SOTY_GLOBAL_BENCHMARK_FULL: '1',
      ...(output ? { SOTY_GLOBAL_BENCHMARK_REPORT: path.resolve(output) } : {})
    },
    stdio: 'inherit',
    shell: false,
    timeout: 900_000
  });
  process.exitCode = result.status ?? 1;
}
