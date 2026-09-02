import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Feature 012 (T001/T002): a transcript companion is linked 1:1 to its video,
 * unique among live rows, and readable by a member through the companion RPC.
 */

const OWNER = '27000000-0000-4000-8000-000000000001';

let harness: TeamTestDb;
let teamId: string;
let connectionId: string;
let videoId: string;

async function material(name: string, kind: string, category: string | null, overrides = '') {
  const rows = await harness.root<{ id: string }>(
    `insert into public.team_materials
       (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type${overrides ? ', ' + overrides.split('=')[0] : ''})
     values ($1, $2, $3, 'root', $3, $4, $5, 'application/octet-stream'${overrides ? ', ' + overrides.split('=')[1] : ''})
     returning id`,
    [teamId, connectionId, name, kind, category]
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: OWNER, email: 'owner@comp.test', displayName: 'Owner' });
  await harness.root(`insert into public.admin_users (user_id) values ($1)`, [OWNER]);
  const team = await harness.asUser<{ id: string }>(
    OWNER,
    'select id from public.create_team($1)',
    ['Companions']
  );
  teamId = team[0]!.id;
  const credential = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
       (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ('perm-comp', 'owner@example.test', 'https://www.googleapis.com/auth/drive.file',
             gen_random_uuid(), $1)
     returning id`,
    [OWNER]
  );
  const connection = await harness.root<{ id: string }>(
    `insert into public.team_drive_connections
       (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state, connected_at)
     values ($1, $2, 'root', 'Root', 'my_drive', 'connected', now())
     returning id`,
    [teamId, credential[0]!.id]
  );
  connectionId = connection[0]!.id;
  videoId = await material('clip.mp4', 'file', 'video');
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

async function companion(name: string, video: string) {
  const rows = await harness.root<{ id: string }>(
    `insert into public.team_materials
       (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type,
        companion_of, companion_kind, transcript_ingest_state, transcript_text)
     values ($1, $2, $3, 'root', $3, 'file', 'transcript', 'text/plain', $4, 'transcript', 'full', 'hello there')
     returning id`,
    [teamId, connectionId, name, video]
  );
  return rows[0]!.id;
}

describe('media companions', () => {
  it('links a transcript to its video and reads it back', async () => {
    const c = await companion('clip.txt', videoId);
    const read = await harness.asUser<{ id: string; name: string; has_text: boolean }>(
      OWNER,
      'select * from public.get_material_transcript_companion($1, $2)',
      [teamId, videoId]
    );
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ id: c, name: 'clip.txt', has_text: true });
  }, 60_000);

  it('allows only one live transcript companion per video', async () => {
    await expect(companion('clip-2.txt', videoId)).rejects.toThrow();
  }, 60_000);

  it('refuses a companion kind that is not a transcript, and a bad fingerprint', async () => {
    await expect(
      harness.root(
        `insert into public.team_materials
           (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type,
            companion_of, companion_kind)
         values ($1, $2, 'x', 'root', 'x', 'file', 'other', 'text/plain', $3, 'thumbnail')`,
        [teamId, connectionId, videoId]
      )
    ).rejects.toThrow(/companion_kind_check/);
    await expect(
      harness.root(`update public.team_materials set audio_fingerprint = 'nothex' where id = $1`, [
        videoId
      ])
    ).rejects.toThrow(/audio_fingerprint_check/);
  }, 60_000);
});

describe('landing preview lifecycle (012, T013)', () => {
  it('stops serving a landing render once the landing is trashed', async () => {
    const landing = await harness.root<{ id: string }>(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type,
          drive_version, checksum)
       values ($1, $2, 'land-1', 'root', 'promo.html', 'file', 'landing', 'text/html', 'v1', 'c1')
       returning id`,
      [teamId, connectionId]
    );
    await harness.root(
      `insert into public.team_landing_renders
         (team_id, material_id, preset, source_version, source_checksum, fingerprint,
          render_state, artifact_root, segment_count)
       values ($1, $2, 'default', 'v1', 'c1', $3, 'ready', 'art-root', 1)`,
      [teamId, landing[0]!.id, 'a'.repeat(64)]
    );
    const before = await harness.asUser<{ material_id: string; render_state: string }>(
      OWNER,
      'select * from public.list_landing_renders($1, $2, $3)',
      [teamId, [landing[0]!.id], 'default']
    );
    expect(before).toHaveLength(1);
    await harness.root(
      `update public.team_materials set lifecycle = 'trashed', trashed_at = now() where id = $1`,
      [landing[0]!.id]
    );
    const after = await harness.asUser(
      OWNER,
      'select * from public.list_landing_renders($1, $2, $3)',
      [teamId, [landing[0]!.id], 'default']
    );
    expect(after).toHaveLength(0);
  }, 60_000);
});

