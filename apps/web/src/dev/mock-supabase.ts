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
  can_access_team_workspace: () => true,
  list_my_invitations: () => [],
  list_my_teams: () => TEAMS,
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
