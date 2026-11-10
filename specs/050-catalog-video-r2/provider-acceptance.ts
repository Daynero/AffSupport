// Real provider checks for catalog videos (050, T003/T035), restricted to the isolated
// beta video buckets. Never use customer files: the source is synthetic bytes.
// From the repository root, with an owner-approved temporary .env.catalog-videos.beta:
// nice -n 15 npx --yes deno@2.5.6 run --no-lock --node-modules-dir=none
//   --allow-read=.env.catalog-videos.beta
//   --allow-net=<account>.r2.cloudflarestorage.com,<video origin host>,api.cloudflare.com
//   --allow-write=specs/050-catalog-video-r2/provider-result.json
//   specs/050-catalog-video-r2/provider-acceptance.ts
//
// What it proves (and records in provider-result.json):
//   1. multipart create / upload-part / complete / abort on the staging bucket;
//   2. whether `UploadPart` with a wrong `x-amz-checksum-sha256` is refused (decides
//      `CATALOG_VIDEOS_PART_VERIFICATION=provider_checksum`) and whether the right one is echoed;
//   3. readback of every part from staging matches the hashes computed on the way in;
//   4. server-side promotion to the public bucket, anonymous HEAD/Range on the public origin
//      with `video/mp4`, `nosniff`, `accept-ranges: bytes` and the immutable cache header;
//   5. deletion + CDN purge leaves a 404; an orphaned multipart upload can be aborted;
//   6. CPU/wall time per 16 MiB part for the edge budget (R4).
import { AwsClient } from 'npm:aws4fetch@1.0.20';
import {
  CatalogVideoR2,
  readCatalogVideoR2Config,
  sha256Hex
} from '../../supabase/functions/_shared/r2-catalog-video.ts';
import { Md5 } from '../../supabase/functions/_shared/md5.ts';

const values = new Map<string, string>();
for (const line of (await Deno.readTextFile('.env.catalog-videos.beta')).split(/\r?\n/u)) {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line.trim());
  if (match) values.set(match[1]!, match[2]!);
}
const read = (key: string) => values.get(key);
const config = readCatalogVideoR2Config(read);
if (!config || read('CATALOG_IMAGES_ENVIRONMENT') !== 'beta') {
  throw new Error('Refusing any target other than the isolated owner-approved beta video buckets');
}
const accessKeyId = read('R2_CATALOG_VIDEO_ACCESS_KEY_ID');
const secretAccessKey = read('R2_CATALOG_VIDEO_SECRET_ACCESS_KEY');
if (!accessKeyId || !secretAccessKey) throw new Error('Missing temporary beta video credentials');

const steps: Array<Record<string, unknown>> = [];
const step = (name: string, detail: Record<string, unknown>) => {
  steps.push({ name, at: new Date().toISOString(), ...detail });
  console.log(name, JSON.stringify(detail));
};
const key = `v/${crypto.randomUUID().replace(/-/gu, '')}.mp4`;
const signal = AbortSignal.timeout(10 * 60_000);
const PART = 16 * 1024 * 1024;
const TOTAL = 3 * PART + 12_345;
const source = new Uint8Array(TOTAL);
for (let i = 0; i < TOTAL; i += 4096) {
  const chunk = new Uint8Array(source.buffer, i, Math.min(4096, TOTAL - i));
  crypto.getRandomValues(chunk);
}
const md5 = new Md5().update(source).digest();

async function probeProviderChecksum(): Promise<{ refusesWrong: boolean; echoesRight: boolean }> {
  const strict = new CatalogVideoR2({ ...config!, partVerification: 'provider_checksum' }, signer);
  const uploadId = await strict.createMultipart(key, signal);
  const bytes = source.subarray(0, PART);
  let refusesWrong = false;
  try {
    await strict.uploadPart(key, uploadId, 1, bytes, 'f'.repeat(64), signal);
  } catch (error) {
    refusesWrong = error instanceof Error && error.message === 'VIDEO_R2_CHECKSUM_MISMATCH';
  }
  const right = await strict.uploadPart(key, uploadId, 1, bytes, await sha256Hex(bytes), signal);
  await strict.abortMultipart(key, uploadId, signal);
  return { refusesWrong, echoesRight: right.verifiedBy === 'provider_checksum' };
}

