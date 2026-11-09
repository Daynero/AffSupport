import { beforeAll, afterAll, it, expect } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
let db: TeamTestDb, team: string, source: string, connection: string;
const owner = 'c1800000-0000-4000-8000-000000000001';
const defaults = {
  configured: true,
  operation: 'restitch',
  sourceMode: 'drive',
  fitMode: 'cover',
  startDurationMode: 'one-frame',
  customStartDurationMs: 1,
  startEnabled: false,
  endEnabled: true,
  finalDurationMode: 'custom',
  customFinalDurationSeconds: 3
};
beforeAll(async () => {
  db = await createTeamTestDb({
    throughMigration: '20261207181000_catalog_video_cancellation_settlement.sql'
  });
  await createUser(db, { id: owner, email: 'foreground@synthetic.invalid' });
  await db.root('insert into public.admin_users(user_id)values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Foreground')")
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope)values($1,'foreground','foreground@synthetic.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file')returning id",
      [owner]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)values($1,$2,'root','Root','my_drive','connected')returning id",
      [team, credential]
    )
  )[0]!.id;
  source = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)values($1,$2,'source','root','Source.mp4','file','video','video/mp4',4,repeat('a',32),'1')returning id",
      [team, connection]
    )
  )[0]!.id;
  const image = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)values($1,$2,'image','root','Image.png','file','image','image/png',4,repeat('b',32),'1')returning id",
      [team, connection]
    )
  )[0]!.id;
  await db.root(
    "insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by)values($1,'end',$2,'file',1,$3)",
    [team, image, owner]
  );
}, 180000);
afterAll(async () => {
  await db?.close();
});
async function prepared() {
  const enrollment = crypto.randomUUID(),
    native = crypto.randomUUID(),
    session = crypto.randomUUID(),
    key = 'fg:' + crypto.randomUUID(),
    set = crypto.randomUUID(),
    proof = Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
    token = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  await db.root('insert into auth.sessions(id,user_id)values($1,$2)', [session, owner]);
  await db.root(
    'select public.service_prepare_catalog_video_foreground($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [team, owner, session, source, 'create', key, null, enrollment, native, proof, token]
  );
  return { enrollment, native, session, key, set, proof, token };
}
async function bound(f: Awaited<ReturnType<typeof prepared>>, n = 2) {
  const payload = {
    catalogVideoProtocolVersion: 1,
    foregroundExecutor: {
      protocolVersion: 1,
      enrollmentId: f.enrollment,
      nativeInstanceId: f.native,
      proofDigest: '01'.repeat(32)
    }
  };
  const intent = (
    await db.root<{ v: { id: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6)v',
      [team, source, owner, f.key, payload, f.enrollment]
    )
  )[0]!.v.id;
  const children = Array.from({ length: n }, (_, index) => ({
    index,
    requestId: crypto.randomUUID()
  }));
  await db.root('select public.service_accept_foreground_catalog_video_set($1,$2,$3,$4,$5,$6)', [
    team,
    owner,
    f.enrollment,
    {
      setId: f.set,
      catalogIntentId: intent,
      sourceMaterialId: source,
      sourceVersion: '1',
      settings: defaults,
      settingsDigest: 'a'.repeat(64),
      requestedCount: n,
      productCount: n,
      recipeRevision: 1,
      seed: 'b'.repeat(64)
    },
    children,
    children.map(c => ({ recipeRowId: crypto.randomUUID(), videoVariantIndex: c.index }))
  ]);
  await db.root(
    "update private.catalog_generation_intents set checkpoint=checkpoint||jsonb_build_object('initialVideoPlan',jsonb_build_object('setId',$2::text))where id=$1",
    [intent, f.set]
  );
  return { ...f, intent, children };
}
it('creates prepared metadata without delegation and never yields a ticket or native IO before binding', async () => {
  const f = await prepared();
  const pending = (
    await db.root<{ v: Record<string, unknown> }>(
      'select public.service_await_catalog_video_foreground($1,$2,$3)v',
      [f.enrollment, f.native, f.proof]
    )
  )[0]!.v;
  expect(pending.state).toBe('pending');
  expect(pending).not.toHaveProperty('ticket');
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from private.team_recovery_delegations'
      )
    )[0]!.n
  ).toBe(0);
  await expect(
    db.root('select public.service_redeem_catalog_video_foreground($1,$2,$3,$4)', [
      f.set,
      f.enrollment,
      f.native,
      f.proof
    ])
  ).rejects.toThrow('AUTH_REQUIRED');
});
it('binds accepted set and redeems exact proof; wrong audience/proof/native cannot claim it', async () => {
  const f = await bound(await prepared());
  await expect(
    db.root('select public.service_redeem_catalog_video_foreground($1,$2,$3,$4)', [
      f.set,
      f.enrollment,
      f.native,
      Buffer.alloc(32, 9)
    ])
  ).rejects.toThrow('AUTH_REQUIRED');
  const grant = (
    await db.root<{ v: Record<string, unknown> }>(
      'select public.service_redeem_catalog_video_foreground($1,$2,$3,$4)v',
      [f.set, f.enrollment, f.native, f.proof]
    )
  )[0]!.v;
  expect(grant).toMatchObject({ setId: f.set, enrollmentId: f.enrollment, requestKey: f.key });
  expect(
    (
      await db.root<{ v: Record<string, unknown> }>(
        'select public.service_authorize_catalog_video_executor($1,$2,$3,1)v',
        [f.set, f.token, f.native]
      )
    )[0]!.v.executorId
  ).toBe(f.enrollment);
  await expect(
    db.root("select public.service_require_catalog_video_audience($1,$2,'recovery')", [
      f.set,
      f.token
    ])
  ).rejects.toThrow('AUTH_REQUIRED');
  await expect(
    db.root('select public.service_authorize_catalog_video_executor($1,$2,$3,1)', [
      f.set,
      f.token,
      crypto.randomUUID()
    ])
  ).rejects.toThrow('AUTH_REQUIRED');
});
it('logout blocks NEW work but retains original proof metadata and does not fabricate failure', async () => {
  const f = await bound(await prepared());
  await db.root('select public.service_redeem_catalog_video_foreground($1,$2,$3,$4)', [
    f.set,
    f.enrollment,
    f.native,
    f.proof
  ]);
  await db.root('delete from auth.sessions where id=$1', [f.session]);
  await expect(
    db.root('select public.service_authorize_catalog_video_executor($1,$2,$3,1)', [
      f.set,
      f.token,
      f.native
    ])
  ).rejects.toThrow('AUTH_REQUIRED');
  const state = (
    await db.root<{ state: string; session_valid: boolean }>(
      'select state,session_valid from public.analytics_catalog_video_session_authorities where authority_id=$1',
      [f.enrollment]
    )
  )[0]!;
  expect(state).toEqual({ state: 'session_revoked', session_valid: false });
  expect(
    (
      await db.root<{ state: string }>('select state from private.catalog_video_sets where id=$1', [
        f.set
      ])
    )[0]!.state
  ).toBe('accepted');
});
it('allows explicit quiescent queued suffix boot rotation and refuses active/unknown takeover', async () => {
  const f = await bound(await prepared());
  await db.root('select public.service_redeem_catalog_video_foreground($1,$2,$3,$4)', [
    f.set,
    f.enrollment,
    f.native,
    f.proof
  ]);
  const next = crypto.randomUUID();
  const rotated = (
    await db.root<{ v: Record<string, unknown> }>(
      'select public.service_redeem_catalog_video_foreground($1,$2,$3,$4,$5)v',
      [f.set, f.enrollment, f.native, f.proof, next]
    )
  )[0]!.v;
  expect(rotated.nativeInstanceId).toBe(f.native);
  expect(rotated.executionNativeInstanceId).toBe(next);
  await db.root(
    "update private.catalog_video_variants set state='unknown'where video_set_id=$1 and video_variant_index=0",
    [f.set]
  );
  await expect(
    db.root('select public.service_redeem_catalog_video_foreground($1,$2,$3,$4,$5,$6)', [
      f.set,
      f.enrollment,
      f.native,
      f.proof,
      crypto.randomUUID(),
      next
    ])
  ).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
});
it('exposes only safe diagnostics and rejects browser/raw service table access', async () => {
  expect(
    (
      await db.root<{ allowed: boolean }>(
        "select has_table_privilege('service_role','private.catalog_video_foreground_authorities','select')allowed"
      )
    )[0]!.allowed
  ).toBe(false);
  expect(
    (
      await db.root<{ allowed: boolean }>(
        "select has_function_privilege('authenticated','public.service_prepare_catalog_video_foreground(uuid,uuid,uuid,uuid,text,text,text,uuid,uuid,bytea,bytea)','execute')allowed"
      )
    )[0]!.allowed
  ).toBe(false);
  const fields = (
    await db.root<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name='analytics_catalog_video_session_authorities'"
    )
  ).map(r => r.column_name);
  expect(fields).not.toEqual(
    expect.arrayContaining(['token_hash', 'proof_hash', 'session_id', 'original_key'])
  );
});
it('keeps preparation retry identical and authoritative unused retirement fences delayed admission', async () => {
  const f = await prepared();
  await db.root(
    'select public.service_prepare_catalog_video_foreground($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [
      team,
      owner,
      f.session,
      source,
      'create',
      f.key,
      null,
      f.enrollment,
      f.native,
      f.proof,
      f.token
    ]
  );
  await db.root('select public.service_retire_unused_catalog_video_foreground($1,$2,$3)', [
    f.enrollment,
    team,
    owner
  ]);
  expect(
    (
      await db.root<{ v: { state: string } }>(
        'select public.service_await_catalog_video_foreground($1,$2,$3)v',
        [f.enrollment, f.native, f.proof]
      )
    )[0]!.v
  ).toEqual({ state: 'unused', enrollmentId: f.enrollment });
  await expect(bound(f)).rejects.toThrow('AUTH_REQUIRED');
  expect(
    (
      await db.root<{ state: string; safe_error_code: string }>(
        'select state,safe_error_code from public.analytics_catalog_video_session_authorities where authority_id=$1',
        [f.enrollment]
      )
    )[0]
  ).toMatchObject({ state: 'canceled', safe_error_code: 'ALREADY_COMPLETED' });
});
it('logout forbids new dispatch yet permits exact original already-dispatched no-upload metadata closure', async () => {
  const f = await bound(await prepared());
  await db.root('select public.service_redeem_catalog_video_foreground($1,$2,$3,$4)', [
    f.set,
    f.enrollment,
    f.native,
    f.proof
  ]);
  const op = crypto.randomUUID(),
    child = f.children[0]!;
  await db.root(
    "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)values($1,$2,$3,'process','running',$4,$5,$5)",
    [op, team, owner, source, 'catalog-variant:' + child.requestId]
  );
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version,expected_source_drive_file_id,expected_source_checksum,expected_name,expected_size,mime_type)values($1,$2,'restitch','1','source',repeat('a',32),'copy.mp4',4,'video/mp4')",
    [op, team]
  );
  const revision = (
    await db.root<{ revision: number }>(
      'select revision from private.catalog_video_sets where id=$1',
      [f.set]
    )
  )[0]!.revision;
  await db.root('select public.service_checkpoint_catalog_video_set($1,$2,$3,$4,1,$5,$6)', [
    f.set,
    team,
    owner,
    f.enrollment,
    revision,
    f.children.map((c, index) => ({
      ...c,
      operationId: index === 0 ? op : null,
      state: index === 0 ? 'working' : 'queued',
      outputId: null
    }))
  ]);
  await db.root('select public.service_dispatch_catalog_video_variant($1,$2,$3,1,0,$4,$5)', [
    f.set,
    f.token,
    f.native,
    child.requestId,
    op
  ]);
  await db.root('delete from auth.sessions where id=$1', [f.session]);
  await expect(
    db.root('select public.service_dispatch_catalog_video_variant($1,$2,$3,1,0,$4,$5)', [
      f.set,
      f.token,
      f.native,
      child.requestId,
      op
    ])
  ).rejects.toThrow('AUTH_REQUIRED');
  const closed = (
    await db.root<{ v: { kind: string; state: string } }>(
      "select public.service_complete_catalog_video_variant($1,$2,$3,1,0,$4,$5,'failed','PROCESS_FAILED')v",
      [f.set, f.token, f.native, child.requestId, op]
    )
  )[0]!.v;
  expect(closed).toMatchObject({ kind: 'terminal', state: 'failed' });
  await expect(
    db.root(
      "select public.service_complete_catalog_video_variant($1,$2,$3,1,0,$4,$5,'failed','PROCESS_FAILED')",
      [f.set, Buffer.alloc(32, 42), f.native, child.requestId, op]
    )
  ).rejects.toThrow('PERMISSION_DENIED');
});
it('uses real browser-session process alias and protected image range, then fences logout while retaining exact closure', async () => {
  const { createScreenSelectionBudget, selectScreenCandidate, reserveScreenTransfer } =
    await import('../packages/shared/src/team/restitch-selection');
  const f = await bound(await prepared());
  await db.root('select public.service_redeem_catalog_video_foreground($1,$2,$3,$4)', [
    f.set,
    f.enrollment,
    f.native,
    f.proof
  ]);
  const op = crypto.randomUUID(),
    child = f.children[0]!;
  await db.root(
    "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)values($1,$2,$3,'process','running',$4,$5,$5)",
    [op, team, owner, source, 'catalog-variant:' + child.requestId]
  );
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version,expected_source_drive_file_id,expected_source_checksum,expected_name,expected_size,mime_type)values($1,$2,'restitch','1','source',repeat('a',32),'copy.mp4',4,'video/mp4')",
    [op, team]
  );
  const revision = (
    await db.root<{ revision: number }>(
      'select revision from private.catalog_video_sets where id=$1',
      [f.set]
    )
  )[0]!.revision;
  await db.root('select public.service_checkpoint_catalog_video_set($1,$2,$3,$4,1,$5,$6)', [
    f.set,
    team,
    owner,
    f.enrollment,
    revision,
    f.children.map((c, index) => ({
      ...c,
      operationId: index === 0 ? op : null,
      state: index === 0 ? 'working' : 'queued',
      outputId: null
    }))
  ]);
  const args = [f.set, f.token, f.native, 1, 0, child.requestId, op];
  await db.root('select public.service_dispatch_catalog_video_variant($1,$2,$3,$4,$5,$6,$7)', args);
  await db.root(
    'select public.service_accept_catalog_video_restitch_alias($1,$2,$3,$4,$5,$6,$7)',
    args
  );
  const control = crypto.randomUUID(),
    proof = Buffer.alloc(32, 31),
    ticket = Buffer.alloc(32, 32),
    claim = crypto.randomUUID();
  await db.root(
    'select public.service_issue_catalog_video_restitch_control($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10)',
    [...args, control, proof, ticket]
  );
  expect(
    (
      await db.root<{ auth_mode: string; session_id: string }>(
        'select auth_mode,session_id from private.restitch_native_controls where id=$1',
        [control]
      )
    )[0]
  ).toEqual({ auth_mode: 'catalog_browser_session', session_id: f.session });
  await db.root('select public.service_redeem_restitch_native_control($1,$2)', [control, proof]);
  const owned = (
    await db.root<{ v: { executorId: string; epoch: number } }>(
      'select public.service_claim_restitch_native_control($1,$2,$3,1)v',
      [control, ticket, claim]
    )
  )[0]!.v;
  const version = (
    await db.root<{ version_id: string }>(
      "select version_id from private.restitch_selection_candidates where root_operation_id=$1 and slot='end'order by ordinal limit 1",
      [op]
    )
  )[0]!.version_id;
  const empty = createScreenSelectionBudget(),
    selected = selectScreenCandidate(empty, version, 4),
    request = crypto.randomUUID(),
    reserved = reserveScreenTransfer(selected, version, request, 0).state,
    range = crypto.randomUUID(),
    rangeHash = Buffer.alloc(32, 33),
    dispatch = crypto.randomUUID();
  await db.root(
    "select public.service_cas_restitch_selection_slot_owned($1,$2,$3,'end',$4,$5,$6,$7)",
    [op, team, owner, empty, selected, owned.executorId, owned.epoch]
  );
  await db.root(
    "select public.service_issue_restitch_control_screen_range($1,$2,'end',$3,0,$4,$5,$6,$7,$8)",
    [control, ticket, version, request, selected, reserved, range, rangeHash]
  );
  await db.root(
    "select public.service_consume_restitch_control_screen_range($1,$2,'restitch_screen_range_v1')",
    [rangeHash, dispatch]
  );
  await db.root('delete from auth.sessions where id=$1', [f.session]);
  await expect(
    db.root('select public.service_authorize_restitch_native_control($1,$2)', [control, ticket])
  ).rejects.toThrow('AUTH_REQUIRED');
  await expect(
    db.root('select public.service_check_restitch_control_screen_range($1,$2)', [
      rangeHash,
      dispatch
    ])
  ).rejects.toThrow('AUTH_REQUIRED');
  expect(
    (
      await db.root<{ v: { claimId: string } }>(
        'select public.service_read_restitch_native_control_claim($1,$2,$3)v',
        [control, ticket, claim]
      )
    )[0]!.v.claimId
  ).toBe(claim);
  await db.root("select public.service_settle_restitch_selection_range($1,$2,$3,'end',$4,$5,$6)", [
    op,
    team,
    owner,
    request,
    reserved.transfers[0],
    { bytes: 4, ioMs: 5, complete: true }
  ]);
  await db.root(
    "select public.service_complete_catalog_video_variant($1,$2,$3,$4,$5,$6,$7,'failed','PROCESS_FAILED')",
    args
  );
  await db.root("update private.catalog_video_sets set state='cancel_requested'where id=$1", [
    f.set
  ]);
  await db.root('select public.service_settle_catalog_video_cancellations(10)');
  expect(
    (
      await db.root<{ state: string }>('select state from private.catalog_video_sets where id=$1', [
        f.set
      ])
    )[0]!.state
  ).toBe('cancel_requested');
  expect(
    (
      await db.root<{ v: boolean }>(
        "select public.service_finish_restitch_native_control($1,$2,$3,$4,'failed')v",
        [control, ticket, claim, crypto.randomUUID()]
      )
    )[0]!.v
  ).toBe(true);
  await expect(
    db.root("select public.service_finish_restitch_native_control($1,$2,$3,$4,'failed')", [
      control,
      Buffer.alloc(32, 44),
      claim,
      crypto.randomUUID()
    ])
  ).rejects.toThrow('AUTH_REQUIRED');
  await db.root("update private.catalog_video_sets set state='cancel_requested'where id=$1", [
    f.set
  ]);
  await db.root('select public.service_settle_catalog_video_cancellations(10)');
  expect(
    (
      await db.root<{ state: string }>('select state from private.catalog_video_sets where id=$1', [
        f.set
      ])
    )[0]!.state
  ).toBe('canceled');
});
it('restart retains three exact registered original receipts and only rotates the queued suffix once', async () => {
  const f = await bound(await prepared(), 4);
  await db.root('select public.service_redeem_catalog_video_foreground($1,$2,$3,$4)', [
    f.set,
    f.enrollment,
    f.native,
    f.proof
  ]);
  const children = [];
  for (const [index, child] of f.children.entries()) {
    if (index === 3) {
      children.push({ ...child, operationId: null, state: 'queued', outputId: null });
      continue;
    }
    const op = crypto.randomUUID(),
      output = (
        await db.root<{ id: string }>(
          "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes)values($1,$2,$3,'Registered.mp4','file','video','video/mp4',4)returning id",
          [team, connection, 'registered-' + op]
        )
      )[0]!.id;
    await db.root(
      "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,result_material_id,idempotency_key,request_nonce,finished_at)values($1,$2,$3,'process','succeeded',$4,$5,$6,$6,clock_timestamp())",
      [op, team, owner, source, output, 'catalog-variant:' + child.requestId]
    );
    await db.root(
      "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version)values($1,$2,'restitch','1')",
      [op, team]
    );
    children.push({ ...child, operationId: op, state: 'registered', outputId: output });
  }
  const revision = (
    await db.root<{ revision: number }>(
      'select revision from private.catalog_video_sets where id=$1',
      [f.set]
    )
  )[0]!.revision;
  await db.root('select public.service_checkpoint_catalog_video_set($1,$2,$3,$4,1,$5,$6)', [
    f.set,
    team,
    owner,
    f.enrollment,
    revision,
    children
  ]);
  const boot = crypto.randomUUID();
  await db.root('select public.service_redeem_catalog_video_foreground($1,$2,$3,$4,$5,$6)', [
    f.set,
    f.enrollment,
    f.native,
    f.proof,
    boot,
    f.native
  ]);
  await expect(
    db.root('select public.service_redeem_catalog_video_foreground($1,$2,$3,$4,$5,$6)', [
      f.set,
      f.enrollment,
      f.native,
      f.proof,
      crypto.randomUUID(),
      f.native
    ])
  ).rejects.toThrow('REQUEST_REUSE_CONFLICT');
  const rows = await db.root<{ request_id: string; state: string; output_material_id: string }>(
    'select request_id,state,output_material_id from private.catalog_video_variants where video_set_id=$1 order by video_variant_index',
    [f.set]
  );
  expect(rows.slice(0, 3)).toEqual(
    children
      .slice(0, 3)
      .map(c => ({ request_id: c.requestId, state: 'registered', output_material_id: c.outputId }))
  );
  expect(rows[3]!.state).toBe('queued');
  expect(
    (
      await db.root<{ v: { nativeInstanceId: string } }>(
        'select public.service_authorize_catalog_video_executor($1,$2,$3,1)v',
        [f.set, f.token, boot]
      )
    )[0]!.v.nativeInstanceId
  ).toBe(boot);
  await db.root("update private.catalog_video_sets set state='cancel_requested'where id=$1", [
    f.set
  ]);
  await db.root('select public.service_settle_catalog_video_cancellations(10)');
  expect(
    (
      await db.root<{ state: string }>('select state from private.catalog_video_sets where id=$1', [
        f.set
      ])
    )[0]!.state
  ).toBe('canceled');
  expect(
    await db.root(
      'select request_id,state,output_material_id from private.catalog_video_variants where video_set_id=$1 order by video_variant_index',
      [f.set]
    )
  ).toEqual(rows);
});

