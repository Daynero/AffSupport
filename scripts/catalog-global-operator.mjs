#!/usr/bin/env node
import { classifyCatalogImageName } from '../packages/shared/dist/team/catalog-images.js';
/**052 Operator writes are explicitly targeted. Owner status uses analytics, never this credential.*/
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withCatalogGlobalCapacity } from './lib/catalog-global-capacity.mjs';
const args = process.argv.slice(2),
  command = args.shift();
const value = name => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const target = process.env.CATALOG_GLOBAL_OPERATOR_URL,
  token = process.env.CATALOG_GLOBAL_OPERATOR_TOKEN,
  environment = process.env.CATALOG_IMAGES_ENVIRONMENT;
let activeJobId = null;
async function control(action, payload, timeoutMs = 15_000) {
  const response = await fetch(`${target}/control`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action, payload }),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    const code = result?.error?.code;
    throw new Error(
      typeof code === 'string' && /^[A-Z_0-9]{1,96}$/u.test(code)
        ? code
        : 'GLOBAL_OPERATOR_REQUEST_FAILED'
    );
  }
  return result.value;
}
try {
  if (!['dev', 'beta'].includes(environment ?? '') || !target || !token || token.length < 16)
    throw new Error(
      'An isolated dev or beta target and an authenticated operator token are required'
    );
  const url = new URL(target);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith('/functions/v1/catalog-global-images')
  )
    throw new Error('Invalid isolated operator endpoint');
  if (process.env.CATALOG_GLOBAL_OPERATOR_CONFIRMATION !== `${environment}:${url.origin}`)
    throw new Error('Exact isolated target confirmation is required');
  if (command === 'import') {
    const directory = path.resolve(value('--directory') ?? ''),
      key = value('--key');
    if (!key || key.length < 8 || !value('--directory'))
      throw new Error('Use import --directory PATH --key STABLE_REQUEST_KEY');
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter(file => file.isFile() && /\.(?:jpe?g|png|webp)$/iu.test(file.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!files.length || files.length > 1000) throw new Error('Expected1..1000 images');
    const manifest = [];
    let totalBytes = 0;
    for (const file of files) {
      const size = (await stat(path.join(directory, file.name))).size;
      if (size < 1 || size > 50_000_000) throw new Error('Image source exceeds bounds');
      totalBytes += size;
      manifest.push({
        fileKey: createHash('sha256').update(file.name).digest('hex'),
        displayName: file.name,
        size,
        mime: /\.png$/iu.test(file.name)
          ? 'image/png'
          : /\.webp$/iu.test(file.name)
            ? 'image/webp'
            : 'image/jpeg',
        classification: classifyCatalogImageName(file.name)
      });
    }
    if (totalBytes > 5_000_000_000) throw new Error('Batch exceeds bounds');
    const job = await control('begin', {
      idempotencyKey: key,
      totalFiles: manifest.length,
      totalBytes: String(totalBytes)
    });
    activeJobId = job.id;
    if (job.state === 'collecting') {
      for (let n = 0; n < manifest.length; n += 100)
        await control('manifest', {
          jobId: job.id,
          pageKey: `page-${n / 100}`,
          entries: manifest.slice(n, n + 100)
        });
      await control('seal', { jobId: job.id });
    }
    let cursor = null,
      uploaded = 0;
    do {
      const page = await control('get', { jobId: job.id, cursor });
      for (const entry of page.entries) {
        if (entry.state !== 'waiting_source') continue;
        const file = manifest.find(item => item.fileKey === entry.fileKey);
        if (!file) throw new Error('Local source no longer matches the durable manifest');
        const grant = await withCatalogGlobalCapacity(timeoutMs =>
          control(
            'grant',
            {
              jobId: job.id,
              entryId: entry.id,
              requestKey: `${key}:${entry.id}`
            },
            timeoutMs
          )
        );
        const response = await fetch(grant.url, {
          method: 'PUT',
          headers: grant.headers,
          body: new Uint8Array(await readFile(path.join(directory, file.displayName))),
          redirect: 'error',
          signal: AbortSignal.timeout(60_000)
        });
        if (!response.ok) throw new Error('IMAGE_WRITE_UNCERTAIN');
        await response.body?.cancel();
        await control('delivered', { jobId: job.id, entryId: entry.id });
        uploaded++;
      }
      cursor = page.hasMore ? page.nextCursor : null;
    } while (cursor);
    process.stdout.write(
      JSON.stringify({
        ok: true,
        jobId: job.id,
        uploaded,
        note: 'Transfer is a hint. Background canonical and public readback must still confirm readiness.'
      }) + '\n'
    );
  } else if (
    [
      'configure',
      'prepare',
      'resume_legacy',
      'activate',
      'cancel',
      'retry',
      'get',
      'status'
    ].includes(command ?? '')
  ) {
    const payloadFile = value('--payload');
    const payload = payloadFile
      ? JSON.parse(await readFile(path.resolve(payloadFile), 'utf8'))
      : {};
    const result = await control(command, payload);
    process.stdout.write(JSON.stringify({ ok: true, data: result }) + '\n');
  } else
    throw new Error(
      'Use configure|import|prepare|resume_legacy|activate|cancel|retry|get|status. Regular pool reports: npm run analytics -- global-images --json'
    );
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      ok: false,
      jobId: activeJobId,
      error:
        error instanceof Error && /^[A-Za-z0-9 ._:|<>?=+-]{1,240}$/u.test(error.message)
          ? error.message
          : 'Global operator operation failed; reconcile the same durable request before retry'
    }) + '\n'
  );
  process.exitCode = 1;
}
