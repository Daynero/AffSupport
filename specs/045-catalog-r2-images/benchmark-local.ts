// Offline local reference only. This does not attest Supabase Edge isolation or live R2.
// Run from repository root after building shared:
// npx --yes deno@2.5.6 run --no-lock --node-modules-dir=none --allow-read=tests/fixtures/restitch-images specs/045-catalog-r2-images/benchmark-local.ts
import { AwsClient } from 'npm:aws4fetch@1.0.20';
import process from 'node:process';
import { crc32 } from 'node:zlib';
import { validateCatalogImage } from '../../supabase/functions/_shared/catalog-image-validation.ts';
import { CatalogImageR2 } from '../../supabase/functions/_shared/r2-catalog-images.ts';

const baseline = Deno.memoryUsage().rss;
const original = await Deno.readFile('tests/fixtures/restitch-images/plain.png');
const bytes = new Uint8Array(50_000_000);
bytes.set(original.subarray(0, 33));
const length = bytes.length - original.length - 12;
const view = new DataView(bytes.buffer);
view.setUint32(33, length);
bytes.set(new TextEncoder().encode('tEXtbenchmark\0'), 37);
bytes.fill(32, 51, 41 + length);
view.setUint32(41 + length, crc32(bytes.subarray(37, 41 + length)));
bytes.set(original.subarray(33), 45 + length);

let peak = Deno.memoryUsage().rss;
const sample = () => {
  peak = Math.max(peak, Deno.memoryUsage().rss);
};
const timer = setInterval(sample, 1);
const steps: Array<{ stage: string; rss_bytes: number; elapsed_ms: number }> = [];
const start = performance.now();
const cpu = process.cpuUsage();
const mark = (stage: string) => {
  sample();
  steps.push({ stage, rss_bytes: Deno.memoryUsage().rss, elapsed_ms: performance.now() - start });
};
const fetcher: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.method === 'PUT') {
    const reader = request.body!.getReader();
    while (!(await reader.read()).done) sample();
    reader.releaseLock();
    mark('provider_consumed_put');
    return new Response(null, { status: 200 });
  }
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 262144, bytes.length);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      }
    }),
    {
      headers: {
        'content-type': 'image/png',
        'content-length': String(bytes.length),
        'x-content-type-options': 'nosniff'
      }
    }
  );
};
const r2 = new CatalogImageR2(
  {
    accountId: 'a'.repeat(32),
    stagingBucket: 'synthetic-staging',
    publicBucket: 'synthetic-public',
    publicOrigin: 'https://media.invalid',
    zoneId: 'b'.repeat(32),
    purgeToken: 'synthetic-unused'
  },
  new AwsClient({
    accessKeyId: 'SYNTHETIC_TEST_ONLY',
    secretAccessKey: 'synthetic-test-only',
    service: 's3',
    region: 'auto'
  }),
  fetcher
);
try {
  const image = await validateCatalogImage(bytes, 'image/png');
  mark('validated');
  const key = 'v1/45000000-0000-4000-8000-000000000001';
  const signal = new AbortController().signal;
  await r2.putFinal(key, bytes, image.mime, signal, image.sha256);
  mark('put_returned');
  await r2.verify(key, bytes, image.mime, signal, false);
  mark('origin_verified');
  await r2.verify(key, bytes, image.mime, signal, true);
  mark('public_verified');
  const usage = process.cpuUsage(cpu);
  console.log(
    JSON.stringify(
      {
        scope: 'local_reference_only_not_edge_acceptance',
        runtime: Deno.version,
        input_bytes: bytes.length,
        baseline_rss_bytes: baseline,
        peak_rss_bytes: peak,
        cpu_ms: (usage.user + usage.system) / 1000,
        elapsed_ms: performance.now() - start,
        steps
      },
      null,
      2
    )
  );
} finally {
  clearInterval(timer);
}
