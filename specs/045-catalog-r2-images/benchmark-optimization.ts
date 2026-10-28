/** Offline process reference only; hosted aggregate-isolate acceptance remains separate. */
import process from 'node:process';
import { optimizeCatalogImage } from '../../supabase/functions/_shared/catalog-image-optimization.ts';

const [label, input] = Deno.args;
if (!label || !input || !/^[a-z0-9-]{1,64}$/u.test(label))
  throw new Error('Usage: benchmark-optimization.ts <case-label> <synthetic-fixture-path>');
const beforeWarmMemory = Deno.memoryUsage();
const warmedCodecs = [];
for (const fixture of Deno.args.slice(2)) {
  const result = await optimizeCatalogImage(await Deno.readFile(fixture));
  warmedCodecs.push({
    mime: result.image.mime,
    width: result.image.width,
    height: result.image.height
  });
}
const source = await Deno.readFile(input);
const beforeRunsMemory = Deno.memoryUsage();
const runs = [];
for (const mode of ['cold', 'warm']) {
  const cpu = process.cpuUsage();
  const started = performance.now();
  const result = await optimizeCatalogImage(source);
  const elapsed = process.cpuUsage(cpu);
  runs.push({
    mode,
    wallMs: performance.now() - started,
    processCpuMs: (elapsed.user + elapsed.system) / 1000,
    memoryAfter: Deno.memoryUsage(),
    sourceBytes: result.image.sourceSize,
    canonicalBytes: result.image.size,
    mime: result.image.mime,
    width: result.image.width,
    height: result.image.height,
    sourceSha256: result.image.sourceSha256,
    canonicalSha256: result.image.sha256,
    optimizationVersion: result.image.optimizationVersion
  });
}
console.log(
  JSON.stringify(
    {
      label,
      warmedCodecs,
      beforeWarmMemory,
      beforeRunsMemory,
      runtime: Deno.version,
      scope:
        'offline-single-process-reference; external process time captures max RSS; not hosted aggregate-isolate proof',
      runs
    },
    null,
    2
  )
);
