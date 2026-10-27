import { assertDisposablePostgresContainer } from './support/disposable-postgres';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { waitFor } from './support/wait.js';

// Only the acceptance runner's disposable clone, never a beta/source database.
const container = process.env.SOTY_PROCESS_POSTGRES_CONTAINER;
const owner = randomUUID(),
  team = randomUUID();
async function sql(statement: string): Promise<string> {
  assertDisposablePostgresContainer(container);
  const child = execFile(
    'docker',
    [
      'exec',
      '-i',
      container!,
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
    { timeout: 15000, maxBuffer: 1024 * 1024 }
  );
  const result = new Promise<string>((resolve, reject) => {
    let output = '',
      error = '';
    child.stdout!.on('data', chunk => {
      output += String(chunk);
    });
    child.stderr!.on('data', chunk => {
      error = (error + String(chunk)).slice(-2000);
    });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(output.trim()) : reject(new Error(error))));
  });
  child.stdin!.end(statement);
  return result;
}
async function held(marker: string, event = 'PgSleep') {
  await waitFor(
    async () =>
      (await sql(`select count(*) from pg_stat_activity where datname=current_database()
    and pid<>pg_backend_pid() and query like '%${marker}%' and ${event === 'Lock' ? "wait_event_type='Lock'" : "wait_event='PgSleep'"}`)) ===
      '1',
    { timeoutMs: 5000, intervalMs: 30, describe: `isolated transaction ${marker} ${event}` }
  );
}

const classification = JSON.stringify({
  mode: 'unclassified',
  garment: null,
  color: null,
  vocabularyVersion: 'catalog-clothing-v1',
  reason: 'unknown'
});
async function candidate() {
  const job = randomUUID(),
    entry = randomUUID(),
    publication = randomUUID(),
    purge = randomUUID();
  await sql(`begin;
    insert into public.team_catalog_image_imports(id,team_id,actor_id,actor_scope,source_kind,state)
      values('${job}','${team}','${owner}','${owner}','local','sealed');
    insert into private.catalog_image_import_intents(job_id,team_id,actor_scope,intent_key,request_digest,enumeration_complete)
      values('${job}','${team}','${owner}','${job}','synthetic',true);
    insert into private.catalog_image_import_entries(id,job_id,team_id,client_file_key,display_name,declared_size,declared_mime,classification,state,fence,lease_owner)
      values('${entry}','${job}','${team}','${entry}','IMG_TEST.png',3,'image/png','${classification}','failed',1,'race-worker');
    insert into private.catalog_image_publications(id,team_id,sha256,size_bytes,mime,width,height,classification,owner_entry_id)
      values('${publication}','${team}',replace('${publication}','-','')||replace('${publication}','-',''),3,'image/png',1,1,'${classification}','${entry}');
    update private.catalog_image_import_entries set candidate_publication_id='${publication}' where id='${entry}';
    insert into private.catalog_image_purges(id,publication_id,scope_id,bucket_kind,object_key,reason,not_before)
      select '${purge}',id,team_id,'public',object_key,'orphan_candidate',clock_timestamp()-interval '1 day'
      from private.catalog_image_publications where id='${publication}';commit;`);
  const acquire = `update private.catalog_image_import_entries set state='awaiting_reconciliation',lease_until=clock_timestamp()+interval '90 seconds' where id='${entry}';`;
  const adopt = `select public.service_catalog_image_candidate_v2('${entry}','race-worker',1)`;
  return { job, entry, publication, purge, acquire, adopt };
}