describe('transcript companion linking (012, T005)', () => {
  it('links a .txt to its video, dedups text by fingerprint, and retires the old companion', async () => {
    const FP = 'b'.repeat(64);
    const video = await material('lecture.mp4', 'file', 'video');
    // First companion, carrying text and a fingerprint.
    const first = await harness.root<{ id: string }>(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type)
       values ($1, $2, 'lecture-txt', 'root', 'lecture.txt', 'file', 'transcript', 'text/plain')
       returning id`,
      [teamId, connectionId]
    );
    expect(
      await harness.root<{ ok: { linked: boolean } }>(
        `select public.service_link_transcript_companion($1, $2, $3, $4, $5) as ok`,
        [teamId, video, first[0]!.id, FP, 'the full text of the lecture']
      )
    ).toEqual([{ ok: { linked: true, retired: [] } }]);

    // A second identical audio finds the text without recomputing it.
    const found = await harness.root<{ transcript_text: string }>(
      'select * from public.service_find_transcript_by_fingerprint($1, $2)',
      [teamId, FP]
    );
    expect(found[0]!.transcript_text).toBe('the full text of the lecture');

    // Re-transcribe: a new companion replaces the first, which is retired.
    const second = await harness.root<{ id: string }>(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type)
       values ($1, $2, 'lecture-txt-2', 'root', 'lecture.txt', 'file', 'transcript', 'text/plain')
       returning id`,
      [teamId, connectionId]
    );
    const replaced = await harness.root<{ ok: { retired: Array<{ driveFileId: string }> } }>(
      `select public.service_link_transcript_companion($1, $2, $3, $4, $5) as ok`,
      [teamId, video, second[0]!.id, 'c'.repeat(64), 'a fresh transcription']
    );
    // Named back, so the caller can trash the file itself: a row retired in the
    // catalog and left in Drive keeps holding the name the video expects, and
    // the next transcription is written as "lecture (2).txt".
    expect(replaced[0]!.ok.retired).toEqual([
      expect.objectContaining({ driveFileId: 'lecture-txt' })
    ]);
    const live = await harness.asUser<{ id: string }>(
      OWNER,
      'select id from public.get_material_transcript_companion($1, $2)',
      [teamId, video]
    );
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(second[0]!.id);
    const oldState = await harness.root<{ lifecycle: string; companion_of: string | null }>(
      'select lifecycle, companion_of from public.team_materials where id = $1',
      [first[0]!.id]
    );
    expect(oldState[0]).toMatchObject({ lifecycle: 'trashed', companion_of: null });
  }, 60_000);

  it('gives a copy the original\'s picture and its rendered preview', async () => {
    // A copy is the same bytes, so everything already known describes it too:
    // the tile fills in at once and the landing is not rendered a second time.
    const landing = await material('promo.zip', 'file', 'landing');
    const copy = await material('promo (2).zip', 'file', 'landing');
    // The thumbnail trigger keeps 'ready' only while its version matches the
    // row's own drive_version, so the fixture sets the version first.
    await harness.root(`update public.team_materials set drive_version = 'v1' where id = $1`, [
      landing
    ]);
    await harness.root(`update public.team_materials set drive_version = 'v2' where id = $1`, [
      copy
    ]);
    await harness.root(
      `update public.team_materials
          set provider_thumbnail_state = 'ready', provider_thumbnail_version = 'v1'
        where id = $1`,
      [landing]
    );
    await harness.root(
      `insert into public.team_landing_renders
         (team_id, material_id, preset, render_state, artifact_root, segment_count, fingerprint)
       values ($1, $2, 'default', 'ready', 'drive-artifact-root', 3, $3)`,
      [teamId, landing, 'a'.repeat(64)]
    );

    await harness.root('select public.service_clone_material_extras($1, $2, $3)', [
      teamId,
      landing,
      copy
    ]);

    const cloned = await harness.root<{ artifact_root: string; segment_count: number }>(
      `select artifact_root, segment_count from public.team_landing_renders
        where material_id = $1`,
      [copy]
    );
    expect(cloned[0]).toMatchObject({ artifact_root: 'drive-artifact-root', segment_count: 3 });
    const thumbnail = await harness.root<{ provider_thumbnail_state: string }>(
      'select provider_thumbnail_state from public.team_materials where id = $1',
      [copy]
    );
    expect(thumbnail[0]!.provider_thumbnail_state).toBe('ready');
  }, 60_000);

  it('refuses to link a non-transcript or a non-video', async () => {
    const notVideo = await material('pic.png', 'file', 'image');
    const txt = await harness.root<{ id: string }>(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type)
       values ($1, $2, 'stray-txt', 'root', 'stray.txt', 'file', 'transcript', 'text/plain')
       returning id`,
      [teamId, connectionId]
    );
    expect(
      await harness.root<{ ok: { linked: boolean } }>(
        `select public.service_link_transcript_companion($1, $2, $3, null, 't') as ok`,
        [teamId, notVideo, txt[0]!.id]
      )
    ).toEqual([{ ok: { linked: false, retired: [] } }]);
  }, 60_000);
});

describe('landing preview refresh (012, T014)', () => {
  it('marks a landing render stale for the render loop to rebuild', async () => {
    const landing = await harness.root<{ id: string }>(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type,
          drive_version, checksum)
       values ($1, $2, 'land-2', 'root', 'promo2.html', 'file', 'landing', 'text/html', 'v1', 'c1')
       returning id`,
      [teamId, connectionId]
    );
    await harness.root(
      `insert into public.team_landing_renders
         (team_id, material_id, preset, source_version, source_checksum, fingerprint,
          render_state, artifact_root, segment_count)
       values ($1, $2, 'default', 'v1', 'c1', $3, 'ready', 'art', 1)`,
      [teamId, landing[0]!.id, 'd'.repeat(64)]
    );
    const affected = await harness.asUser<{ request_landing_render_refresh: number }>(
      OWNER,
      'select public.request_landing_render_refresh($1, $2)',
      [teamId, landing[0]!.id]
    );
    expect(affected[0]!.request_landing_render_refresh).toBe(1);
    const state = await harness.root<{ render_state: string; artifact_root: string | null }>(
      'select render_state, artifact_root from public.team_landing_renders where material_id = $1',
      [landing[0]!.id]
    );
    expect(state[0]).toMatchObject({ render_state: 'stale', artifact_root: null });
  }, 60_000);

  it('refuses a refresh on a material that is not a landing', async () => {
    const video = await material('novid.mp4', 'file', 'video');
    await expect(
      harness.asUser(OWNER, 'select public.request_landing_render_refresh($1, $2)', [teamId, video])
    ).rejects.toThrow(/NOT_FOUND/);
  }, 60_000);
});

