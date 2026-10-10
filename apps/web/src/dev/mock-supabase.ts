/**
 * A Supabase that answers from memory (development only).
 *
 * The redesign has to be looked at, and most of the product is behind a team
 * space: a lobby, an explorer, a board, an accounts table, five settings tabs.
 * All of it reads through `requireSupabaseClient()`, so one fake client at that
 * seam makes every screen reachable with no database, no agent and no network —
 * which is the only way to walk `contracts/screens.md` while the real
 * environment is busy.
 *
 * It is deliberately shallow. Reads answer from a seed; writes echo something
 * plausible and change nothing. An RPC nobody taught it returns an empty result
 * and says so in the console, so a screen lands on its empty state rather than
 * on an error, and the gap names itself.
 *
 * Guarded by `import.meta.env.DEV` at its only call site, so the branch — and
 * this module with it — is dropped from a production build.
 */

const TEAM_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '00000000-0000-4000-8000-000000000001';

const PERMISSIONS = {
  view: true,
  download: true,
  upload: true,
  edit: true,
  delete: true,
  process: true,
  manage_members: true,
  manage_metadata: true
};

const now = new Date('2026-09-13T12:00:00Z');
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

const TEAMS = [
  {
    id: TEAM_ID,
    name: 'Медіабаїнг',
    role: 'owner',
    permissions: PERMISSIONS,
    connection_state: 'connected'
  }
];

const MEMBERS = [
  {
    user_id: USER_ID,
    email: 'dev@wishly.local',
    display_name: 'Soty Developer',
    avatar_url: null,
    base_role: 'owner',
    permission_overrides: {},
    permissions: PERMISSIONS,
    joined_at: ago(60 * 24 * 30),
    last_seen_at: ago(3)
  },
  {
    user_id: '00000000-0000-4000-8000-000000000002',
    email: 'olena@studio.test',
    display_name: 'Олена',
    avatar_url: null,
    base_role: 'editor',
    permission_overrides: {},
    permissions: { ...PERMISSIONS, manage_members: false, delete: false },
    joined_at: ago(60 * 24 * 9),
    last_seen_at: ago(41)
  },
  {
    user_id: '00000000-0000-4000-8000-000000000003',
    email: 'taras@studio.test',
    display_name: 'Тарас',
    avatar_url: null,
    base_role: 'viewer',
    permission_overrides: {},
    permissions: {
      ...PERMISSIONS,
      upload: false,
      edit: false,
      delete: false,
      process: false,
      manage_members: false,
      manage_metadata: false
    },
    joined_at: ago(60 * 24 * 2),
    last_seen_at: null
  }
];

/* One space's worth of files: two folders and five kinds of file, so every
   tile, row, badge and preview state has something to draw. */
const FOLDERS = [
  { id: 'f-creatives', name: 'Креативи', parent: null, files: 3 },
  { id: 'f-landings', name: 'Ленди', parent: null, files: 2 }
];

type Row = {
  id: string;
  teamId: string;
  name: string;
  category: string | null;
  mimeType: string | null;
  fileExtension: string | null;
  sizeBytes: number | null;
  kind: string;
  driveFileId: string;
  parentFolderId: string | null;
  modifiedAt: string | null;
  driveVersion: string | null;
  previewState: string;
  thumbnailReady: boolean;
  tagColor?: string | null;
};

function row(partial: Partial<Row> & { id: string; name: string; kind: string }): Row {
  return {
    teamId: TEAM_ID,
    category: null,
    mimeType: null,
    fileExtension: null,
    sizeBytes: null,
    driveFileId: `drive-${partial.id}`,
    parentFolderId: null,
    modifiedAt: ago(90),
    driveVersion: '1',
    previewState: 'ready',
    thumbnailReady: false,
    tagColor: null,
    ...partial
  } as Row;
}

