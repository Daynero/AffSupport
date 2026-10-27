// Real provider checks, restricted to the isolated beta target. Never use customer files.
// From the repository root, with an owner-approved temporary .env.catalog-images.beta:
// nice -n 15 npx --yes deno@2.5.6 run --no-lock --node-modules-dir=none
//   --allow-read=.env.catalog-images.beta,tests/fixtures/restitch-images,.env.catalog-images.beta-provider-recovery
//   --allow-net=d7c5658154bdbb4fb78abc8f624d0dc1.r2.cloudflarestorage.com,catalog-images-beta.soty.pp.ua,api.cloudflare.com
//   --allow-write=specs/045-catalog-r2-images/provider-result.json,.env.catalog-images.beta-provider-recovery
//   specs/045-catalog-r2-images/provider-acceptance.ts
import { AwsClient } from 'npm:aws4fetch@1.0.20';
import {
  CatalogImageR2,
  readCatalogR2Config
} from '../../supabase/functions/_shared/r2-catalog-images.ts';
import { validateCatalogImage } from '../../supabase/functions/_shared/catalog-image-validation.ts';

const values = new Map<string, string>();
for (const line of (await Deno.readTextFile('.env.catalog-images.beta')).split(/\r?\n/u)) {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line.trim());
  if (match) values.set(match[1], match[2]);
}
const config = readCatalogR2Config(key => values.get(key));
if (
  !config ||
  values.get('CATALOG_IMAGES_ENVIRONMENT') !== 'beta' ||
  config.accountId !== 'd7c5658154bdbb4fb78abc8f624d0dc1' ||
  config.publicOrigin !== 'https://catalog-images-beta.soty.pp.ua'
) {
  throw new Error('Refusing any target other than the isolated owner-approved beta resources');
}
const accessKeyId = values.get('R2_CATALOG_ACCESS_KEY_ID');
const secretAccessKey = values.get('R2_CATALOG_SECRET_ACCESS_KEY');
if (!accessKeyId || !secretAccessKey) {
  throw new Error('Missing temporary beta credentials');
}
const signer = new AwsClient({
  accessKeyId,
  secretAccessKey,
  service: 's3',
  region: 'auto'
});
const r2 = new CatalogImageR2(config, signer);
const steps: Array<Record<string, unknown>> = [];
const allocated: Array<{ staging: string; final: string }> = [];
const remaining = new Map<string, { staging: string; final: string }>();
const recoveryDirectory = '.env.catalog-images.beta-provider-recovery';
// Exclusive directory creation refuses a second run while an earlier run needs inspection.
await Deno.mkdir(recoveryDirectory, { mode: 0o700 });
async function persistOwnedIdentities() {
  const temporary = `${recoveryDirectory}/owned.json.tmp`;
  await Deno.writeTextFile(
    temporary,
    JSON.stringify(
      {
        environment: 'beta',
        account_id: config!.accountId,
        staging_bucket: config!.stagingBucket,
        public_bucket: config!.publicBucket,
        owned_objects: [...remaining.values()]
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  await Deno.rename(temporary, `${recoveryDirectory}/owned.json`);
}
await persistOwnedIdentities();
const signal = () => AbortSignal.timeout(30_000);
const requireThat = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
async function stage(name: string, action: () => Promise<unknown>) {
  const started = performance.now();
  try {
    const detail = await action();
    steps.push({
      stage: name,
      ok: true,
      elapsed_ms: Math.round(performance.now() - started),
      detail
    });
    console.log(JSON.stringify({ stage: name, ok: true }));
  } catch (error) {
    // Never serialize fetch errors (they can contain a presigned URL) or provider payloads.
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[A-Z_]+$/u.test(error.code)
        ? error.code
        : 'CHECK_FAILED';
    steps.push({
      stage: name,
      ok: false,
      code,
      elapsed_ms: Math.round(performance.now() - started)
    });
    console.log(JSON.stringify({ stage: name, ok: false, code }));
    throw new Error('Provider acceptance stopped; see the sanitized stage report');
  }
}
const consume = async (response: Response) => {
  await response.body?.cancel();
  return response.status;
};
async function verifyDeliveredResponse(response: Response, bytes: Uint8Array, mime: string) {
  requireThat(
    response.status === 200 &&
      response.headers.get('content-type')?.split(';')[0]?.trim() === mime &&
      response.headers.get('x-content-type-options')?.toLowerCase() === 'nosniff',
    'Delivered response headers mismatch'
  );
  const actual = new Uint8Array(await response.arrayBuffer());
  requireThat(
    actual.length === bytes.length && actual.every((value, index) => value === bytes[index]),
    'Delivered response bytes mismatch'
  );
}
let failed = false;
let recoveryUncertain = false;
try {
  for (const [fixture, mime] of [
    ['plain.png', 'image/png'],
    ['plain.jpg', 'image/jpeg'],
    ['plain.webp', 'image/webp']
  ] as const) {
    const bytes = await Deno.readFile(`tests/fixtures/restitch-images/${fixture}`);
    const image = await validateCatalogImage(bytes, mime);
    const staging = crypto.randomUUID();
    const final = `v1/${crypto.randomUUID()}`;
    allocated.push({ staging, final });
    remaining.set(staging, { staging, final });
    await persistOwnedIdentities();
    const grant = await r2.stagingGrant(
      staging,
      mime,
      new Date(Date.now() + 300_000).toISOString(),
      1
    );
    await stage(`${mime}:cors_allowed_and_denied`, async () => {
      const allowed = await fetch(grant.url, {
        method: 'OPTIONS',
        signal: signal(),
        headers: {
          Origin: 'http://127.0.0.1:5175',
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'content-type'
        }
      });
      requireThat(
        allowed.ok &&
          allowed.headers.get('access-control-allow-origin') === 'http://127.0.0.1:5175' &&
          allowed.headers
            .get('access-control-allow-methods')
            ?.split(',')
            .map(value => value.trim().toUpperCase())
            .includes('PUT') &&
          allowed.headers
            .get('access-control-allow-headers')
            ?.split(',')
            .map(value => value.trim().toLowerCase())
            .includes('content-type'),
        'Allowed preflight failed'
      );
      await consume(allowed);
      const denied = await fetch(grant.url, {
        method: 'OPTIONS',
        signal: signal(),
        headers: {
          Origin: 'https://example.invalid',
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'content-type'
        }
      });
      requireThat(
        denied.status === 403 &&
          !['*', 'https://example.invalid'].includes(
            denied.headers.get('access-control-allow-origin') ?? ''
          ),
        'Unintended origin permitted'
      );
      return {
        denied_status: await consume(denied),
        scope: 'HTTP preflight; browser enforcement is a separate check'
      };
    });
    await stage(`${mime}:staging_presign_and_readback`, async () => {
      const response = await fetch(grant.url, {
        method: 'PUT',
        headers: grant.headers,
        body: bytes,
        signal: signal()
      });
      requireThat(response.ok, 'Staging PUT failed');
      await consume(response);
      const actual = await r2.readStaging(staging, bytes.length, signal());
      requireThat(
        actual?.length === bytes.length && actual.every((value, index) => value === bytes[index]),
        'Staging mismatch'
      );
      return { bytes: bytes.length };
    });
    await stage(`${mime}:signed_mime_cannot_change`, async () => {
      const response = await fetch(grant.url, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/html' },
        body: bytes,
        signal: signal()
      });
      requireThat(response.status === 403, 'Signed MIME was mutable');
      return { status: await consume(response) };
    });
    await stage(`${mime}:staging_grant_cannot_write_public`, async () => {
      const forged = new URL(grant.url);
      forged.pathname = `/${config.publicBucket}/${final}`;
      const response = await fetch(forged, {
        method: 'PUT',
        headers: grant.headers,
        body: bytes,
        signal: signal()
      });
      requireThat(response.status === 403, 'Staging grant escaped its target');
      return { status: await consume(response) };
    });
    await stage(`${mime}:missing_candidate_is_not_cached`, async () => {
      const statuses: string[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(r2.publicUrl(final), { signal: signal() });
        requireThat(
          response.status === 404 &&
            ['BYPASS', 'DYNAMIC', 'MISS'].includes(response.headers.get('cf-cache-status') ?? '') &&
            !response.headers.has('age'),
          'Negative cache present'
        );
        statuses.push(response.headers.get('cf-cache-status') ?? 'unreported');
        await consume(response);
      }
      return { cache_statuses: statuses };
    });
    await stage(`${mime}:create_only_and_anonymous_verified`, async () => {
      requireThat(
        (await r2.putFinal(final, bytes, mime, signal(), image.sha256)) === 'created',
        'First creation failed'
      );
      await r2.verify(final, bytes, mime, signal(), false);
      await r2.verify(final, bytes, mime, signal(), true);
      const changed = bytes.slice();
      changed[changed.length - 1] ^= 1;
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', changed)))
        .map(value => value.toString(16).padStart(2, '0'))
        .join('');
      requireThat(
        (await r2.putFinal(final, changed, mime, signal(), digest)) === 'exists',
        'Conditional overwrite was accepted'
      );
      await r2.verify(final, bytes, mime, signal(), false);
      await r2.verify(final, bytes, mime, signal(), true);
      return { mime, nosniff: true, original_bytes_preserved: true };
    });
    await stage(`${mime}:staging_replay_does_not_change_final`, async () => {
      const response = await fetch(grant.url, {
        method: 'PUT',
        headers: grant.headers,
        body: new Uint8Array([1, 2, 3]),
        signal: signal()
      });
      requireThat(response.ok, 'Replay fixture was not accepted');
      await consume(response);
      await r2.verify(final, bytes, mime, signal(), false);
      await r2.verify(final, bytes, mime, signal(), true);
      return { unexpired_replay_observed: true, origin_and_public_unchanged: true };
    });
    await stage(`${mime}:positive_cdn_cache`, async () => {
      const statuses: string[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(r2.publicUrl(final), { signal: signal() });
        statuses.push(response.headers.get('cf-cache-status') ?? 'unreported');
        requireThat(
          response.headers.get('cache-control')?.includes('immutable'),
          'Immutable metadata absent'
        );
        // Ordinary CDN delivery, including each HIT, must match the exact fixture too.
        await verifyDeliveredResponse(response, bytes, mime);
      }
      requireThat(statuses.includes('HIT'), 'No positive cache hit observed');
      return { cache_statuses: statuses };
    });
  }
} catch {
  failed = true;
} finally {
  for (const { staging, final } of allocated) {
    let stagingCleaned = false;
    let publicCleaned = false;
    try {
      await stage('cleanup_owned_synthetic_staging', async () => {
        await r2.remove('staging', staging, signal());
        stagingCleaned = true;
        return { origin_absent: true };
      });
    } catch {
      failed = true;
    }
    // A staging error must never prevent final-object deletion and its CDN purge.
    try {
      await stage('cleanup_owned_synthetic_public_and_cdn', async () => {
        await r2.remove('public', final, signal());
        const response = await fetch(r2.publicUrl(final), { signal: signal() });
        requireThat(response.status === 404, 'Deleted object still publicly reachable');
        publicCleaned = true;
        return { anonymous_status: await consume(response) };
      });
    } catch {
      failed = true;
    }
    if (stagingCleaned && publicCleaned) {
      remaining.delete(staging);
      try {
        await persistOwnedIdentities();
      } catch {
        // Keep attempting cleanup for the other allocated objects even if local storage fails.
        failed = true;
        recoveryUncertain = true;
      }
    }
  }
  if (remaining.size === 0 && !recoveryUncertain) {
    try {
      await Deno.remove(`${recoveryDirectory}/owned.json`);
      await Deno.remove(recoveryDirectory);
    } catch {
      failed = true;
      recoveryUncertain = true;
    }
  }
  const report = {
    scope: 'actual_beta_r2_adapter_http_and_cdn_only',
    generated_at: new Date().toISOString(),
    runtime: Deno.version,
    ok: !failed,
    private_recovery_retained: remaining.size > 0 || recoveryUncertain,
    steps,
    not_proven: [
      'real browser CORS enforcement',
      'presigned URL denial after expiry',
      'hosted Supabase gateway/cron and aggregate isolate limits',
      'application DB publication/adoption/revocation races against live provider',
      'Meta importer acceptance',
      'production readiness'
    ]
  };
  await Deno.writeTextFile(
    'specs/045-catalog-r2-images/provider-result.json',
    JSON.stringify(report, null, 2) + '\n'
  );
  console.log(JSON.stringify({ ok: !failed, checks: steps.length }));
}
if (failed) Deno.exit(1);
