import type {
  AuditData,
  CohortsData,
  CompressorData,
  DeliveryLag,
  ErrorsData,
  EventsData,
  FeaturesData,
  FrictionData,
  FunnelData,
  InspectData,
  InvestigateData,
  JournalResult,
  JournalRecordRow,
  JourneyEvent,
  OverviewData,
  ResolvedPeriod,
  RetentionMetric,
  StagesData,
  TeamWorkspaceData,
  ToolsData,
  TopListItem,
  TopUsersData,
  UserDetailData,
  UsersData,
  SyncData,
  SyncJobRow,
  ConnectionData
} from './types.js';
import { isUnsupported } from './types.js';

/** Aggregating commands carry `delivery_lag_ms`; formatters accept it as optional so a bare query result still prints. */
type WithLag = { delivery_lag_ms?: DeliveryLag };
type Loose<T extends { delivery_lag_ms: DeliveryLag }> = Omit<T, 'delivery_lag_ms'> & WithLag;

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 2)} ${units[exponent]}`;
}

function pct(value: number | null): string {
  return value == null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function num(value: number | null | undefined): string {
  return value == null ? '—' : value.toLocaleString('en-US');
}

function header(title: string, period: ResolvedPeriod): string {
  const pinned = period.as_of ? `  ·  as of ${period.as_of}` : '';
  return `\n${title}  ·  ${period.label}${pinned}\n${'─'.repeat(Math.max(title.length, 24))}`;
}

function ms(value: number | null | undefined): string {
  return value == null ? '—' : value < 10_000 ? `${value} ms` : `${(value / 1000).toFixed(1)}s`;
}

/** One line every aggregating command ends with (031 FR-055). */
function lagLine(lag: DeliveryLag | undefined): string[] {
  if (!lag) return [];
  return [
    '',
    `  Delivery lag (created_at − occurred_at): p50 ${ms(lag.p50)} · p95 ${ms(lag.p95)} · ${num(lag.samples)} samples`
  ];
}

function kv(rows: Array<[string, string]>): string {
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${k.padEnd(width)}   ${v}`).join('\n');
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    '  ' + cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('   ');
  return [line(headers), '  ' + widths.map(w => '─'.repeat(w)).join('   '), ...rows.map(line)].join(
    '\n'
  );
}

function topLines(label: string, items: TopListItem[]): string {
  if (!items.length) return `  ${label}: —`;
  return `  ${label}: ` + items.map(i => `${i.name} (${num(i.count)})`).join(', ');
}

export function formatOverview(data: OverviewData & WithLag, period: ResolvedPeriod): string {
  return [
    header('Overview', period),
    kv([
      ['Total users', num(data.total_users)],
      ['New users', num(data.new_users)],
      ['Active users', num(data.active_users)],
      ['Sessions', num(data.sessions)],
      ['Total events', num(data.total_events)],
      ['Tool opens', num(data.tool_opens)],
      ['Compression batches', num(data.compression_batches)],
      ['Videos added', num(data.videos_added)],
      ['Videos compressed', num(data.videos_compressed)],
      ['Compressions failed', num(data.compressions_failed)]
    ]),
    '',
    topLines('Top locales', data.top_locales),
    topLines('Top platforms', data.top_platforms),
    topLines('Top app versions', data.top_app_versions),
    topLines('Top agent versions', data.top_agent_versions),
    ...lagLine(data.delivery_lag_ms)
  ].join('\n');
}

export function formatCompressor(data: CompressorData & WithLag, period: ResolvedPeriod): string {
  return [
    header('Compressor', period),
    kv([
      ['Unique users', num(data.unique_users)],
      ['Tool opens', num(data.tool_opens)],
      ['Videos added', num(data.videos_added)],
      ['Batches', num(data.batch_count)],
      ['Compression started', num(data.compression_started)],
      ['Compression completed', num(data.compression_completed)],
      ['Compression failed', num(data.compression_failed)],
      ['Started without completion', num(data.started_without_completion)],
      ['Total videos compressed', num(data.total_videos_compressed)],
      [
        'Average batch size',
        data.average_batch_size == null ? '—' : String(data.average_batch_size)
      ],
      ['Success rate', pct(data.success_rate)],
      ['Total input', formatBytes(data.total_input_bytes)],
      ['Total output', formatBytes(data.total_output_bytes)],
      ['Saved', formatBytes(data.saved_bytes)],
      [
        'Average saving',
        data.average_saving_percent == null ? '—' : `${data.average_saving_percent.toFixed(1)}%`
      ],
      [
        'Average duration',
        data.average_duration_ms == null ? '—' : `${(data.average_duration_ms / 1000).toFixed(1)}s`
      ]
    ]),
    ...lagLine(data.delivery_lag_ms)
  ].join('\n');
}

