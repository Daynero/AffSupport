import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { removeTemporaryDirectory } from './support/temp-dir';

const execute = promisify(execFile);

async function fixture(mode: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soty-suite-report-'));
  try {
    await mkdir(path.join(directory, 'scripts/lib'), { recursive: true });
    await mkdir(path.join(directory, 'node_modules/vitest'), { recursive: true });
    for (const file of ['scripts/run-unit-suite.mjs', 'scripts/lib/unit-suite-shards.mjs'])
      await copyFile(new URL(`../${file}`, import.meta.url), path.join(directory, file));
    await writeFile(
      path.join(directory, 'node_modules/vitest/vitest.mjs'),
      `import fs from 'node:fs';
const args=process.argv.slice(2);
const merge=args.some(x=>x.startsWith('--mergeReports='));
const value=name=>args.find(x=>x.startsWith(name+'='))?.slice(name.length+1);
fs.appendFileSync('calls.jsonl',JSON.stringify({merge,coverage:args.includes('--coverage')})+'\\n');
if(merge){
 fs.writeFileSync(value('--outputFile.json'),JSON.stringify({numPassedTests:3,numFailedTests:${mode === 'success' ? 0 : 1}}));
 process.exit(${mode === 'merge-fails' ? 37 : 0});
}
if(${JSON.stringify(mode)}!=='no-blob')fs.writeFileSync(value('--outputFile.blob'),'owned shard artifact');
process.exit(${mode === 'success' ? 0 : 23});`
    );
    await writeFile(path.join(directory, 'verification-suite.json'), '{"stale":true}');
    let code = 0;
    try {
      await execute(process.execPath, ['scripts/run-unit-suite.mjs', '--coverage'], {
        cwd: directory,
        timeout: 10_000,
        maxBuffer: 1024 * 1024
      });
    } catch (error) {
      code = (error as { code: number }).code;
    }
    const calls = (await readFile(path.join(directory, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    let report;
    try {
      report = JSON.parse(await readFile(path.join(directory, 'verification-suite.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { code, calls, report };
  } finally {
    await removeTemporaryDirectory(directory);
  }
}

it.each(['failed-blob', 'merge-fails'])(
  'retains a partial failure report without coverage or replacing the shard failure: %s',
  async mode => {
    const result = await fixture(mode);
    expect(result.code).toBe(23);
    expect(result.calls).toEqual([
      { merge: false, coverage: true },
      { merge: true, coverage: false }
    ]);
    expect(result.report).toMatchObject({
      numPassedTests: 3,
      numFailedTests: 1,
      sotySuite: { plannedShards: 8, completedShards: 1, complete: false }
    });
  },
  15_000
);

it('removes stale success evidence when a shard exits before producing a blob', async () => {
  const result = await fixture('no-blob');
  expect(result.code).toBe(23);
  expect(result.calls).toEqual([{ merge: false, coverage: true }]);
  expect(result.report).toBeUndefined();
}, 15_000);

it('merges all successful shards with coverage and marks the report complete', async () => {
  const result = await fixture('success');
  expect(result.code).toBe(0);
  expect(result.calls).toHaveLength(9);
  expect(result.calls.at(-1)).toEqual({ merge: true, coverage: true });
  expect(result.report).toMatchObject({
    numFailedTests: 0,
    sotySuite: { plannedShards: 8, completedShards: 8, complete: true }
  });
}, 15_000);
