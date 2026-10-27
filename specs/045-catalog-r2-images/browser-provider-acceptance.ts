// Disposable browser-only CORS/expiry probe. Uses synthetic fixtures and staging only.
// Requires the same approved temporary .env as provider-acceptance.ts.
// Bind only loopback ports 5175 (allowed beta origin) and 5176 (denied origin).
// From the repository root (join the following argument lines):
// nice -n 15 npx --yes deno@2.5.6 run --no-lock --node-modules-dir=none
//   --allow-read=.env.catalog-images.beta,tests/fixtures/restitch-images,.env.catalog-images.beta-browser-recovery
//   --allow-net=127.0.0.1:5175,127.0.0.1:5176,d7c5658154bdbb4fb78abc8f624d0dc1.r2.cloudflarestorage.com
//   --allow-write=.env.catalog-images.beta-browser-recovery,specs/045-catalog-r2-images/browser-provider-result.json
//   specs/045-catalog-r2-images/browser-provider-acceptance.ts
// Visit 5175/, then 5176/, then 5175/?mode=expired in Chrome; run each sequentially.
// After all nine checks complete, use the Finish button to stop both owned listeners.
import { AwsClient } from 'npm:aws4fetch@1.0.20';
import {
  CatalogImageR2,
  readCatalogR2Config
} from '../../supabase/functions/_shared/r2-catalog-images.ts';
import { readCatalogImageBytes } from '../../supabase/functions/_shared/catalog-image-validation.ts';

const env = new Map(
  (await Deno.readTextFile('.env.catalog-images.beta'))
    .split(/\r?\n/u)
    .filter(line => /^[A-Z][A-Z0-9_]*=/u.test(line))
    .map(line => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)] as const;
    })
);
const config = readCatalogR2Config(key => env.get(key));
if (
  !config ||
  env.get('CATALOG_IMAGES_ENVIRONMENT') !== 'beta' ||
  config.accountId !== 'd7c5658154bdbb4fb78abc8f624d0dc1' ||
  config.publicOrigin !== 'https://catalog-images-beta.soty.pp.ua'
)
  throw new Error('Refusing non-beta target');
const accessKeyId = env.get('R2_CATALOG_ACCESS_KEY_ID');
const secretAccessKey = env.get('R2_CATALOG_SECRET_ACCESS_KEY');
if (!accessKeyId || !secretAccessKey) throw new Error('Missing temporary beta credentials');
const r2 = new CatalogImageR2(
  config,
  new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
);
const csrf = crypto.randomUUID();
const journal = '.env.catalog-images.beta-browser-recovery';
await Deno.mkdir(journal, { mode: 0o700 }); // Refuse rerun/concurrency while recovery is outstanding.
const owned = new Set<string>();
async function persist() {
  await Deno.writeTextFile(
    `${journal}/owned.json.tmp`,
    JSON.stringify({
      environment: 'beta',
      staging_bucket: config!.stagingBucket,
      owned_staging_keys: [...owned]
    }),
    { mode: 0o600 }
  );
  await Deno.rename(`${journal}/owned.json.tmp`, `${journal}/owned.json`);
}
await persist();
type Mode = 'allowed' | 'denied' | 'expired';
type Entry = {
  key: string;
  bytes: Uint8Array;
  mime: string;
  grantUrl?: string;
  expiresAt?: string;
};
const runs = new Map<string, { mode: Mode; entries: Entry[] }>();
const usedModes = new Set<Mode>();
const results: Array<{
  mode: Mode;
  mime: string;
  browser_expected: boolean;
  origin_expected: boolean;
  expiry_denied: boolean | null;
  outside_browser_control: boolean | null;
  cleanup: boolean;
  ok: boolean;
}> = [];
const deadline = () => AbortSignal.timeout(30_000);
const report = async () =>
  Deno.writeTextFile(
    'specs/045-catalog-r2-images/browser-provider-result.json',
    JSON.stringify(
      {
        scope: 'actual_chrome_staging_cors_and_expiry_only',
        generated_at: new Date().toISOString(),
        ok: results.length === 9 && results.every(result => result.ok),
        results,
        recovery_pending: owned.size > 0,
        not_proven: [
          'Soty authenticated import journey',
          'hosted gateway/cron/isolate',
          'Meta importer',
          'production readiness'
        ]
      },
      null,
      2
    ) + '\n'
  );