const ROOT_ROWS: Row[] = [
  row({ id: 'f-creatives', name: 'Креативи', kind: 'folder', previewState: 'not_applicable' }),
  row({ id: 'f-landings', name: 'Ленди', kind: 'folder', previewState: 'not_applicable' }),
  row({
    id: 'm-video',
    name: 'launch-hook-v3.mp4',
    kind: 'video',
    category: 'video',
    mimeType: 'video/mp4',
    fileExtension: 'mp4',
    sizeBytes: 184_320_000,
    thumbnailReady: true,
    tagColor: 'green',
    modifiedAt: ago(140)
  }),
  row({
    id: 'm-image',
    name: 'banner-1080x1080.png',
    kind: 'image',
    category: 'image',
    mimeType: 'image/png',
    fileExtension: 'png',
    sizeBytes: 2_410_000,
    thumbnailReady: true,
    modifiedAt: ago(220)
  }),
  row({
    id: 'm-landing',
    name: 'keto-gummies-lp.zip',
    kind: 'landing',
    category: 'landing',
    mimeType: 'application/zip',
    fileExtension: 'zip',
    sizeBytes: 8_900_000,
    tagColor: 'orange',
    modifiedAt: ago(400)
  }),
  row({
    id: 'm-transcript',
    name: 'launch-hook-v3.txt',
    kind: 'transcript',
    category: 'transcript',
    mimeType: 'text/plain',
    fileExtension: 'txt',
    sizeBytes: 14_200,
    previewState: 'ready',
    modifiedAt: ago(130)
  }),
  row({
    id: 'm-archive',
    name: 'старі-крео.zip',
    kind: 'archive',
    category: 'archive',
    mimeType: 'application/zip',
    fileExtension: 'zip',
    sizeBytes: 640_000_000,
    previewState: 'unavailable',
    modifiedAt: ago(60 * 24 * 12)
  })
];

const TREE = FOLDERS.map(folder => ({
  id: folder.id,
  drive_file_id: `drive-${folder.id}`,
  parent_folder_id: folder.parent,
  selection_id: 'sel-root',
  name: folder.name,
  indexed_at: ago(30),
  child_folder_count: 0,
  child_file_count: folder.files,
  thumbnail_ready_count: folder.files
}));

const DRIVE_STATUS = [
  {
    connection_id: 'conn-1',
    state: 'connected',
    root_folder_name: 'Soty — Медіабаїнг',
    drive_kind: 'my_drive',
    initial_sync_state: 'completed',
    last_synced_at: ago(6),
    last_error_code: null,
    connected_account_email: 'dev@wishly.local',
    capabilities_checked_at: ago(6)
  }
];

/** Handlers keyed by the RPC the product calls. */
const RPC: Record<string, (args: Record<string, unknown>) => unknown> = {
  can_access_team_workspace: () => mockAccessMode() === 'workspace',
  list_my_invitations: () => [],
  list_my_teams: () => (mockAccessMode() === 'workspace' ? TEAMS : []),
  list_team_members: () => MEMBERS,
  list_team_invitations: () => [],
  list_team_audit: () => [],
  list_team_folder_tree: () => TREE,
  get_drive_connection_status: () => DRIVE_STATUS,
  list_team_accounts: () => ACCOUNTS,
  list_team_labels: args => LABELS.filter(label => !args.p_scope || label.scope === args.p_scope),
  list_team_tasks: () => TASKS,
  get_team_task: args => {
    const task = TASKS.find(item => item.id === args.p_task);
    return task ? [{ ...task, attachments: [] }] : [];
  },
  list_team_folder_page: args => {
    const parent = (args.p_parent_folder_id as string | undefined) ?? null;
    const rows = parent === null ? ROOT_ROWS : [];
    return { rows, total: rows.length, next: null };
  },
  get_team_storage_health: () => [
    { team_id: TEAM_ID, kind: 'ready', reason: null, fixer: null, checked_at: ago(2) }
  ],
  get_team_storage_health_v2: () => ({
    kind: 'connected',
    lastReconciledAt: ago(2),
    coverage: 'complete',
    syncHealth: 'current',
    lastConfirmedAt: ago(2),
    nextAction: 'none'
  }),
  /* The dashboard, so its tables, tiles and filters can be walked without a
     database. Numbers chosen to be awkward on purpose: a six-figure count, a
     long display name and an account in each of the three states. */
  is_admin: () => true,
  admin_overview: () => ADMIN_OVERVIEW,
  admin_daily_activity: () => ADMIN_DAILY,
  admin_tool_usage: () => [
    { category: 'tool', label: 'Compressor', total: 4821 },
    { category: 'tool', label: 'Transcription', total: 1290 },
    { category: 'tool', label: 'Landing optimizer', total: 344 }
  ],
  admin_agent_versions: () => [
    { agent_version: '1.1.0', total: 18 },
    { agent_version: '1.0.3', total: 5 }
  ],
  admin_list_users: () => ADMIN_USERS,
  admin_active_support_goal: () => SUPPORT_GOAL,
  admin_update_support_goal: args => ({
    ...SUPPORT_GOAL,
    title_en: args.p_title_en,
    title_uk: args.p_title_uk,
    target_cents: args.p_target_cents,
    raised_cents: args.p_raised_cents,
    updated_at: new Date().toISOString()
  }),
  admin_list_team_workspace_waitlist: () => [
    { user_id: 'u-w1', email: 'buyer@example.com', created_at: ago(48) },
    { user_id: 'u-w2', email: 'media@example.com', created_at: ago(12) }
  ],
  admin_list_windows_app_waitlist: () => [
    { user_id: 'u-x1', email: 'windows@example.com', created_at: ago(72) }
  ]
};

