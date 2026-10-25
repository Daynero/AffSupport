/** Explicit local-only vendor/mini/full interoperability acceptance harness. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rehearseMiniDbPlan } from './lib/mini-db-rehearsal.mjs';
import { atomicRecord } from './lib/release/task-store.mjs';

export async function main(args = process.argv.slice(2)) {
  const options = new Map(
    args.map(value => {
      const match = /^--(plan|binding|artifact-directory|result)=(.+)$/u.exec(value);
      if (!match)
        throw new Error('DB_REHEARSAL_USAGE: --plan=<draft.json> --binding=<binding.json>');
      return [match[1], match[2]];
    })
  );
  if (options.size !== args.length || !options.has('plan') || !options.has('binding'))
    throw new Error('DB_REHEARSAL_USAGE: --plan=<draft.json> --binding=<binding.json>');
  const load = async path => {
    if (typeof path !== 'string' || !path) throw new Error('DB_REHEARSAL_INPUT_REQUIRED');
    const bytes = await readFile(resolve(path));
    if (bytes.length > 16 * 1024 * 1024) throw new Error('DB_REHEARSAL_INPUT_TOO_LARGE');
    return JSON.parse(bytes.toString('utf8'));
  };
  const result = await rehearseMiniDbPlan({
    cwd: process.cwd(),
    plan: await load(options.get('plan')),
    binding: await load(options.get('binding')),
    ...(options.has('artifact-directory')
      ? { artifactDirectory: resolve(String(options.get('artifact-directory'))) }
      : {})
  });
  if (options.has('result'))
    await atomicRecord(resolve(String(options.get('result'))), result, true);
  console.log(
    JSON.stringify({
      ok: true,
      planDigest: result.plan.planDigest,
      checks: result.evidence.checks,
      artifactPath: result.artifactPath
    })
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : 'DB_REHEARSAL_FAILED'
      })
    );
    process.exitCode = 1;
  });
}