function page(mode: Mode) {
  return String.raw`<!doctype html><html lang="uk"><meta charset="utf-8"><title>R2 · Chrome ${mode}</title>
  <h1>R2: ${mode === 'allowed' ? 'дозволений origin' : mode === 'denied' ? 'заборонений origin' : 'прострочене посилання'}</h1>
  <p>Синтетичні PNG, JPEG і WebP. Лише окреме beta staging-сховище.</p>
  <button id="run">Перевірити R2 із Chrome</button><pre id="result">Готово до перевірки</pre>
  <button id="stop" hidden>Завершити перевірку</button>
  <script>
  const token=${JSON.stringify(csrf)}, mode=${JSON.stringify(mode)};
  const result=document.getElementById('result');
  async function post(path, body) {
    const response=await fetch(path,{method:'POST',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json','X-Probe-Token':token},body:JSON.stringify(body)});
    if(!response.ok) throw new Error('Локальний крок не завершився');
    return response.json();
  }
  document.getElementById('run').onclick=async()=>{
    document.getElementById('run').disabled=true;
    try {
      result.textContent='Готую тимчасові посилання…';
      const run=await post('/prepare',{mode});
      if(mode==='expired') { result.textContent='Очікую завершення строку посилання…'; await new Promise(resolve=>setTimeout(resolve,7000)); }
      const accepted=[];
      for(const entry of run.entries) {
        let ok=false;
        try {
          const bytes=Uint8Array.from(atob(entry.base64),c=>c.charCodeAt(0));
          const response=await fetch(entry.url,{method:'PUT',signal:AbortSignal.timeout(15000),headers:entry.headers,body:bytes});
          ok=response.ok;
        } catch { /* Browser CORS denial is expected for the denied origin. */ }
        accepted.push(ok);
      }
      const verdict=await post('/finish',{id:run.id,accepted});
      result.textContent=JSON.stringify(verdict,null,2);
      document.getElementById('stop').hidden=false;
    } catch { result.textContent='Перевірка не завершена. Див. локальний звіт та private recovery ledger.'; }
  };
  document.getElementById('stop').onclick=async()=>{ await post('/stop',{}); result.textContent+='\nСервер перевірки завершений.'; };
  </script></html>`;
}