const ADMIN_OVERVIEW = {
  total_users: 124_803,
  new_users_24h: 41,
  new_users_7d: 318,
  new_users_30d: 1_204,
  active_users_7d: 902,
  active_users_30d: 3_411,
  marketing_consent_users: 58_120,
  agent_connections: 23,
  compressor_opens: 9_812,
  compression_batches: 1_455,
  successful_compressions: 1_398,
  failed_compressions: 57,
  total_videos: 7_204,
  total_input_bytes: 4_812_000_000,
  total_output_bytes: 1_240_000_000,
  total_saved_bytes: 3_572_000_000,
  average_saving_percent: 74,
  optimal_batches: 1_102,
  custom_batches: 353,
  image_embedding_batches: 211,
  videos_optimal: 5_400,
  videos_custom: 1_804,
  videos_with_image: 640
};

const ADMIN_DAILY = Array.from({ length: 30 }, (_, index) => ({
  activity_date: new Date(Date.now() - (29 - index) * 86_400_000).toISOString().slice(0, 10),
  active_users: 60 + ((index * 37) % 90),
  event_count: 240 + ((index * 91) % 400)
}));

const ADMIN_USERS = [
  {
    id: 'u-1',
    email: 'roman@example.com',
    display_name: 'Roman Kravchenko',
    created_at: ago(24 * 90),
    last_seen_at: ago(3),
    marketing_consent: true,
    account_status: 'active'
  },
  {
    id: 'u-2',
    email: 'a.very.long.address.for.a.media.buyer@some-agency-domain.example',
    display_name: 'Олександра Ковальчук-Петренко',
    created_at: ago(24 * 40),
    last_seen_at: null,
    marketing_consent: false,
    account_status: 'blocked'
  },
  {
    id: 'u-3',
    email: 'gone@example.com',
    display_name: null,
    created_at: ago(24 * 200),
    last_seen_at: ago(24 * 30),
    marketing_consent: true,
    account_status: 'deleted'
  }
];

const SUPPORT_GOAL = {
  id: 'goal-1',
  slug: 'for-bug-fixes',
  title_en: 'For bug fixes',
  title_uk: 'На виправлення багів',
  description_en: 'Keeping the lights on.',
  description_uk: 'Щоб світло не гасло.',
  currency: 'USD',
  raised_cents: 0,
  target_cents: 2_500,
  status: 'active',
  created_at: ago(24 * 30),
  updated_at: ago(5)
};

/* Two accounts and five agents, with runs, balances and markers — the density
   reference the accounts table was designed against. */