async function cancellationOriginal(
  f: Awaited<ReturnType<typeof bound>>,
  state: 'failed' | 'canceled' | 'pending' | 'running',
  fenced = false
) {
  const op = crypto.randomUUID(),
    child = f.children[0]!;
  await db.root(
    "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce,finished_at)values($1,$2,$3,'process',$4,$5,$6,$6,case when $4 in('failed','canceled')then clock_timestamp()else null end)",
    [op, team, owner, state, source, 'catalog-variant:' + child.requestId]
  );
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version)values($1,$2,'restitch','1')",
    [op, team]
  );
  await db.root(
    "update private.catalog_video_variants set operation_id=$2,state='unknown'where video_set_id=$1 and video_variant_index=0",
    [f.set, op]
  );
  if (fenced) {
    await db.root(
      'update private.catalog_video_variants set dispatch_credential_hash=$2 where video_set_id=$1 and video_variant_index=0',
      [f.set, f.token]
    );
    await db.root(
      'insert into private.team_recovery_execution_fences(operation_id,team_id,actor_id,job_id)values($1,$2,$3,$4)',
      [op, team, owner, child.requestId]
    );
  }
  await db.root("update private.catalog_video_sets set state='cancel_requested'where id=$1", [
    f.set
  ]);
  return op;
}
it('settles never-started queued cancellation and fences a delayed original admission', async () => {
  const f = await bound(await prepared());
  await db.root("update private.catalog_video_sets set state='cancel_requested'where id=$1", [
    f.set
  ]);
  await db.root('select public.service_settle_catalog_video_cancellations(10)');
  expect(
    (
      await db.root<{ state: string }>('select state from private.catalog_video_sets where id=$1', [
        f.set
      ])
    )[0]!.state
  ).toBe('canceled');
  await expect(
    db.root(
      "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)values($1,$2,$3,'process','pending',$4,$5,$5)",
      [crypto.randomUUID(), team, owner, source, 'catalog-variant:' + f.children[0]!.requestId]
    )
  ).rejects.toThrow('WRONG_STATE');
});
it.each(['failed', 'canceled', 'pending', 'running'] as const)(
  'settles exact original %s without a native dispatch or provider authority',
  async state => {
    const f = await bound(await prepared()),
      op = await cancellationOriginal(f, state);
    await db.root('select public.service_settle_catalog_video_cancellations(10)');
    expect(
      (
        await db.root<{ state: string }>(
          'select state from private.catalog_video_sets where id=$1',
          [f.set]
        )
      )[0]!.state
    ).toBe('canceled');
    expect(
      (
        await db.root<{ state: string }>('select state from public.team_operations where id=$1', [
          op
        ])
      )[0]!.state
    ).toBe(state === 'failed' ? 'failed' : 'canceled');
  }
);
it('retains dispatched/running and provider-unknown cancellation as pending', async () => {
  const running = await bound(await prepared());
  await cancellationOriginal(running, 'running', true);
  const unknown = await bound(await prepared()),
    op = await cancellationOriginal(unknown, 'failed');
  await db.root(
    "update private.team_operation_intents set provider_result_id='unconfirmed-provider-result'where operation_id=$1",
    [op]
  );
  await db.root('select public.service_settle_catalog_video_cancellations(10)');
  for (const f of [running, unknown])
    expect(
      (
        await db.root<{ state: string }>(
          'select state from private.catalog_video_sets where id=$1',
          [f.set]
        )
      )[0]!.state
    ).toBe('cancel_requested');
});
