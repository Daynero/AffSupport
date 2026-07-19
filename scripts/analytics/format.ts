import type {
  CompressorData,
  EventRow,
  FunnelStage,
  OverviewData,
  ResolvedPeriod,
  ToolRow,
  TopListItem,
  TopUsersData,
  UserDetailData,
  UsersData
} from './types.js';

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
  return `\n${title}  ·  ${period.label}\n${'─'.repeat(Math.max(title.length, 24))}`;
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

export function formatOverview(data: OverviewData, period: ResolvedPeriod): string {
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
    topLines('Top agent versions', data.top_agent_versions)
  ].join('\n');
}

export function formatCompressor(data: CompressorData, period: ResolvedPeriod): string {
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
    ])
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

export function formatTools(rows: ToolRow[], period: ResolvedPeriod): string {
  const body = rows.map(r => [
    r.tool,
    num(r.opens),
    num(r.unique_users),
    num(r.starts),
    num(r.completions)
  ]);
  return [
    header('Tools', period),
    body.length ? table(['Tool', 'Opens', 'Users', 'Starts', 'Completions'], body) : '  —'
  ].join('\n');
}

export function formatEvents(rows: EventRow[], period: ResolvedPeriod): string {
  const body = rows.map(r => [r.event_name, num(r.count), num(r.unique_users)]);
  return [
    header('Events', period),
    body.length ? table(['Event', 'Count', 'Unique users'], body) : '  —'
  ].join('\n');
}

export function formatFunnel(stages: FunnelStage[], period: ResolvedPeriod): string {
  const body = stages.map(s => [
    s.stage,
    num(s.users),
    pct(s.conversion_from_previous),
    pct(s.conversion_from_start)
  ]);
  return [
    header('Compressor funnel', period),
    table(['Stage', 'Users', 'From previous', 'From start'], body)
  ].join('\n');
}