const servers: Deno.HttpServer[] = [];
let mutationBusy = false;
async function boundedJson(request: Request) {
  const length = Number(request.headers.get('Content-Length'));
  if (!request.body || !Number.isSafeInteger(length) || length < 2 || length > 4096)
    throw new Error('Invalid probe request length');
  const reader = request.body.getReader();
  const bytes = new Uint8Array(length);
  let offset = 0;
  const timer = setTimeout(() => {
    void reader.cancel();
  }, 5000);
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (offset + next.value.length > length) {
        await reader.cancel();
        throw new Error('Oversized probe request');
      }
      bytes.set(next.value, offset);
      offset += next.value.length;
    }
    if (offset !== length) throw new Error('Incomplete probe request');
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
async function handler(request: Request) {
  const url = new URL(request.url);
  if (!['127.0.0.1:5175', '127.0.0.1:5176'].includes(url.host))
    return new Response(null, { status: 403 });
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (request.method === 'GET' && url.pathname === '/') {
    const mode: Mode =
      url.port === '5176'
        ? 'denied'
        : url.searchParams.get('mode') === 'expired'
          ? 'expired'
          : 'allowed';
    return new Response(page(mode), {
      headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
  if (
    request.method !== 'POST' ||
    request.headers.get('Origin') !== url.origin ||
    request.headers.get('X-Probe-Token') !== csrf
  )
    return new Response(null, { status: 403 });
  if (mutationBusy) return new Response(null, { status: 409 });
  mutationBusy = true; // One POST mutation at a time, including all ledger writes.
  try {
    const body = await boundedJson(request);
    if (url.pathname === '/prepare') {
      const mode: Mode = body.mode;
      if (
        !['allowed', 'denied', 'expired'].includes(mode) ||
        usedModes.has(mode) ||
        (mode === 'denied') !== (url.port === '5176')
      )
        return new Response(null, { status: 409 });
      usedModes.add(mode);
      const entries: Entry[] = [];
      const delivered = [];
      const id = crypto.randomUUID();
      runs.set(id, { mode, entries });
      for (const [fixture, mime] of [
        ['plain.png', 'image/png'],
        ['plain.jpg', 'image/jpeg'],
        ['plain.webp', 'image/webp']
      ]) {
        const key = crypto.randomUUID();
        const bytes = await Deno.readFile(`tests/fixtures/restitch-images/${fixture}`);
        const entry: Entry = { key, bytes, mime };
        entries.push(entry);
        owned.add(key);
        await persist(); // Record ownership before a grant can cause a provider write.
        const grant = await r2.stagingGrant(
          key,
          mime,
          new Date(Date.now() + (mode === 'expired' ? 5000 : 300_000)).toISOString(),
          1
        );
        entry.grantUrl = grant.url;
        entry.expiresAt = grant.expiresAt;
        delivered.push({
          url: grant.url,
          headers: grant.headers,
          base64: btoa(String.fromCharCode(...bytes))
        });
      }
      return Response.json({ id, entries: delivered }, { headers });
    }
    if (url.pathname === '/finish') {
      const run = runs.get(body.id);
      if (
        !run ||
        !Array.isArray(body.accepted) ||
        body.accepted.length !== run.entries.length ||
        !body.accepted.every((value: unknown) => typeof value === 'boolean') ||
        (run.mode === 'denied') !== (url.port === '5176')
      )
        return new Response(null, { status: 409 });
      runs.delete(body.id);
      const batch = [];
      for (let at = 0; at < run.entries.length; at += 1) {
        const entry = run.entries[at];
        let originExpected = false;
        let expiryDenied: boolean | null = run.mode === 'expired' ? false : null;
        let outsideControl: boolean | null = run.mode === 'denied' ? false : null;
        let cleaned = false;
        try {
          if (
            run.mode === 'expired' &&
            entry.grantUrl &&
            Date.now() > Date.parse(entry.expiresAt!)
          ) {
            const denied = await fetch(entry.grantUrl, {
              method: 'PUT',
              body: new Uint8Array(entry.bytes),
              headers: { 'Content-Type': entry.mime },
              signal: deadline()
            });
            expiryDenied = denied.status === 403;
            await denied.body?.cancel();
          }
          const response = await r2.get('staging', entry.key, deadline());
          if (run.mode === 'allowed' && response) {
            const actual = await readCatalogImageBytes(response, entry.bytes.length);
            originExpected =
              response.headers.get('content-type')?.split(';')[0] === entry.mime &&
              actual.length === entry.bytes.length &&
              actual.every((value, index) => value === entry.bytes[index]);
          } else {
            originExpected = response === null;
            await response?.body?.cancel();
          }
          if (
            run.mode === 'denied' &&
            originExpected &&
            entry.grantUrl &&
            Date.now() < Date.parse(entry.expiresAt!)
          ) {
            // Prove this exact grant/provider still works outside the denied browser origin.
            const control = await fetch(entry.grantUrl, {
              method: 'PUT',
              body: new Uint8Array(entry.bytes),
              headers: { 'Content-Type': entry.mime },
              signal: deadline()
            });
            const accepted = control.ok;
            await control.body?.cancel();
            const actual = accepted
              ? await r2.readStaging(entry.key, entry.bytes.length, deadline())
              : null;
            outsideControl =
              !!actual &&
              actual.length === entry.bytes.length &&
              actual.every((value, index) => value === entry.bytes[index]);
          }
        } catch {
          /* Unknown readback never passes. */
        }
        try {
          await r2.remove('staging', entry.key, deadline());
          owned.delete(entry.key);
          await persist();
          cleaned = true;
        } catch {
          /* Preserve ownership on uncertain cleanup. */ owned.add(entry.key);
        }
        const browserExpected = body.accepted[at] === (run.mode === 'allowed');
        const item = {
          mode: run.mode,
          mime: entry.mime,
          browser_expected: browserExpected,
          origin_expected: originExpected,
          expiry_denied: expiryDenied,
          outside_browser_control: outsideControl,
          cleanup: cleaned,
          ok:
            browserExpected &&
            originExpected &&
            cleaned &&
            expiryDenied !== false &&
            outsideControl !== false
        };
        results.push(item);
        batch.push(item);
      }
      await report();
      return Response.json(
        { ok: batch.every(item => item.ok), checks: batch.length, results: batch },
        { headers }
      );
    }
    if (url.pathname === '/stop') {
      if (runs.size || owned.size || results.length !== 9)
        return new Response(null, { status: 409 });
      await report();
      await Deno.remove(`${journal}/owned.json`);
      await Deno.remove(journal);
      setTimeout(() => {
        for (const server of servers) void server.shutdown();
      }, 100);
      return Response.json({ stopped: true }, { headers });
    }
  } catch {
    return Response.json({ ok: false, code: 'PROBE_INCOMPLETE' }, { status: 500, headers });
  } finally {
    mutationBusy = false;
  }
  return new Response(null, { status: 404 });
}
for (const port of [5175, 5176])
  servers.push(Deno.serve({ hostname: '127.0.0.1', port, onListen: () => {} }, handler));
console.log('Browser probe ready at http://127.0.0.1:5175/ and http://127.0.0.1:5176/');
await Promise.all(servers.map(server => server.finished));