const AGENTS = [
  {
    id: 'ag-1',
    account_id: 'acc-1',
    team_id: TEAM_ID,
    agent_id: 'v31-434',
    balance: 320,
    topup: 150,
    task_count: 2,
    labels: [{ id: 'lbl-a1', name: 'FB', color: 'blue' }],
    runs: [
      { id: 'run-1', note: 'keto · UA · 3 крео', marker: 'green', created_at: ago(120) },
      { id: 'run-2', note: 'keto · PL', marker: null, created_at: ago(320) }
    ],
    created_at: ago(60 * 24 * 20),
    updated_at: ago(40)
  },
  {
    id: 'ag-2',
    account_id: 'acc-1',
    team_id: TEAM_ID,
    agent_id: 'v31-512',
    balance: 0,
    topup: null,
    task_count: 0,
    labels: [],
    runs: [],
    created_at: ago(60 * 24 * 14),
    updated_at: ago(600)
  },
  {
    id: 'ag-3',
    account_id: 'acc-1',
    team_id: TEAM_ID,
    agent_id: 'v31-777',
    balance: 90,
    topup: 50,
    task_count: 1,
    labels: [{ id: 'lbl-a2', name: 'TikTok', color: 'pink' }],
    runs: [{ id: 'run-3', note: 'gummies · DE', marker: 'amber', created_at: ago(75) }],
    created_at: ago(60 * 24 * 6),
    updated_at: ago(75)
  },
  {
    id: 'ag-4',
    account_id: 'acc-2',
    team_id: TEAM_ID,
    agent_id: 'm12-004',
    balance: 1200,
    topup: 200,
    task_count: 3,
    labels: [{ id: 'lbl-a1', name: 'FB', color: 'blue' }],
    runs: [{ id: 'run-4', note: 'collagen · ES', marker: 'red', created_at: ago(30) }],
    created_at: ago(60 * 24 * 3),
    updated_at: ago(30)
  },
  {
    id: 'ag-5',
    account_id: 'acc-2',
    team_id: TEAM_ID,
    agent_id: 'm12-019',
    balance: 45,
    topup: null,
    task_count: 0,
    labels: [],
    runs: [],
    created_at: ago(60 * 24),
    updated_at: ago(900)
  }
];

const ACCOUNTS = [
  {
    id: 'acc-1',
    team_id: TEAM_ID,
    name: 'Vertex',
    created_at: ago(60 * 24 * 22),
    updated_at: ago(40),
    agents: AGENTS.filter(agent => agent.account_id === 'acc-1')
  },
  {
    id: 'acc-2',
    team_id: TEAM_ID,
    name: 'Momentum',
    created_at: ago(60 * 24 * 4),
    updated_at: ago(30),
    agents: AGENTS.filter(agent => agent.account_id === 'acc-2')
  }
];

const LABELS = [
  { id: 'lbl-t1', name: 'Крео', color: 'purple', scope: 'task' },
  { id: 'lbl-t2', name: 'Ленд', color: 'teal', scope: 'task' },
  { id: 'lbl-t3', name: 'Правка', color: 'orange', scope: 'task' },
  { id: 'lbl-a1', name: 'FB', color: 'blue', scope: 'agent' },
  { id: 'lbl-a2', name: 'TikTok', color: 'pink', scope: 'agent' }
].map(label => ({
  ...label,
  team_id: TEAM_ID,
  usage_count: 2,
  created_at: ago(60 * 24 * 10),
  updated_at: ago(60 * 24)
}));

const agentTag = (agent: (typeof AGENTS)[number], accountName: string) => ({
  id: `tag-${agent.id}`,
  agent_row_id: agent.id,
  account_id: agent.account_id,
  account_name: accountName,
  agent_id: agent.agent_id,
  runs: agent.runs
});

const TASKS = [
  {
    id: 'task-1',
    team_id: TEAM_ID,
    created_by: USER_ID,
    title: 'Зняти 5 крео під keto UA',
    note: 'Хуки з першої секунди, вертикаль 9:16.',
    assignee_id: MEMBERS[1].user_id,
    assignee_label_snapshot: 'Олена',
    status: 'in_progress',
    progress_max: 5,
    progress_value: 3,
    progress_manually_set: false,
    attachment_count: 2,
    agents: [agentTag(AGENTS[0], 'Vertex')],
    labels: [LABELS[0]],
    task_date: '2026-09-13',
    created_at: ago(60 * 20),
    updated_at: ago(90),
    completed_at: null
  },
  {
    id: 'task-2',
    team_id: TEAM_ID,
    created_by: USER_ID,
    title: 'Ленд під gummies DE',
    note: null,
    assignee_id: null,
    assignee_label_snapshot: null,
    status: 'todo',
    progress_max: 1,
    progress_value: 0,
    progress_manually_set: false,
    attachment_count: 0,
    agents: [agentTag(AGENTS[2], 'Vertex')],
    labels: [LABELS[1]],
    task_date: '2026-09-14',
    created_at: ago(60 * 8),
    updated_at: ago(60 * 8),
    completed_at: null
  },
  {
    id: 'task-3',
    team_id: TEAM_ID,
    created_by: USER_ID,
    title: 'Правки по collagen ES',
    note: 'Замінити оффер на другому екрані.',
    assignee_id: MEMBERS[2].user_id,
    assignee_label_snapshot: 'Тарас',
    status: 'done',
    progress_max: 3,
    progress_value: 3,
    progress_manually_set: true,
    attachment_count: 1,
    agents: [agentTag(AGENTS[3], 'Momentum')],
    labels: [LABELS[2]],
    task_date: '2026-09-12',
    created_at: ago(60 * 48),
    updated_at: ago(60 * 5),
    completed_at: ago(60 * 5)
  }
];

