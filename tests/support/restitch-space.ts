import { createUser, type TeamTestDb } from './team-db';

/**
 * A space with the people and the Drive tree the re-stitch pool tests need (feature 030).
 *
 * Owner, a viewer who may download, an editor-like member who may process but not download,
 * one connected Drive, and a folder `restitch-fixtures` whose contents exercise every rule the
 * pool resolver has: the three good formats, a HEIC, a GIF, an SVG, an oversized JPEG, two
 * files with the same bytes, a nested subfolder, and materials in every unavailable state.
 */

export const RESTITCH_OWNER = '30000000-0000-4000-8000-000000000001';
export const RESTITCH_VIEWER = '30000000-0000-4000-8000-000000000002';
/** `process` without `download`: the member the permission error is for. */
export const RESTITCH_PROCESSOR = '30000000-0000-4000-8000-000000000003';
export const RESTITCH_STRANGER = '30000000-0000-4000-8000-000000000009';

export interface RestitchSpace {
  teamId: string;
  connectionId: string;
  /** The folder material ids. */
  folders: { fixtures: string; nested: string; empty: string };
  /** The image material ids, by what they are for. */
  images: {
    png: string;
    jpg: string;
    webp: string;
    nestedJpg: string;
    heic: string;
    gif: string;
    svg: string;
    oversized: string;
    twinA: string;
    twinB: string;
    trashed: string;
    missing: string;
    outOfRoot: string;
    /** A good picture outside every folder, for file sources. */
    loose: string;
    /** A picture of another connection: "out of root" by connection. */
    foreign: string;
  };
  /** A video, to prove non-images are refused as sources. */
  video: string;
}

let fileSeq = 0;

export async function seedRestitchSpace(harness: TeamTestDb): Promise<RestitchSpace> {
  await createUser(harness, {
    id: RESTITCH_OWNER,
    email: 'owner@restitch.test',
    displayName: 'Owner'
  });
  await createUser(harness, {
    id: RESTITCH_VIEWER,
    email: 'viewer@restitch.test',
    displayName: 'Viewer'
  });
  await createUser(harness, {
    id: RESTITCH_PROCESSOR,
    email: 'processor@restitch.test',
    displayName: 'Processor'
  });
  await createUser(harness, { id: RESTITCH_STRANGER, email: 'stranger@restitch.test' });
  await harness.root(
    'insert into public.admin_users (user_id) values ($1) on conflict do nothing',
    [RESTITCH_OWNER]
  );
  const team = await harness.asUser<{ id: string }>(
    RESTITCH_OWNER,
    'select id from public.create_team($1)',
    ['Re-stitch']
  );
  const teamId = team[0]!.id;
  await harness.root(
    `insert into public.team_members (team_id, user_id, base_role) values ($1, $2, 'viewer')`,
    [teamId, RESTITCH_VIEWER]
  );
  // An editor may process; the override takes downloading away.
  await harness.root(
    `insert into public.team_members (team_id, user_id, base_role, permission_overrides)
     values ($1, $2, 'editor', '{"download": false}'::jsonb)`,
    [teamId, RESTITCH_PROCESSOR]
  );
  const credential = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
       (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ('perm-restitch', 'owner@restitch.test', 'https://www.googleapis.com/auth/drive.file',
             gen_random_uuid(), $1)
     returning id`,
    [RESTITCH_OWNER]
  );
  const connection = await harness.root<{ id: string }>(
    `insert into public.team_drive_connections
       (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state, connected_at)
     values ($1, $2, 'root', 'Root', 'my_drive', 'connected', now())
     returning id`,
    [teamId, credential[0]!.id]
  );
  const connectionId = connection[0]!.id;
  const detached = await harness.root<{ id: string }>(
    `insert into public.team_drive_connections
       (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state, connected_at, detached_at)
     values ($1, $2, 'old-root', 'Old root', 'my_drive', 'detached', now(), now())
     returning id`,
    [teamId, credential[0]!.id]
  );

  async function folder(name: string, parent: string): Promise<{ id: string; driveId: string }> {
    fileSeq += 1;
    const driveId = `folder-${fileSeq}`;
    const rows = await harness.root<{ id: string }>(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, mime_type)
       values ($1, $2, $3, $4, $5, 'folder', 'application/vnd.google-apps.folder')
       returning id`,
      [teamId, connectionId, driveId, parent, name]
    );
    return { id: rows[0]!.id, driveId };
  }

  async function image(
    name: string,
    parent: string,
    options: {
      mime?: string;
      size?: number;
      checksum?: string;
      lifecycle?: 'active' | 'trashed' | 'missing';
      missingReason?: 'removed' | 'out_of_root';
      connection?: string;
      category?: string;
    } = {}
  ): Promise<string> {
    fileSeq += 1;
    const rows = await harness.root<{ id: string }>(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type,
          size_bytes, checksum, drive_version, lifecycle, missing_reason, trashed_at, missing_at)
       values ($1, $2, $3, $4, $5, 'file', $6, $7, $8, $9, '1', $10, $11,
               case when $10 = 'trashed' then now() end, case when $10 = 'missing' then now() end)
       returning id`,
      [
        teamId,
        options.connection ?? connectionId,
        `file-${fileSeq}`,
        parent,
        name,
        options.category ?? 'image',
        options.mime ?? 'image/jpeg',
        options.size ?? 100_000,
        options.checksum ?? `md5-${fileSeq}`,
        options.lifecycle ?? 'active',
        options.missingReason ?? null
      ]
    );
    return rows[0]!.id;
  }

  const fixtures = await folder('restitch-fixtures', 'root');
  const nested = await folder('nested', fixtures.driveId);
  const empty = await folder('empty', 'root');
  const images = {
    png: await image('a.png', fixtures.driveId, { mime: 'image/png' }),
    jpg: await image('b.jpg', fixtures.driveId),
    webp: await image('c.webp', fixtures.driveId, { mime: 'image/webp' }),
    nestedJpg: await image('deep.jpg', nested.driveId),
    heic: await image('phone.heic', fixtures.driveId, { mime: 'image/heic' }),
    gif: await image('anim.gif', fixtures.driveId, { mime: 'image/gif' }),
    svg: await image('logo.svg', fixtures.driveId, { mime: 'image/svg+xml' }),
    oversized: await image('huge.jpg', fixtures.driveId, { size: 60 * 1024 * 1024 }),
    twinA: await image('twin-a.jpg', fixtures.driveId, { checksum: 'same-bytes' }),
    twinB: await image('twin-b.jpg', fixtures.driveId, { checksum: 'same-bytes' }),
    trashed: await image('gone.jpg', fixtures.driveId, { lifecycle: 'trashed' }),
    missing: await image('lost.jpg', fixtures.driveId, {
      lifecycle: 'missing',
      missingReason: 'removed'
    }),
    outOfRoot: await image('moved.jpg', fixtures.driveId, {
      lifecycle: 'missing',
      missingReason: 'out_of_root'
    }),
    loose: await image('loose.png', 'root', { mime: 'image/png' }),
    foreign: await image('foreign.jpg', 'old-root', { connection: detached[0]!.id })
  };
  const video = await image('clip.mp4', 'root', { category: 'video', mime: 'video/mp4' });

  return {
    teamId,
    connectionId,
    folders: { fixtures: fixtures.id, nested: nested.id, empty: empty.id },
    images,
    video
  };
}