export function formatUsers(data: UsersData, period: ResolvedPeriod): string {
  const rows = data.last_active.map(u => [
    u.email ?? u.id,
    u.display_name ?? '—',
    u.last_seen_at ? new Date(u.last_seen_at).toISOString().replace('T', ' ').slice(0, 16) : '—'
  ]);
  return [
    header('Users', period),
    kv([
      ['Total users', num(data.total_users)],
      ['New users', num(data.new_users)],
      ['Active users', num(data.active_users)]
    ]),
    '',
    '  Most recently active:',
    rows.length ? table(['Email', 'Name', 'Last seen (UTC)'], rows) : '  —'
  ].join('\n');
}

export function formatTopUsers(data: TopUsersData, period: ResolvedPeriod): string {
  const metric = data.by === 'compressions' ? 'Compressions' : 'Events';
  const rows = data.users.map((u, i) => [
    String(i + 1),
    u.email ?? u.id,
    u.display_name ?? '—',
    num((data.by === 'compressions' ? u.compressions : u.event_count) ?? 0)
  ]);
  return [
    header(`Top users by ${data.by}`, period),
    rows.length ? table(['#', 'Email', 'Name', metric], rows) : '  —'
  ].join('\n');
}

export function formatUserDetail(data: UserDetailData): string {
  const iso = (v: string | null) =>
    v ? new Date(v).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
  const recent = data.recent_events.map(e => [
    iso(e.created_at),
    e.event_name,
    e.tool ?? '—',
    JSON.stringify(e.properties)
  ]);
  return [
    `\nUser  ·  ${data.email ?? data.id}\n${'─'.repeat(32)}`,
    kv([
      ['User id', data.id],
      ['Email', data.email ?? '—'],
      ['Display name', data.display_name ?? '—'],
      ['Language / plan', `${data.language ?? '—'} / ${data.plan ?? '—'}`],
      ['Account status', data.account_status ?? '—'],
      ['Registered', iso(data.registered_at)],
      ['Last login', iso(data.last_login_at)],
      ['Last activity', iso(data.last_seen_at)],
      ['Sessions', num(data.sessions)],
      ['Total events', num(data.total_events)],
      ['Compressions completed', num(data.compressions_completed)],
      ['Videos compressed', num(data.videos_compressed)]
    ]),
    '',
    topLines('Tool usage', data.tool_usage),
    '',
    '  Recent events:',
    recent.length ? table(['When', 'Event', 'Tool', 'Properties'], recent) : '  —'
  ].join('\n');
}

export function formatTools(data: Loose<ToolsData>, period: ResolvedPeriod): string {
  const body = data.tools.map(r => [
    r.tool,
    num(r.opens),
    num(r.unique_users),
    num(r.inputs),
    num(r.starts),
    num(r.completions),
    num(r.failures),
    num(r.cancellations)
  ]);
  return [
    header('Tools', period),
    body.length
      ? table(
          ['Tool', 'Opens', 'Users', 'Inputs', 'Starts', 'Completions', 'Failures', 'Cancelled'],
          body
        )
      : '  —',
    ...lagLine(data.delivery_lag_ms)
  ].join('\n');
}

export function formatEvents(data: Loose<EventsData>, period: ResolvedPeriod): string {
  const body = data.events.map(r => [r.event_name, num(r.count), num(r.unique_users)]);
  return [
    header('Events', period),
    body.length ? table(['Event', 'Count', 'Unique users'], body) : '  —',
    ...lagLine(data.delivery_lag_ms)
  ].join('\n');
}