describe.skipIf(!container)(
  '045 publication adoption [needs: disposable PostgreSQL container]',
  () => {
    beforeAll(async () => {
      await sql(`begin;
      insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
        values('${owner}','authenticated','authenticated','${owner}@r2-race.test.invalid','{}','{}');
      insert into public.admin_users(user_id) values('${owner}');
      insert into public.teams(id,name,owner_id) values('${team}','Synthetic R2 race','${owner}');
      insert into public.team_members(team_id,user_id,base_role) values('${team}','${owner}','admin');
      insert into private.catalog_image_config(team_id,import_enabled) values('${team}',true);commit;`);
    });

    it('cleanup-first locks the publication and rejects later adoption without a stale-fence commit', async () => {
      const f = await candidate();
      const first = sql(
        `begin;select public.service_catalog_image_purge_claim_v2();select pg_sleep(2) /* r2_cleanup_hold */;commit;`
      );
      await held('r2_cleanup_hold');
      const second = sql(`begin;${f.acquire}${f.adopt} /* r2_adoption_wait */;commit;`).then(
        () => 'ADOPTED',
        error => String(error)
      );
      await held('r2_adoption_wait', 'Lock');
      await first;
      expect(await second).toContain('IMAGE_PUBLICATION_REVOKED');
      expect(
        await sql(
          `select state||':'||fence from private.catalog_image_publications where id='${f.publication}'`
        )
      ).toBe('purging:2');
      await expect(
        sql(`select public.service_catalog_image_purge_finish_v2('${f.purge}',0,true)`)
      ).rejects.toThrow('LEASE_MISMATCH');
      expect(
        await sql(`select state from private.catalog_image_purges where id='${f.purge}'`)
      ).toBe('deleting');
      await sql(`select public.service_catalog_image_purge_finish_v2('${f.purge}',1,true)`);
    }, 15000);

    it('adoption-first holds the same publication lock and prevents a waiting orphan reservation', async () => {
      const f = await candidate();
      const first = sql(
        `begin;${f.acquire}${f.adopt};select pg_sleep(2) /* r2_adoption_hold */;commit;`
      );
      await held('r2_adoption_hold');
      const second = sql(
        `select public.service_catalog_image_purge_claim_v2() /* r2_cleanup_wait */;`
      );
      await held('r2_cleanup_wait', 'Lock');
      await first;
      expect(await second).toBe('');
      expect(
        await sql(
          `select state||':'||fence from private.catalog_image_publications where id='${f.publication}'`
        )
      ).toBe('candidate:2');
      expect(
        await sql(
          `select state||':'||attempts from private.catalog_image_purges where id='${f.purge}'`
        )
      ).toBe('pending:0');
      await sql(
        `select public.service_catalog_image_publication_v2('${f.entry}','race-worker',1,'${f.publication}',2,'public_verified')`
      );
      const commit = (fence: number) =>
        `select public.service_catalog_image_commit_v2('${f.entry}','race-worker',1,'${f.publication}',${fence},(select 'https://media.test/'||object_key from private.catalog_image_publications where id='${f.publication}'))`;
      // The former publication fence cannot commit, despite a still-current entry lease.
      await expect(sql(commit(1))).rejects.toThrow('PERMISSION_DENIED');
      await sql(commit(2));
      expect(await sql('select public.service_catalog_image_purge_claim_v2()')).toBe('');
      expect(
        await sql(
          `select state from private.catalog_image_publications where id='${f.publication}'`
        )
      ).toBe('ready');
      expect(
        await sql(`select state from private.catalog_image_purges where id='${f.purge}'`)
      ).toBe('complete');
    }, 15000);

    it('retains candidates referenced by historical unknown uses and ready publications without pool membership', async () => {
      const used = await candidate();
      await sql(`insert into private.catalog_image_uses(team_id,publication_id,catalog_attempt_id,row_identity,state)
      values('${team}','${used.publication}',gen_random_uuid(),'create:1','unknown');`);
      expect(await sql('select public.service_catalog_image_purge_claim_v2()')).toBe('');
      expect(
        await sql(
          `select state from private.catalog_image_publications where id='${used.publication}'`
        )
      ).toBe('candidate');
      await sql(
        `update private.catalog_image_purges set not_before='infinity' where id='${used.purge}'`
      );
      const ready = await candidate();
      await sql(
        `update private.catalog_image_publications set state='ready',public_url='https://media.test/'||object_key where id='${ready.publication}'`
      );
      expect(await sql('select public.service_catalog_image_purge_claim_v2()')).toBe('');
      expect(
        await sql(
          `select state from private.catalog_image_publications where id='${ready.publication}'`
        )
      ).toBe('ready');
      expect(
        await sql(`select state from private.catalog_image_purges where id='${ready.purge}'`)
      ).toBe('complete');
    });

    it('keeps team publication URLs, pool membership and uses after source and uploader deletion', async () => {
      const f = await candidate();
      const uploader = randomUUID(),
        credential = randomUUID(),
        connection = randomUUID(),
        source = randomUUID(),
        attempt = randomUUID();
      await sql(`begin;
      insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
        values('${uploader}','authenticated','authenticated','${uploader}@r2-retention.test.invalid','{}','{}');
      insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope)
        values('${credential}','${uploader}','${uploader}','${uploader}@r2-retention.test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
      insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
        values('${connection}','${team}','${credential}','retention-root','Synthetic','my_drive','connected',now());
      insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,mime_type)
        values('${source}','${team}','${connection}','${source}','original.png','file','image/png');
      update public.team_catalog_image_imports set actor_id='${uploader}',actor_scope='${uploader}',source_kind='drive',state='completed' where id='${f.job}';
      update private.catalog_image_import_intents set actor_scope='${uploader}',sources=jsonb_build_array('${source}'::text) where job_id='${f.job}';
      update private.catalog_image_import_entries set source=jsonb_build_object('rootMaterialId','${source}','credentialId','${credential}'),state='ready',publication_id='${f.publication}' where id='${f.entry}';
      update private.catalog_image_publications set state='ready',public_url='https://media.test/'||object_key,owner_entry_id=null where id='${f.publication}';
      insert into public.team_catalog_image_pool_entries(team_id,publication_id,public_url,classification)
        select team_id,id,public_url,classification from private.catalog_image_publications where id='${f.publication}';
      insert into private.catalog_image_uses(team_id,publication_id,catalog_attempt_id,row_identity,state)
        values('${team}','${f.publication}','${attempt}','create:1','committed');commit;`);
      const before = await sql(
        `select object_key||':'||public_url from private.catalog_image_publications where id='${f.publication}'`
      );
      await sql(
        `delete from public.team_materials where id='${source}';delete from auth.users where id='${uploader}';`
      );
      expect(
        await sql(
          `select object_key||':'||public_url from private.catalog_image_publications where id='${f.publication}' and state='ready'`
        )
      ).toBe(before);
      expect(
        await sql(
          `select count(*) from public.team_catalog_image_pool_entries where publication_id='${f.publication}' and active`
        )
      ).toBe('1');
      expect(
        await sql(
          `select state from private.catalog_image_uses where catalog_attempt_id='${attempt}'`
        )
      ).toBe('committed');
      expect(
        await sql(
          `select actor_id is null from public.team_catalog_image_imports where id='${f.job}'`
        )
      ).toBe('t');
      expect(await sql(`select count(*) from public.team_materials where id='${source}'`)).toBe(
        '0'
      );
    });
  }
);