/* 034 — space tariffs. The dev user is an administrator with a couple of
   tariffs to look at; `localStorage['soty.mock.space-access']` set to
   `showcase` or `blocked` shows the screens a person without a space sees. */

const PLANS = [
  {
    code: 'solo',
    nameUk: 'Соло',
    nameEn: 'Solo',
    summaryUk: 'для одного баєра',
    summaryEn: 'for one media buyer',
    baseSeats: 1,
    invitesAllowed: false,
    extraSeatsAllowed: true,
    maxExtraSeats: null,
    billingPeriod: 'month',
    highlight: false,
    features: [],
    showcase: true,
    sortOrder: 10
  },
  {
    code: 'lead',
    nameUk: 'Лід',
    nameEn: 'Lead',
    summaryUk: 'тімлід і двоє людей, місця можна додати',
    summaryEn: 'a lead and two people, more seats on request',
    baseSeats: 3,
    invitesAllowed: true,
    extraSeatsAllowed: true,
    maxExtraSeats: null,
    billingPeriod: 'month',
    highlight: true,
    features: [],
    showcase: true,
    sortOrder: 20
  }
];

const kyivDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const TEAM_TARIFF = {
  state: 'expiring',
  planCode: 'lead',
  planNameUk: 'Лід',
  planNameEn: 'Lead',
  seatsTotal: 3,
  seatsUsed: 3,
  pendingInvites: 0,
  canInvite: true,
  endsOn: kyivDay(3),
  endsAt: `${kyivDay(3)}T20:59:59.999Z`,
  graceUntil: `${kyivDay(6)}T20:59:59.999Z`,
  daysLeft: 3,
  isOwner: true,
  updaterPausedByTariff: false
};

function mockAccessMode(): 'workspace' | 'showcase' | 'blocked' {
  try {
    const value = window.localStorage.getItem('soty.mock.space-access');
    return value === 'showcase' || value === 'blocked' ? value : 'workspace';
  } catch {
    return 'workspace';
  }
}

function spaceAccess() {
  const mode = mockAccessMode();
  const showcase = {
    plans: PLANS,
    contact: { telegram: 'soty_admin', email: 'admin@soty.local' },
    email: 'dev@wishly.local',
    request: null
  };
  if (mode === 'showcase') {
    return {
      mode,
      canCreate: false,
      pendingTariff: null,
      teams: [],
      invitations: [
        {
          invitationId: 'inv-mock',
          teamId: '22222222-2222-4222-8222-222222222222',
          teamName: 'Студія Оля',
          inviterName: 'Оля',
          role: 'editor',
          blocked: false
        }
      ],
      banner: null,
      toast: null,
      showcase
    };
  }
  const blocked = mode === 'blocked';
  return {
    mode,
    canCreate: false,
    pendingTariff: null,
    teams: [
      {
        teamId: TEAM_ID,
        name: TEAMS[0]!.name,
        role: 'owner',
        accessState: blocked ? 'blocked' : 'allowed',
        ownerName: 'Soty Developer',
        tariff: blocked
          ? { ...TEAM_TARIFF, state: 'blocked', endsOn: kyivDay(-5), daysLeft: -5 }
          : TEAM_TARIFF
      }
    ],
    invitations: [],
    banner: blocked
      ? null
      : {
          teamId: TEAM_ID,
          teamName: TEAMS[0]!.name,
          kind: 'warn_3d',
          endsOn: TEAM_TARIFF.endsOn,
          graceUntil: kyivDay(6),
          daysLeft: 3,
          updaterRunning: true,
          planCode: 'lead'
        },
    toast: null,
    showcase
  };
}