export function formatFunnel(data: Loose<FunnelData>, period: ResolvedPeriod): string {
  const body = data.stages.map(s => [
    s.stage,
    num(s.users),
    pct(s.conversion_from_previous),
    pct(s.conversion_from_start)
  ]);
  return [
    header('Compressor funnel', period),
    table(['Stage', 'Users', 'From previous', 'From start'], body),
    ...lagLine(data.delivery_lag_ms)
  ].join('\n');
}

export function formatStages(
  title: string,
  data: Loose<StagesData>,
  period: ResolvedPeriod
): string {
  return [
    header(title, period),
    table(
      ['Stage', 'Events', 'Users'],
      data.stages.map(r =>
        isUnsupported(r)
          ? [r.stage, 'unsupported by producer', '—']
          : [r.stage, num(r.events), num(r.users)]
      )
    ),
    ...lagLine(data.delivery_lag_ms)
  ].join('\n');
}

export function formatErrors(data: Loose<ErrorsData>, period: ResolvedPeriod): string {
  return [
    header('Errors', period),
    data.clusters.length
      ? table(
          ['Code', 'Stage', 'Fingerprint', 'Tool', 'Local app', 'Count', 'Users', 'Recovered'],
          data.clusters.map(r => [
            r.error_code,
            r.error_stage,
            r.error_fingerprint,
            r.tool,
            r.local_app_version,
            num(r.occurrences),
            num(r.users),
            num(r.recovered)
          ])
        )
      : '  —',
    ...lagLine(data.delivery_lag_ms)
  ].join('\n');
}

export function formatFriction(data: Loose<FrictionData>, period: ResolvedPeriod): string {
  return [
    header('Friction', period),
    data.signals.length
      ? table(
          ['Signal', 'Users', 'Sessions'],
          data.signals.map(r =>
            isUnsupported(r)
              ? [r.signal, 'unsupported by producer', '—']
              : [r.signal, num(r.users), num(r.sessions)]
          )
        )
      : '  —',
    ...lagLine(data.delivery_lag_ms)
  ].join('\n');
}

export function formatFeatures(data: Loose<FeaturesData>, period: ResolvedPeriod): string {
  return [
    header('Features', period),
    data.features.length
      ? table(
          ['Feature', 'Seen', 'Interactions', 'Successes', 'Users'],
          data.features.map(r => [
            r.feature,
            num(r.impressions),
            num(r.interactions),
            num(r.successful_operations),
            num(r.unique_users)
          ])
        )
      : '  —',
    ...(data.unsupported.length
      ? [
          '',
          `  Unsupported by producer (declared, never emitted): ${data.unsupported.map(s => s.signal).join(', ')}`
        ]
      : []),
    ...lagLine(data.delivery_lag_ms)
  ].join('\n');
}

export function formatJourney(
  title: string,
  rows: JourneyEvent[],
  period?: ResolvedPeriod,
  lag?: DeliveryLag
): string {
  const scope = period ? `  ·  ${period.label}${period.as_of ? ` as of ${period.as_of}` : ''}` : '';
  const body = rows.map(r => [
    new Date(r.occurred_at).toISOString().replace('T', ' ').slice(0, 19),
    r.event_name,
    r.tool ?? '—',
    r.local_app_version ?? '—',
    r.run_id ?? '—',
    JSON.stringify(r.properties)
  ]);
  return [
    `\n${title}${scope}\n${'─'.repeat(32)}`,
    body.length ? table(['When (UTC)', 'Event', 'Tool', 'App', 'Run', 'Properties'], body) : '  —',
    ...lagLine(lag)
  ].join('\n');
}

export function formatCohorts(data: Loose<CohortsData>, period: ResolvedPeriod): string {
  return [
    header(`Cohorts by ${data.cohort_by}`, period),
    data.cohorts.length
      ? table(
          ['Cohort', 'Users', 'Events', 'Successes', 'Failures'],
          data.cohorts.map(r => [
            r.cohort,
            num(r.users),
            num(r.events),
            num(r.successes),
            num(r.failures)
          ])
        )
      : '  —',
    `  ${data.note}`,
    ...lagLine(data.delivery_lag_ms)
  ].join('\n');
}

