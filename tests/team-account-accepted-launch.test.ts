import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { launchPreview, parseLaunchSources } from '../packages/shared/src/team/launches';
import { launchConfig } from './fixtures/launches';
import { financeFixture, FINANCE_OWNER } from './support/team-agent-finance';
import { assignLaunchFixture } from './support/launch-assignment';

it('publishes an already accepted generation after RK archive, replays its receipt, retains history, and rejects new acceptance', async () => {
  const f = await financeFixture();
  try {
    const call = async (name: string, args: unknown[]) =>
      (
        await f.db.asUser<{ value: any }>(
          FINANCE_OWNER,
          `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) value`,
          args
        )
      )[0]!.value;
    const credential = (
      await f.db.root<{ id: string }>(
        "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('perm-038-generation','synthetic@accepted.test','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
        [FINANCE_OWNER]
      )
    )[0]!.id;
    const connection = (
      await f.db.root<{ id: string }>(
        "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root-038-generation','Synthetic root','my_drive','connected',now()) returning id",
        [f.team, credential]
      )
    )[0]!.id;
    const material = (
      await f.db.root<{ id: string }>(
        "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,'038-generation-video','synthetic.mp4','file','video','video/mp4','1') returning id",
        [f.team, connection]
      )
    )[0]!.id;
    const buyer = await call('create_launch_dictionary', [
      f.team,
      'buyers',
      'buyer038',
      randomUUID()
    ]);
    const offer = await call('create_launch_dictionary', [
      f.team,
      'offers',
      'offer038',
      randomUUID()
    ]);
    const config = launchConfig({
      agentRowId: f.agent,
      materialId: material,
      buyerId: buyer.id,
      offerId: offer.id,
      method: 'other'
    });
    const prepare = async (assign = true) => {
      const draft = await call('save_launch_draft', [
        f.team,
        null,
        null,
        randomUUID(),
        JSON.stringify(config),
        null
      ]);
      const draftVersion = assign
        ? await assignLaunchFixture(f.db, FINANCE_OWNER, f.team, draft.id, config.agentRowId)
        : draft.version;
      const source = await call('get_launch_sources', [f.team, draft.id]);
      const parsed = parseLaunchSources(source);
      expect(parsed).not.toBeNull();
      const saved = await call('save_launch_draft', [
        f.team,
        draft.id,
        draftVersion,
        randomUUID(),
        JSON.stringify(config),
        JSON.stringify(source)
      ]);
      const preview = launchPreview(config, parsed!);
      expect(preview.ok).toBe(true);
      if (!preview.ok) throw new Error('Synthetic preview invalid');
      return {
        id: draft.id,
        args: [
          f.team,
          draft.id,
          FINANCE_OWNER,
          saved.version,
          randomUUID(),
          randomUUID(),
          JSON.stringify(config),
          JSON.stringify(source),
          JSON.stringify(preview.value)
        ]
      };
    };
    const accept = async (args: unknown[]) =>
      (
        await f.db.root<{
          value: {
            id: string;
            revisionId: string;
            fence: string;
            state: string;
            replayed: boolean;
          };
        }>('select public.service_accept_launch_generation($1,$2,$3,$4,$5,$6,$7,$8,$9) value', args)
      )[0]!.value;
    const prepared = await prepare();
    const accepted = await accept(prepared.args);
    expect(accepted.state).toBe('accepted');
    const pre = await call('get_team_account_archive_preflight', [f.team, 'agent', f.agent]);
    await call('set_team_account_archived', [
      f.team,
      'agent',
      f.agent,
      true,
      pre.lifecycleVersion,
      pre.token,
      randomUUID()
    ]);
    const replay = await accept(prepared.args);
    expect(replay).toMatchObject({
      id: accepted.id,
      revisionId: accepted.revisionId,
      replayed: true
    });
    const published = (
      await f.db.root<{ value: { state: string; revisionId: string } }>(
        'select public.service_publish_launch_generation($1,$2,$3,$4) value',
        [f.team, accepted.id, FINANCE_OWNER, accepted.fence]
      )
    )[0]!.value;
    expect(published).toMatchObject({ state: 'succeeded', revisionId: accepted.revisionId });
    const history = await call('get_launch', [f.team, prepared.id, null]);
    expect(history.generation.state).toBe('succeeded');
    expect(history.activeRevision).not.toBeNull();
    expect(history.activeRevision.id).toBe(accepted.revisionId);
    expect(
      (await call('get_team_account_archive_preflight', [f.team, 'agent', f.agent]))
        .effectiveArchived
    ).toBe(true);
    const fresh = await prepare(false);
    await expect(accept(fresh.args)).rejects.toThrow('ACCOUNT_ARCHIVED');
    expect(
      (
        await f.db.root<{ n: number }>(
          'select count(*)::integer n from public.team_launch_generations where team_id=$1 and launch_id=$2',
          [f.team, fresh.id]
        )
      )[0]!.n
    ).toBe(0);
  } finally {
    await f.db.close();
  }
}, 120000);