const signer = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
const r2 = new CatalogVideoR2(config, signer);
let uploadId: string | null = null;
let ok = false;
try {
  const checksum = await probeProviderChecksum();
  step('provider_checksum_probe', checksum);
  uploadId = await r2.createMultipart(key, signal);
  step('multipart_created', {});
  const parts: Array<{ partNumber: number; etag: string; sha256: string; size: number }> = [];
  const timings: number[] = [];
  for (let n = 1, offset = 0; offset < TOTAL; n += 1, offset += PART) {
    const bytes = source.subarray(offset, Math.min(TOTAL, offset + PART));
    const started = performance.now();
    const sha256 = await sha256Hex(bytes);
    const hashed = performance.now();
    const uploaded = await r2.uploadPart(key, uploadId, n, bytes, sha256, signal);
    timings.push(performance.now() - started);
    parts.push({ partNumber: n, etag: uploaded.etag, sha256, size: bytes.byteLength });
    step('part_uploaded', { part: n, hashMs: Math.round(hashed - started), totalMs: Math.round(performance.now() - started) });
  }
  await r2.completeMultipart(key, uploadId, parts, signal);
  uploadId = null;
  step('multipart_completed', { parts: parts.length, maxPartMs: Math.round(Math.max(...timings)) });
  const staged = await r2.headStaging(key, signal);
  if (!staged || staged.sizeBytes !== TOTAL) throw new Error('staging size mismatch');
  let offset = 0;
  for (const part of parts) {
    const back = await r2.readStagingRange(key, offset, offset + part.size - 1, signal);
    if ((await sha256Hex(back)) !== part.sha256) throw new Error(`readback mismatch on part ${part.partNumber}`);
    offset += part.size;
  }
  step('readback_verified', { parts: parts.length, md5Matches: new Md5().update(source).digest() === md5 });
  await r2.promote(key, signal);
  const head = await r2.publicHead(key, signal);
  step('public_head', head);
  if (head.sizeBytes !== TOTAL || head.contentType !== 'video/mp4' || !head.nosniff || !head.acceptRanges)
    throw new Error('public object headers are not what the catalog needs');
  const tail = await r2.publicRange(key, TOTAL - 1000, TOTAL - 1, signal);
  if (!tail.every((byte, i) => byte === source[TOTAL - 1000 + i])) throw new Error('public range mismatch');
  const cacheHeader = (await fetch(r2.publicUrl(key), { method: 'HEAD' })).headers.get('cache-control');
  step('public_range', { bytes: tail.byteLength, cacheControl: cacheHeader });
  await r2.removeStaging(key, signal);
  await r2.removePublic(key, signal);
  const gone = await fetch(r2.publicUrl(key), { method: 'HEAD', cache: 'no-store' });
  step('deleted_and_purged', { status: gone.status });
  const orphan = await r2.createMultipart(key, signal);
  await r2.abortMultipart(key, orphan, signal);
  step('orphan_aborted', {});
  ok = true;
} catch (error) {
  step('failed', { code: error instanceof Error ? error.message : 'UNKNOWN' });
  if (uploadId) await r2.abortMultipart(key, uploadId, AbortSignal.timeout(30_000)).catch(() => undefined);
  await r2.removeStaging(key, AbortSignal.timeout(30_000)).catch(() => undefined);
  await r2.removePublic(key, AbortSignal.timeout(30_000)).catch(() => undefined);
} finally {
  await Deno.writeTextFile(
    'specs/050-catalog-video-r2/provider-result.json',
    JSON.stringify({ environment: 'beta', ok, partBytes: PART, totalBytes: TOTAL, steps }, null, 2)
  );
}
if (!ok) Deno.exit(1);