export function formatRetention(data: RetentionMetric & WithLag, period: ResolvedPeriod): string {
  return [
    header('Retention', period),
    kv([
      ['Registered users', num(data.registered_users)],
      ['Active after 1 day', num(data.active_after_1d)],
      ['Active after 7 days', num(data.active_after_7d)],
      ['Active after 30 days', num(data.active_after_30d)]
    ]),
    ...lagLine(data.delivery_lag_ms)
  ].join('\n');
}

export function formatTeamWorkspace(
  data: TeamWorkspaceData & WithLag,
  period: ResolvedPeriod
): string {
  const cohort = (label: string, value: TeamWorkspaceData['sc001']) => [
    label,
    num(value.attempts),
    num(value.successes),
    pct(value.success_rate),
    value.status
  ];
  return [
    header('Team workspace success criteria', period),
    table(
      ['Criterion', 'Attempts', 'Successes', 'Rate', 'Status'],
      [cohort('SC-001', data.sc001), cohort('SC-005', data.sc005)]
    ),
    '',
    '  SC-009 · each root-relative week stands alone:',
    table(
      ['Week', 'Eligible', 'Activated', 'Rate', 'Status'],
      data.sc009.windows.map(window => [
        String(window.window_index),
        num(window.denominator),
        num(window.numerator),
        pct(window.rate),
        window.status
      ])
    ),
    `  All four pass: ${data.sc009.all_windows_pass == null ? 'insufficient' : data.sc009.all_windows_pass ? 'yes' : 'no'}`,
    '',
    '  Storage (011) · events in the period:',
    table(
      ['Connected', 'Indexed', 'Previews ready', 'Needed attention'],
      [
        [
          num(data.storage.storage_connected),
          num(data.storage.index_completed),
          num(data.storage.previews_ready),
          num(data.storage.attention)
        ]
      ]
    ),
    ...(data.storage.attention_reasons.length > 0
      ? [
          table(
            ['Attention reason', 'Count'],
            data.storage.attention_reasons.map(row => [row.reason, num(row.count)])
          )
        ]
      : []),
    ...lagLine(data.delivery_lag_ms)
  ].join('\n');
}

