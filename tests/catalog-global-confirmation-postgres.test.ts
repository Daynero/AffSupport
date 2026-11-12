import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { assertDisposablePostgresContainer } from './support/disposable-postgres.js';
const container = process.env.SOTY_PROCESS_POSTGRES_CONTAINER;
const owner = randomUUID(),
  team = randomUUID(),
  image = randomUUID(),
  catalog = randomUUID(),
  intent = randomUUID();
const performanceImages = Array.from({ length: 2000 }, () => randomUUID()),
  performanceCatalogs: string[] = [];
async function sql(statement: string): Promise<string> {
  assertDisposablePostgresContainer(container);
  return new Promise((resolve, reject) => {
    const child = execFile(
      'docker',
      [
        'exec',
        '-i',
        container,
        'psql',
        '-X',
        '-qAt',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'supabase_admin',
        '-d',
        'postgres'
      ],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) =>
        error ? reject(new Error(stderr.slice(-1500))) : resolve(stdout.trim())
    );
    child.stdin!.end(statement);
  });
}
describe.skipIf(!container)(
  '052 concurrent issued bindings and once-only receipts [needs: disposable PostgreSQL]',
  () => {
    beforeAll(async () => {
      await sql(`begin;
   insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values('${owner}','authenticated','authenticated','${owner}@global.test.invalid','{}','{}');
   insert into public.admin_users(user_id) values('${owner}');
   insert into public.teams(id,name,owner_id) values('${team}','Synthetic global race','${owner}');
   insert into public.team_members(team_id,user_id,base_role) values('${team}','${owner}','admin');
   update private.catalog_global_policy set environment='beta',epoch=1,state='active',media_origin='https://global.test.invalid',routing_revision='fixture',serving_revision='fixture',serving_verified_at=clock_timestamp(),activated_at=now(),delete_after=now()+interval '720 hours';
   insert into private.catalog_global_images(id,environment,canonical_key,sha256,mime,size_bytes,width,height,classification,state,content_proof_revision,content_expires_at)
    values('${image}','beta','g1/${image}',repeat('d',64),'image/jpeg',1000,500,500,'{"mode":"unclassified","garment":null,"color":null,"reason":"unknown","vocabularyVersion":"catalog-clothing-v1"}','ready','fixture',clock_timestamp()+interval '24 hours');
   insert into private.catalog_global_aliases(image_id,generation,public_url,key_version,state,identity_revision,identity_verified_at)
    select '${image}',g,'https://global.test.invalid/g/fixture-'||g||'.jpg',1,'ready','fixture',clock_timestamp() from generate_series(1,3)g;
   commit;`);
    }, 30_000);
    afterAll(async () => {
      await sql(`begin;
  delete from private.catalog_global_recipes where catalog_id in(select id from private.catalog_global_identities where team_id='${team}') and catalog_id<>'${catalog}';
  delete from private.catalog_global_assignments where catalog_id in(select id from private.catalog_global_identities where team_id='${team}') and image_id<>'${image}';
  delete from private.catalog_global_aliases where image_id in(${performanceImages.map(id => `'${id}'`).join(',')});
  delete from private.catalog_global_images where id in(${performanceImages.map(id => `'${id}'`).join(',')});
  delete from private.catalog_global_use_receipts where assignment_id in(select id from private.catalog_global_assignments where image_id='${image}');
  delete from private.catalog_global_recipes where catalog_id='${catalog}';delete from private.catalog_global_assignments where image_id='${image}';
  delete from private.catalog_global_identities where team_id='${team}';delete from private.catalog_global_aliases where image_id='${image}';delete from private.catalog_global_images where id='${image}';
  delete from public.teams where id='${team}';delete from public.admin_users where user_id='${owner}';delete from auth.users where id='${owner}';
  alter table private.catalog_global_policy disable trigger catalog_global_policy_immutable;
  update private.catalog_global_policy set environment=null,epoch=0,state='prepared',media_origin=null,routing_revision='unconfigured',serving_revision=null,serving_verified_at=null,activated_at=null,delete_after=null;
  alter table private.catalog_global_policy enable trigger catalog_global_policy_immutable;commit;`);
    });
    it('serializes the same intent without burning a second slot, and confirmations never double count', async () => {
      const allocate = `select public.service_catalog_global_allocate('${owner}','${team}','${catalog}','${intent}',200,1);`;
      const outcomes = await Promise.allSettled([sql(allocate), sql(allocate)]);
      expect(outcomes.some(result => result.status === 'fulfilled')).toBe(true);
      await sql(allocate);
      expect(
        await sql(`select issued_seq::text from private.catalog_global_images where id='${image}'`)
      ).toBe('1');
      const confirm = `select public.service_catalog_global_confirm('${team}','${intent}','${intent}');`;
      await Promise.allSettled([sql(confirm), sql(confirm)]);
      await sql(confirm);
      expect(
        await sql(
          `select confirmed_uses::text from private.catalog_global_images where id='${image}'`
        )
      ).toBe('1');
      expect(
        await sql(
          `select count(*) from private.catalog_global_use_receipts r join private.catalog_global_assignments a on a.id=r.assignment_id where a.image_id='${image}'`
        )
      ).toBe('1');
    });
    it('measures warm100/200-row batches against2000 ready images without row-level network', async () => {
      await sql(`update private.catalog_global_images set active=false where id='${image}';
   insert into private.catalog_global_images(id,environment,canonical_key,sha256,mime,size_bytes,width,height,classification,state,content_proof_revision,content_expires_at)
    select v.id::uuid,'beta','g1/'||v.id,encode(sha256(convert_to(v.id,'UTF8')),'hex'),'image/jpeg',1000,500,500,'{"mode":"unclassified","garment":null,"color":null,"reason":"unknown","vocabularyVersion":"catalog-clothing-v1"}','ready','fixture',clock_timestamp()+interval '24 hours'
    from(values ${performanceImages.map(id => `('${id}')`).join(',')})v(id);
   insert into private.catalog_global_aliases(image_id,generation,public_url,key_version,state,identity_revision,identity_verified_at)
    select i.id,g,'https://global.test.invalid/g/fixture-'||i.id::text||'-'||g||'.jpg',1,'ready','fixture',clock_timestamp()
    from private.catalog_global_images i cross join generate_series(1,3)g where i.environment='beta' and i.active;`);
      const reports = [];
      const full = process.env.SOTY_GLOBAL_BENCHMARK_FULL === '1',
        targetSamples = full ? 100 : 15;
      for (const count of [100, 200])
        for (const concurrency of full ? [1, 10] : [1]) {
          const samples: number[] = [],
            failures: string[] = [];
          for (let offset = 0; offset < targetSamples + concurrency * 3; offset += concurrency) {
            const results = await Promise.allSettled(
              Array.from(
                { length: Math.min(concurrency, targetSamples + concurrency * 3 - offset) },
                async () => {
                  const c = randomUUID(),
                    attempt = randomUUID();
                  performanceCatalogs.push(c);
                  return Number(
                    await sql(
                      `with started as materialized(select clock_timestamp() baseline_time),allocated as materialized(select public.service_catalog_global_allocate('${owner}','${team}','${c}','${attempt}',${count},1) from started) select extract(epoch from clock_timestamp()-(select baseline_time from started))*1000 from allocated`
                    )
                  );
                }
              )
            );
            for (const result of results) {
              if (result.status === 'rejected')
                failures.push(
                  String(result.reason).match(/GLOBAL_IMAGE_[A-Z_]+/u)?.[0] ?? 'UNKNOWN'
                );
              else if (offset >= concurrency * 3) samples.push(result.value);
            }
          }
          samples.sort((a, b) => a - b);
          reports.push({
            rows: count,
            concurrency,
            samples: samples.length,
            failures: failures.length,
            failure_codes: [...new Set(failures)],
            p50_ms: samples[Math.floor(samples.length * 0.5)] ?? null,
            p95_ms: samples[Math.ceil(samples.length * 0.95) - 1] ?? null,
            p99_ms: samples[Math.ceil(samples.length * 0.99) - 1] ?? null,
            maximum_ms: samples.at(-1) ?? null,
            calls_per_catalog: 1,
            scope: 'database_fresh_atomic_recipe'
          });
        }
      const artifact =
        process.env.SOTY_GLOBAL_BENCHMARK_REPORT ??
        path.join(tmpdir(), `soty-052-allocation-${container}.json`);
      writeFileSync(
        artifact,
        JSON.stringify(
          {
            schema: 1,
            fixture_images: 2000,
            source_digest: createHash('sha256')
              .update(readFileSync('supabase/migrations/20261208100000_catalog_global_pool.sql'))
              .digest('hex'),
            reports,
            network_latency: 'unmeasured',
            end_to_end_catalog_creation: 'unmeasured'
          },
          null,
          2
        )
      );
      console.info(`Global allocation benchmark: ${artifact}`);
      expect(
        reports.every(
          report =>
            report.failures === 0 &&
            report.samples >= targetSamples &&
            report.p95_ms !== null &&
            report.p95_ms <= 250
        )
      ).toBe(true);
    }, 120_000);
  }
);