const ADMIN_TARIFFS = [
  {
    id: 'tar-1',
    ownerEmail: 'dev@wishly.local',
    ownerId: USER_ID,
    ownerName: 'Soty Developer',
    teamId: TEAM_ID,
    teamName: 'Медіабаїнг',
    planCode: 'lead',
    planNameUk: 'Лід',
    baseSeats: 3,
    extraSeats: 0,
    seatsTotal: 3,
    seatsUsed: 3,
    pendingInvites: 0,
    startsAt: ago(60 * 24 * 27),
    endsOn: kyivDay(3),
    daysLeft: 3,
    graceUntil: kyivDay(6),
    revokedAt: null,
    state: 'expiring',
    legacyAlso: false,
    source: 'manual',
    externalRef: null,
    note: 'оплата в Telegram, 30 днів',
    grantedBy: USER_ID,
    createdAt: ago(60 * 24 * 27),
    updatedAt: ago(60 * 24 * 27)
  },
  {
    id: 'tar-2',
    ownerEmail: 'buyer@example.com',
    ownerId: null,
    ownerName: null,
    teamId: null,
    teamName: null,
    planCode: 'solo',
    planNameUk: 'Соло',
    baseSeats: 1,
    extraSeats: 0,
    seatsTotal: 1,
    seatsUsed: 0,
    pendingInvites: 0,
    startsAt: ago(60 * 24),
    endsOn: kyivDay(30),
    daysLeft: 30,
    graceUntil: kyivDay(33),
    revokedAt: null,
    state: 'pending',
    legacyAlso: false,
    source: 'manual',
    externalRef: null,
    note: null,
    grantedBy: USER_ID,
    createdAt: ago(60 * 24),
    updatedAt: ago(60 * 24)
  }
];

const TARIFF_RPC: Record<string, (args: Record<string, unknown>) => unknown> = {
  get_my_space_access: () => spaceAccess(),
  get_team_tariff: () => spaceAccess().teams[0]?.tariff ?? null,
  ack_space_tariff_toast: () => true,
  join_team_workspace_waitlist: () => true,
  request_space_owner_nudge: () => ({
    sent: true,
    nextAllowedAt: new Date(Date.now() + 86_400_000).toISOString()
  }),
  resume_team_catalog_updater: () => true,
  admin_list_space_tariffs: () => ADMIN_TARIFFS,
  admin_list_tariff_plans: () => PLANS,
  admin_list_owner_spaces: () => [
    { teamId: TEAM_ID, name: 'Медіабаїнг', membersUsed: 3, boundTariffId: 'tar-1' }
  ],
  admin_preview_space_tariff: args => ({
    accountExists: args.p_email === 'dev@wishly.local',
    ownerName: null,
    seatsUsed: 0,
    pendingInvites: 0,
    suggestedExtraSeats: 0,
    occupants: []
  }),
  admin_grant_space_tariff: args => ({
    ...ADMIN_TARIFFS[1],
    id: `tar-${Date.now()}`,
    ownerEmail: args.p_email,
    planCode: args.p_plan,
    endsOn: args.p_ends_on,
    extraSeats: args.p_extra_seats
  }),
  admin_update_space_tariff: args => ({
    ...ADMIN_TARIFFS[0],
    planCode: args.p_plan,
    endsOn: args.p_ends_on,
    extraSeats: args.p_extra_seats,
    note: args.p_note
  }),
  admin_extend_space_tariff: () => ({
    ...ADMIN_TARIFFS[0],
    endsOn: kyivDay(33),
    daysLeft: 33,
    state: 'active',
    eventId: 'evt-extend'
  }),
  admin_end_space_tariff: () => ({ ...ADMIN_TARIFFS[0], endsOn: kyivDay(0), daysLeft: 0 }),
  admin_undo_space_tariff_event: () => ADMIN_TARIFFS[0],
  admin_list_space_tariff_events: () => [
    {
      id: 'evt-1',
      tariffId: 'tar-1',
      actorId: USER_ID,
      actorName: 'Роман',
      kind: 'granted',
      before: null,
      after: { planCode: 'lead', endsOn: kyivDay(3), extraSeats: 0 },
      createdAt: ago(60 * 24 * 27),
      undoable: false
    }
  ],
  admin_list_tariff_seats: () =>
    MEMBERS.map((member, index) => ({
      userId: member.user_id,
      invitationId: null,
      name: member.display_name,
      email: member.email,
      role: member.base_role,
      kind: 'member',
      isOwner: index === 0,
      isAdmin: false
    })),
  admin_remove_tariff_member: () => true,
  admin_revoke_tariff_invitation: () => true,
  admin_list_legacy_spaces: () => [
    {
      teamId: '33333333-3333-4333-8333-333333333333',
      name: 'Старий простір',
      ownerEmail: 'old@example.com',
      ownerName: 'Ігор',
      membersUsed: 4
    }
  ],
  admin_list_space_requests: () => [
    {
      userId: 'u-w1',
      email: 'buyer@example.com',
      name: null,
      planInterest: 'solo',
      channel: 'telegram',
      createdAt: ago(48),
      lastContactAt: ago(40),
      handledAt: null,
      adminNote: null,
      hasTariff: true
    },
    {
      userId: 'u-w2',
      email: 'media@example.com',
      name: 'Марія',
      planInterest: 'lead',
      channel: 'email',
      createdAt: ago(12),
      lastContactAt: ago(12),
      handledAt: null,
      adminNote: null,
      hasTariff: false
    }
  ],
  admin_mark_space_request: () => true,
  admin_get_tariff_settings: () => ({
    telegram: 'soty_admin',
    email: 'admin@soty.local',
    legacyRuleEnabled: true,
    legacySpacesRemaining: 1
  }),
  admin_set_tariff_settings: args => ({
    telegram: args.p_telegram,
    email: args.p_email,
    legacyRuleEnabled: args.p_legacy_rule_enabled,
    legacySpacesRemaining: 1
  })
};

