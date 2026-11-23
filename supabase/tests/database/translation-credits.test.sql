-- 064: translation pays in credits inside 063's job lock — one job, one payer, one debit; a failure
-- gives the credits back.
begin;
select plan(9);

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data) values
  ('64300000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'tr-a@test.invalid', now(), '{}', '{}'),
  ('64300000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'tr-b@test.invalid', now(), '{}', '{}');
insert into public.teams (id, name, owner_id)
values ('64300000-0000-4000-8000-0000000000a1', 'Synthetic translation', '64300000-0000-4000-8000-000000000001');
insert into public.team_members (team_id, user_id, base_role) values
  ('64300000-0000-4000-8000-0000000000a1', '64300000-0000-4000-8000-000000000001', 'admin'),
  ('64300000-0000-4000-8000-0000000000a1', '64300000-0000-4000-8000-000000000002', 'viewer');
insert into private.google_drive_credentials (id, connected_by, google_permission_id, google_account_email, vault_secret_id, scope)
values ('64300000-0000-4000-8000-0000000000c1', '64300000-0000-4000-8000-000000000001', 'synthetic', 'tr-a@test.invalid',
  gen_random_uuid(), 'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections (id, team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state, connected_at)
values ('64300000-0000-4000-8000-0000000000d1', '64300000-0000-4000-8000-0000000000a1', '64300000-0000-4000-8000-0000000000c1',
  'synthetic-root', 'Synthetic', 'my_drive', 'connected', now());
insert into public.team_materials (id, team_id, connection_id, drive_file_id, name, kind, mime_type, drive_version)
values ('64300000-0000-4000-8000-0000000000e1', '64300000-0000-4000-8000-0000000000a1', '64300000-0000-4000-8000-0000000000d1',
  'synthetic-video', 'TR_16.mp4', 'file', 'video/mp4', 'v1');
update private.ai_settings set base_daily_grant = 100, price_version = 'v1';
insert into private.ai_budget_months (month, limit_usd) values (private.ai_month_of(private.kyiv_today()), 100)
on conflict (month) do update set limit_usd = 100;

create temporary table t_first as
select public.service_transcript_translation_begin_credits('team_video', '64300000-0000-4000-8000-0000000000a1',
  '64300000-0000-4000-8000-0000000000e1', null, null, 'v1:' || repeat('a', 64), 'tr', 'uk', 2, 2300,
  '64300000-0000-4000-8000-000000000001', 3, 'v1', 0.075) as r;
select is((select (r ->> 'reused')::boolean from t_first), false, 'the first press starts the job');
select is((select (r -> 'credits' ->> 'available')::integer from t_first), 97, 'and pays the shown price');
select is((public.service_transcript_translation_begin_credits('team_video', '64300000-0000-4000-8000-0000000000a1',
  '64300000-0000-4000-8000-0000000000e1', null, null, 'v1:' || repeat('a', 64), 'tr', 'uk', 2, 2300,
  '64300000-0000-4000-8000-000000000002', 3, 'v1', 0.075) ->> 'reused')::boolean, true,
  'the second person joins the same job');
select is((select count(*) from private.ai_credit_ledger l where l.feature = 'transcript_translation'
  and l.user_id in ('64300000-0000-4000-8000-000000000001', '64300000-0000-4000-8000-000000000002')), 1::bigint,
  'one debit for one job');
select is((private.ai_credits_snapshot('64300000-0000-4000-8000-000000000002') ->> 'available')::integer, 100,
  'the joiner keeps their credits');
select is((select count(*) from private.transcript_translations
  where video_id = '64300000-0000-4000-8000-0000000000e1' and status = 'processing'), 1::bigint, 'one translation runs');

select lives_ok(format($$select public.service_transcript_translation_fail(%L, 'TRANSLATION_REFUSED')$$,
  (select r ->> 'id' from t_first)), 'the model refuses');
select is((private.ai_credits_snapshot('64300000-0000-4000-8000-000000000001') ->> 'available')::integer, 100,
  'a failed translation gives the credits back');
select is((select state from private.ai_month_holds where op_key = (select r ->> 'opKey' from t_first)), 'settled',
  'and releases its month hold');

select * from finish();
rollback;
