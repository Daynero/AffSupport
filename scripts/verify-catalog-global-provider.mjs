#!/usr/bin/env node
/**Read-only isolated acceptance. No provisioning, cleanup or policy activation.*/
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { probeCatalogGlobalRetirement } from './lib/catalog-global-retirement-probe.mjs';
const args = process.argv.slice(2),
  option = name => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
try {
  const input = option('--manifest'),
    output = option('--output'),
    phase = option('--phase') ?? 'delivery';
  if (!input || !output) throw new Error('Use --manifest OWNED_FIXTURE_JSON --output REPORT_JSON');
  const manifest = JSON.parse(await readFile(path.resolve(input), 'utf8'));
  if (
    !['dev', 'beta'].includes(manifest.environment) ||
    manifest.ownedFixture !== true ||
    !['delivery', 'retirement-before', 'retirement-after'].includes(phase) ||
    (phase === 'delivery' &&
      (!Array.isArray(manifest.images) ||
        manifest.images.length < 1 ||
        manifest.images.length > 10))
  )
    throw new Error('Only bounded owned dev/beta fixtures are accepted');
  const origin = new URL(manifest.origin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== manifest.origin ||
    process.env.CATALOG_GLOBAL_PROVIDER_CONFIRMATION !== `${manifest.environment}:${origin.origin}`
  )
    throw new Error('Exact isolated provider confirmation is required');
  const retirement =
    phase === 'delivery' ? null : await probeCatalogGlobalRetirement(manifest, { phase });
  const checks = [];
  for (const image of phase === 'delivery' ? manifest.images : []) {
    if (
      !/^[0-9a-f-]{36}$/u.test(image.id) ||
      !/^\w{64}$/u.test(image.sha256) ||
      !['image/jpeg', 'image/png'].includes(image.mime) ||
      !Array.isArray(image.urls) ||
      image.urls.length !== 3
    )
      throw new Error('Invalid owned image fixture');
    for (const raw of image.urls) {
      const url = new URL(raw);
      if (
        url.origin !== origin.origin ||
        !/^\/g\/[A-Za-z0-9_-]{82}\.(jpg|png)$/u.test(url.pathname) ||
        url.search ||
        url.hash
      )
        throw new Error('Foreign or malformed fixture URL');
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(15_000)
        });
        if (
          response.status !== 200 ||
          response.headers.get('content-type')?.split(';')[0] !== image.mime ||
          response.headers.get('x-content-type-options') !== 'nosniff' ||
          !response.body
        )
          throw new Error('Public image delivery contract failed');
        const hash = createHash('sha256'),
          reader = response.body.getReader();
        let size = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > 8_000_000) {
              await reader.cancel();
              throw new Error('Public image exceeds bound');
            }
            hash.update(part.value);
          }
        } finally {
          reader.releaseLock();
        }
        if (hash.digest('hex') !== image.sha256 || size !== image.size)
          throw new Error('Public bytes do not match canonical fixture');
        checks.push({
          image_id: image.id,
          attempt,
          status: response.status,
          size,
          cache_status: response.headers.get('cf-cache-status') ?? 'unobserved'
        });
      }
    }
  }
  const evidence = {
    schema: 1,
    phase,
    retirement_observation: retirement,
    environment: manifest.environment,
    source_sha: manifest.sourceSha ?? null,
    routing_revision: manifest.routingRevision ?? null,
    observed_at: new Date().toISOString(),
    http: 'verified',
    checks,
    browser: 'unverified',
    installed_macos: 'unverified',
    installed_windows: 'unverified',
    meta_import: 'unverified',
    origin_request_fanout: 'unverified',
    retirement: 'unverified',
    acceptance: 'blocked',
    note: 'HTTP readback does not prove browser delivery, canonical cache fanout, platform ingestion or deletion. Add independently captured exact-source acceptance before T0.'
  };
  await writeFile(path.resolve(output), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(
    'Isolated HTTP checks passed; full provider/platform acceptance remains blocked.\n'
  );
} catch {
  process.stderr.write(
    'Isolated provider verification failed. No activation or deletion was attempted.\n'
  );
  process.exitCode = 1;
}