Object.assign(RPC, TARIFF_RPC);

/** Everything an unanswered call should look like: empty, not broken. */
function fallback(name: string) {
  console.info(`[mock] rpc ${name} — not taught yet, answering empty`);
  return [];
}

type Result = { data: unknown; error: null };

/**
 * A query builder that accepts any chain and resolves to nothing.
 *
 * `from(...)` is used in a handful of places for tables this seed does not
 * model; a thenable that answers an empty page keeps those screens on their
 * empty state instead of throwing halfway through a render.
 */
function builder(): unknown {
  const result: Result = { data: [], error: null };
  const target = {
    then: (resolve: (value: Result) => unknown) => Promise.resolve(result).then(resolve)
  };
  return new Proxy(target, {
    get(base, property) {
      if (property === 'then') return base.then;
      return () => builder();
    }
  });
}

function channel() {
  const self: Record<string, unknown> = {};
  self.on = () => self;
  self.subscribe = (callback?: (status: string) => void) => {
    callback?.('SUBSCRIBED');
    return self;
  };
  self.unsubscribe = async () => 'ok';
  self.send = async () => 'ok';
  return self;
}

export function createMockSupabaseClient(): unknown {
  return {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      getUser: async () => ({ data: { user: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      refreshSession: async () => ({ data: { session: null }, error: null }),
      signInWithOtp: async () => ({ data: {}, error: null }),
      exchangeCodeForSession: async () => ({ data: {}, error: null }),
      signOut: async () => ({ error: null })
    },
    rpc: async (name: string, args: Record<string, unknown> = {}) => ({
      data: (RPC[name] ?? (() => fallback(name)))(args),
      error: null
    }),
    from: () => builder(),
    functions: { invoke: async () => ({ data: null, error: null }) },
    storage: {
      from: () => ({
        upload: async () => ({ data: null, error: null }),
        download: async () => ({ data: null, error: null }),
        createSignedUrl: async () => ({ data: { signedUrl: '' }, error: null })
      })
    },
    channel,
    removeChannel: () => {},
    removeAllChannels: () => {},
    getChannels: () => []
  };
}