describe('transcript delete preference (012, T011)', () => {
  it('defaults to ask, and round-trips a set value', async () => {
    const initial = await harness.asUser<{ get_transcript_delete_pref: string }>(
      OWNER,
      'select public.get_transcript_delete_pref()'
    );
    expect(initial[0]!.get_transcript_delete_pref).toBe('ask');
    await harness.asUser(OWNER, 'select public.set_transcript_delete_pref($1)', ['delete']);
    const after = await harness.asUser<{ get_transcript_delete_pref: string }>(
      OWNER,
      'select public.get_transcript_delete_pref()'
    );
    expect(after[0]!.get_transcript_delete_pref).toBe('delete');
    await expect(
      harness.asUser(OWNER, 'select public.set_transcript_delete_pref($1)', ['nonsense'])
    ).rejects.toThrow(/INVALID_INPUT/);
  }, 60_000);
});

describe('video text variants surface the explorer companion (012, T017)', () => {
  it('returns the linked transcript companion as the original variant', async () => {
    // A video the RPC can key on (it needs a drive_version or checksum).
    const video = await harness.root<{ id: string }>(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type,
          drive_version)
       values ($1, $2, 'variant-vid', 'root', 'variant.mp4', 'file', 'video', 'video/mp4', 'v9')
       returning id`,
      [teamId, connectionId]
    );
    await harness.root<{ id: string }>(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type,
          companion_of, companion_kind, transcript_ingest_state, transcript_truncated, transcript_text)
       values ($1, $2, 'variant-txt', 'root', 'variant.txt', 'file', 'transcript', 'text/plain',
               $3, 'transcript', 'full', false, 'the spoken words')
       returning id`,
      [teamId, connectionId, video[0]!.id]
    );
    const payload = await harness.asUser<{ list_video_text_variants: Record<string, unknown> }>(
      OWNER,
      'select public.list_video_text_variants($1, $2)',
      [teamId, video[0]!.id]
    );
    const variants = (
      payload[0]!.list_video_text_variants as { variants: Array<Record<string, unknown>> }
    ).variants;
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({
      kind: 'original',
      text: 'the spoken words',
      ingestState: 'full'
    });
  }, 60_000);
});