function age(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function waitsFor(row: SyncJobRow): string {
  if (row.replay_after === null) return '—';
  const feed = row.canonical_state
    ? `${row.canonical_state}${row.canonical_error_code ? '/' + row.canonical_error_code : ''}`
    : 'no feed';
  return `seq ${row.replay_after} (feed ${feed}; confirmed ${row.confirmed_sequence ?? 0})`;
}

export function formatSyncJobs(data: SyncData, period: ResolvedPeriod, now = Date.now()): string {
  const sections = data.connections.map(connection => {
    const feed = connection.canonical
      ? `${connection.canonical.state}${connection.canonical.error_code ? ' / ' + connection.canonical.error_code : ''}` +
        ` · next ${age(connection.canonical.next_attempt_at, now)} · confirmed seq ${num(connection.canonical.confirmed_sequence)}` +
        ` · recoveries ${num(connection.canonical.recovery_count)}`
      : 'none';
    const body = connection.jobs.map(row => [
      row.job_id.slice(0, 8),
      row.job_kind,
      row.phase,
      row.state,
      age(row.created_at, now),
      `${age(row.last_progress_at, now)} ago · ${num(row.folders_done)} folders`,
      `${num(row.attempts)}/${num(row.lease_lost_count)}`,
      waitsFor(row),
      row.last_error_code
        ? `${row.last_error_code}${row.error_detail ? ' (' + row.error_detail + ')' : ''}`
        : '—'
    ]);
    return [
      `\nConnection ${connection.connection_id.slice(0, 8)} · ${connection.connection_state} · feed: ${feed}`,
      body.length
        ? table(
            ['Job', 'Kind', 'Phase', 'State', 'Age', 'Progress', 'Att/Lost', 'Waits for', 'Error'],
            body
          )
        : '  —'
    ].join('\n');
  });
  return [header(`Sync jobs · team ${data.team_id.slice(0, 8)}`, period), ...sections].join('\n');
}

export function formatConnection(data: ConnectionData & WithLag, period: ResolvedPeriod): string {
  const seconds = (value: number | null) => (value == null ? '—' : `${(value / 1000).toFixed(1)}s`);
  return [
    header('Connection', period),
    kv([
      ['Users with a lost link', num(data.users_with_loss)],
      ['Links lost', num(data.losses)],
      ['Links recovered', num(data.recoveries)],
      [
        'Time to recover (p50 / p95)',
        `${seconds(data.recovery_ms.p50)} / ${seconds(data.recovery_ms.p95)} · ${num(data.recovery_ms.samples)} samples`
      ],
      [
        'Recovery mode',
        `auto ${num(data.recovery_mode.auto)} · manual ${num(data.recovery_mode.manual)} · local copy ${num(data.recovery_mode.local_copy)}`
      ],
      [
        'Inconsistencies (stream open, request refused)',
        `${num(data.inconsistencies.events)} events · ${num(data.inconsistencies.users)} users`
      ]
    ]),
    '',
    '  Failed checks by reason:',
    data.failed_checks_by_reason.length
      ? table(
          ['Reason', 'Events', 'Users'],
          data.failed_checks_by_reason.map(row => [row.reason, num(row.events), num(row.users)])
        )
      : '  —',
    '',
    '  Blocked by the browser:',
    data.blocked_by_browser.length
      ? table(
          ['Browser', 'Users'],
          data.blocked_by_browser.map(row => [row.browser_family, num(row.users)])
        )
      : '  —',
    '',
    '  Page origin:',
    data.origins.length
      ? table(
          ['Origin', 'Users', 'Events'],
          data.origins.map(row => [row.link_origin, num(row.users), num(row.events)])
        )
      : '  —',
    '',
    `  Coverage: ${num(data.coverage.web_builds_with_link_events)} web build(s) emit link events.`,
    data.coverage.web_builds_without.length
      ? `  Without link events (${data.coverage.note}): ${data.coverage.web_builds_without.join(', ')}`
      : '  Every web build seen in the period emits link events.',
    ...lagLine(data.delivery_lag_ms)
  ].join('\n');
}

/* ---------------------------------------------------------------------------
 * 031 — `audit` and `inspect`.
 * ------------------------------------------------------------------------- */

export function formatAudit(data: AuditData, period: ResolvedPeriod, written: string[]): string {
  const rows = data.capabilities.map(c => [
    c.id,
    c.status,
    c.producer_status,
    num(c.samples),
    num(c.orphan_starts),
    c.missing.join(', ') || '—'
  ]);
  const findings = data.findings.map(f => [
    f.severity,
    f.capability,
    f.status,
    f.missing.join(', ') || '—',
    f.id.slice(0, 12)
  ]);
  return [
    header('Coverage audit', period),
    `  ${num(data.registry_size)} capabilities · covered ${num(data.summary.covered)} · partial ${num(data.summary.partial)} · uncovered ${num(data.summary.uncovered)} · declared but never emitted ${num(data.summary.declared_but_never_emitted)}`,
    '',
    table(['Capability', 'Status', 'Producer', 'Starts', 'Orphans', 'Missing'], rows),
    '',
    '  Unknown error codes / stages by tool:',
    data.unknown_codes.length
      ? table(
          ['Tool', 'Errors', 'No code', 'No stage'],
          data.unknown_codes.map(r => [
            r.tool,
            num(r.errors),
            num(r.unknown_code),
            num(r.unknown_stage)
          ])
        )
      : '  —',
    '',
    `  Delivery: ${num(data.delivery.reports)} report(s) · rejected ${num(data.delivery.rejected)} · evicted ${num(data.delivery.evicted)} · expired ${num(data.delivery.expired)} (${data.delivery.note})`,
    data.uncovered_builds.length
      ? `  Web builds without link events: ${data.uncovered_builds.join(', ')}`
      : '  Every web build seen emits link events.',
    '',
    '  Findings:',
    findings.length
      ? table(['Severity', 'Capability', 'Status', 'Missing', 'Id'], findings)
      : '  —',
    ...lagLine(data.delivery_lag_ms),
    ...(data.schema.note ? ['', `  Schema: ${data.schema.note}`] : []),
    ...(written.length ? ['', `  Written: ${written.join(', ')}`] : [])
  ].join('\n');
}

export function formatInspect(data: InspectData): string {
  const schemaLines = data.schema
    ? ['', `  Schema: ${data.schema.note}`, `  Missing: ${data.schema.missing.join(', ')}`]
    : [];
  if (!data.found) {
    return [
      `\nInspect · ${data.id}\n${'─'.repeat(32)}\n  No event carries this id (as run_id, flow_id, attempt_id or workflow_id).`,
      ...schemaLines
    ].join('\n');
  }
  const body = data.events.map(r => [
    new Date(r.occurred_at).toISOString().replace('T', ' ').slice(0, 19),
    r.event_name,
    r.tool ?? '—',
    r.local_app_version ?? '—',
    JSON.stringify(r.properties)
  ]);
  return [
    `\nInspect · ${data.id}\n${'─'.repeat(32)}`,
    kv([
      ['Matched by', data.matched_by.join(', ')],
      ['Capability', data.capability ?? '— (no registry capability matches these events)'],
      ['Tool', data.tool ?? '—'],
      ['Stages expected', data.stages.expected.join(' → ') || '—'],
      ['Stages observed', data.stages.observed.join(' → ') || '—'],
      ['Stages missing', data.stages.missing.join(', ') || '—'],
      ['Last proven stage', data.last_proven_stage ?? '—'],
      [
        'Terminal',
        data.terminal ? `${data.terminal.event} (${data.terminal.outcome})` : 'none observed'
      ],
      ['First / last seen', `${data.first_seen_at ?? '—'} / ${data.last_seen_at ?? '—'}`],
      [
        'Agent seen',
        `app ${data.agent.local_app_versions.join(',') || '—'} · build ${data.agent.local_app_builds.join(',') || '—'} · web ${data.agent.web_build_ids.join(',') || '—'} · ${data.agent.platforms.join(',') || '—'}`
      ],
      [
        'Agent run',
        `${data.agent.agent_instance_ids.join(',') || '—'} · ${data.agent.agent_platforms.join(',') || '—'}`
      ]
    ]),
    ...lagLine(data.delivery_lag_ms),
    ...schemaLines,
    '',
    table(['When (UTC)', 'Event', 'Tool', 'App', 'Properties'], body)
  ].join('\n');
}

/* ---------------------------------------------------------------------------
 * 033 — `journal` and `investigate`
 * ------------------------------------------------------------------------- */

function journalLine(record: JournalRecordRow): string[] {
  return [
    record.recorded_at.replace('T', ' ').slice(0, 19),
    `${record.category}:${record.code}`,
    String(record.seq),
    record.agent_instance_id.slice(0, 8),
    ms(record.lag_ms),
    JSON.stringify(record.props)
  ];
}

const JOURNAL_HEADERS = ['Recorded (UTC)', 'Record', 'Seq', 'Agent run', 'Lag', 'Props'];

export function formatJournal(data: JournalResult, period: ResolvedPeriod): string {
  if (!data.available) {
    return [
      header('Agent journal', period),
      '  Not available: this database has no agent_journal_records table visible to this role',
      '  (migration 20261124100000 not applied). Nothing could be read; that is not "no records".'
    ].join('\n');
  }
  const subject =
    data.subject.kind === 'user'
      ? `user ${data.subject.user_id ?? '—'}`
      : data.subject.kind === 'installation'
        ? `installation ${data.subject.installation_id ?? '—'}`
        : `agent run ${data.subject.agent_instance_id ?? '—'}`;
  return [
    header(`Agent journal · ${subject}`, period),
    `  ${num(data.records.length)} of ${num(data.total)} record(s)${data.truncated ? ' (newest shown; raise --limit)' : ''} · lag p50 ${ms(data.lag_ms.p50)} · p95 ${ms(data.lag_ms.p95)}`,
    '',
    data.records.length
      ? table(JOURNAL_HEADERS, data.records.map(journalLine))
      : '  No journal record reached the database for this subject in the period.'
  ].join('\n');
}

export function formatInvestigate(data: InvestigateData, period: ResolvedPeriod): string {
  const env = data.environment;
  const list = (values: string[]) => values.join(', ') || '—';
  const lines: string[] = [
    header(
      `Investigate · ${data.subject.kind} ${data.subject.id ?? data.subject.user_id ?? ''}`,
      period
    ),
    kv([
      ['User', data.subject.user_id ?? '— (anonymous installation)'],
      ['Installations', list(data.subject.installation_ids)],
      ['Agent runs', list(data.subject.agent_instance_ids)],
      ['Web builds', list(env.web_builds)],
      [
        'Local app',
        `${list(env.local_app_versions)} (newest seen ${env.newest_local_app_version_seen ?? '—'})`
      ],
      [
        'Platforms',
        `agent ${list(env.agent_platforms)} · browser ${list(env.browser_platforms)} · ${list(env.browser_families)}`
      ],
      ['Page origin', list(env.link_origins)],
      ['First / last seen', `${env.first_seen_at ?? '—'} / ${env.last_seen_at ?? '—'}`],
      ['Sessions', num(data.sessions.count)],
      ['Events / journal', `${num(data.coverage.events)} / ${num(data.coverage.journal_records)}`],
      ['Schema missing', list(data.schema.missing)]
    ]),
    '',
    'Findings'
  ];
  if (data.findings.length === 0) lines.push('  None.');
  for (const finding of data.findings) {
    lines.push(`  [${finding.severity} · ${finding.kind}] ${finding.title}`);
    if (finding.fingerprint) lines.push(`      fingerprint ${finding.fingerprint}`);
    for (const location of finding.code_locations) {
      lines.push(`      ${location.matched}: ${location.files.join(', ')}`);
      lines.push(`        check: ${location.check}`);
    }
    if (finding.evidence.length)
      lines.push(
        `      evidence ${finding.evidence.slice(0, 6).join(', ')}${finding.evidence.length > 6 ? ', …' : ''}`
      );
    lines.push(`      next: ${finding.next_step}`);
  }

  lines.push('', 'Operations (failed, unfinished, cancelled)');
  if (data.operations.length === 0) lines.push('  None.');
  else
    lines.push(
      table(
        ['Id', 'Tool', 'Status', 'Chain', 'Code', 'Last seen'],
        data.operations.map(op => [
          op.id,
          op.tool ?? '—',
          op.status,
          op.chain.map(step => step.event).join(' → '),
          op.fingerprint ?? op.error_code ?? '—',
          op.last_seen_at ?? '—'
        ])
      )
    );

  const link = data.link;
  lines.push(
    '',
    'Link',
    `  losses ${link.losses} · unrecovered ${link.unrecovered.length} · recoveries ${link.recoveries.length} (${link.recoveries.map(r => `${r.mode} ${ms(r.duration_ms)}`).join(', ') || '—'}) · inconsistencies ${link.inconsistencies} · pairing rejected ${link.pairing_rejected}`,
    `  failed checks: ${link.failed_checks_by_reason.map(r => `${r.reason} (${r.events})`).join(', ') || '—'}`
  );

  lines.push('', 'Errors');
  if (data.errors.length === 0) lines.push('  None.');
  else
    lines.push(
      table(
        ['Fingerprint', 'Count', 'Last seen'],
        data.errors.map(e => [e.fingerprint, String(e.occurrences), e.last_seen_at])
      )
    );

  lines.push('', 'Agent journal around failures (±2 min)');
  if (data.journal_around_failures.length === 0) lines.push('  None.');
  for (const window of data.journal_around_failures) {
    lines.push(`  ${window.failure.kind} ${window.failure.ref} at ${window.failure.at}`);
    lines.push(table(JOURNAL_HEADERS, window.records.map(journalLine)));
  }

  lines.push('', `Sync (${data.sync.status})`);
  for (const connection of data.sync.connections) {
    lines.push(
      `  ${connection.connection_id} ${connection.connection_state}: ${connection.jobs} job(s) ${JSON.stringify(connection.states)} errors ${list(connection.error_codes)}`
    );
  }

  lines.push('', 'Blind spots');
  if (data.coverage.blind_spots.length === 0) lines.push('  None found.');
  for (const spot of data.coverage.blind_spots) {
    lines.push(
      `  ${spot.kind}: ${spot.detail}${spot.values.length ? ` (${spot.values.join(', ')})` : ''}`
    );
  }
  return lines.join('\n');
}
