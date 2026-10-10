/**
 * 031 — Capability coverage registry: the single source of truth for what the
 * analytics CLI expects every product capability to emit, and whether a
 * producer for each signal exists today.
 *
 * `audit` compares this registry with the events observed in a period;
 * `inspect` reconstructs one attempt's stages from it; the aggregate commands
 * (`friction`, `updates`, `onboarding`, `features`, `cohorts`) read it to know
 * which signals they may compute from and which they must report as
 * `unsupported_by_producer`.
 *
 * Producer status vocabulary:
 * - `emitted`: a call site in `apps/web/src` (or `packages/shared`) tracks the event today.
 * - `pending_producer`: a producer is planned but has not landed (031's own T005/T008/
 *   T009/T010 producers have). The CLI must not compute from it until it lands.
 * - `unsupported_by_producer`: the name is declared in the event contract but nothing
 *   emits it and nothing is planned (legacy onboarding/pairing names, agent-side update
 *   stages the browser cannot observe, metadata-only team surfaces).
 *
 * Shape follows `specs/031-platform-autoanalytics/data-model.md` ("Coverage registry"),
 * extended with `stageEvents` (which events prove which stage — `inspect` needs it) and
 * per-signal `producerStatus` overrides. Nothing here touches the database.
 */
import type { AnalyticsEventName } from '../../apps/web/src/analytics/events.js';

/**
 * Event names this registry references before `apps/web/src/analytics/events.ts`
 * declares them (the producer work is concurrent). The registry test lets exactly
 * these names be absent from `analyticsEventNames`. Empty since 031 T008/T009 landed
 * `tool_ready`, `analytics_delivery_report` and `stitch_completed|failed`.
 */
export const PENDING_PRODUCER_EVENTS = [] as const;
export type PendingProducerEvent = (typeof PENDING_PRODUCER_EVENTS)[number];

export type RegistryEventName = AnalyticsEventName | PendingProducerEvent;

export type ProducerStatus = 'emitted' | 'pending_producer' | 'unsupported_by_producer';
export type Correlation = 'run_id' | 'flow_id' | 'attempt_id' | 'workflow_id' | 'none';
export type CapabilityTool =
  | 'compressor'
  | 'stitcher'
  | 'transcription'
  | 'landing-optimizer'
  | 'landing-preview'
  | 'two-factor'
  | 'team'
  | 'link'
  | 'update'
  | 'onboarding'
  | 'analytics';
export type CapabilityPlatform = 'macos' | 'windows';

export interface CapabilitySignal {
  event: RegistryEventName;
  /** Which identifier correlates this signal with the rest of the attempt. */
  correlate: Correlation;
  /** Overrides the capability's `producerStatus` for this one signal. */
  producerStatus?: ProducerStatus;
  /** Optional `properties` discriminator when one event name serves several capabilities. */
  outcome?: string;
}

export interface Capability {
  /** `tool.operation`, e.g. `compressor.run`. */
  id: string;
  tool: CapabilityTool;
  /** Human title for tables. */
  title: string;
  /** Ordered stages of the journey; the last one is the terminal stage. */
  stages: string[];
  /** Which events prove a stage. A stage with no entry is unobservable or informational. */
  stageEvents: Partial<Record<string, RegistryEventName[]>>;
  start: CapabilitySignal[];
  terminal: CapabilitySignal[];
  readiness?: CapabilitySignal;
  error?: CapabilitySignal;
  platforms: CapabilityPlatform[];
  /** Stages that cannot be observed from analytics by design; said out loud, never counted. */
  unobservable: string[];
  /** Default producer status for every signal of this capability. */
  producerStatus: ProducerStatus;
  /** Where the truth lives. `authoritative_table` means a database view, not the event stream. */
  source: 'events' | 'authoritative_table';
  /** First web build that emits the signals, when known. */
  sinceWebBuild?: string;
  /** When `tool` is a column filter (events shared by several tools), the `tool` column value. */
  toolColumn?: string;
  note?: string;
}

const BOTH: CapabilityPlatform[] = ['macos', 'windows'];

/** Web build that shipped the 032 link lifecycle; the current PRODUCT_VERSION at that time. */
const LINK_SINCE_WEB_BUILD = '1.2.5';

export const COVERAGE_REGISTRY: readonly Capability[] = [
  /* --------------------------------------------------------------------- *
   * Local tools
   * --------------------------------------------------------------------- */
  {
    id: 'compressor.run',
    tool: 'compressor',
    toolColumn: 'compressor',
    title: 'Compressor · compress a batch',
    stages: ['open', 'ready', 'input_add', 'estimate', 'start', 'terminal', 'result_visible'],
    stageEvents: {
      open: ['tool_opened'],
      ready: ['tool_ready'],
      input_add: ['videos_added'],
      estimate: ['estimate_started', 'estimate_completed', 'estimate_failed'],
      start: ['compression_batch_started', 'compression_started'],
      terminal: ['compression_completed', 'compression_failed', 'operation_cancelled']
    },
    start: [{ event: 'compression_started', correlate: 'run_id' }],
    terminal: [
      { event: 'compression_completed', correlate: 'run_id' },
      { event: 'compression_failed', correlate: 'run_id' },
      { event: 'operation_cancelled', correlate: 'run_id' }
    ],
    readiness: { event: 'tool_ready', correlate: 'none' },
    error: { event: 'error_occurred', correlate: 'run_id' },
    platforms: BOTH,
    unobservable: ['result file opened outside Soty'],
    producerStatus: 'emitted',
    source: 'events'
  },
  {
    id: 'compressor.estimate',
    tool: 'compressor',
    toolColumn: 'compressor',
    title: 'Compressor · size estimate',
    stages: ['start', 'terminal'],
    stageEvents: {
      start: ['estimate_started'],
      terminal: ['estimate_completed', 'estimate_failed']
    },
    start: [{ event: 'estimate_started', correlate: 'run_id' }],
    terminal: [
      { event: 'estimate_completed', correlate: 'run_id' },
      { event: 'estimate_failed', correlate: 'run_id' }
    ],
    platforms: BOTH,
    unobservable: [],
    producerStatus: 'emitted',
    source: 'events',
    note: 'estimate_failed carries error_code only when the agent message already is a code; otherwise `unknown`.'
  },
  {
    id: 'stitcher.input',
    tool: 'stitcher',
    toolColumn: 'stitcher',
    title: 'Stitcher · add inputs (picker, drop, upload)',
    stages: ['open', 'ready', 'picker_or_drop', 'input_add'],
    stageEvents: {
      open: ['tool_opened'],
      ready: ['tool_ready'],
      picker_or_drop: ['operation_stage_started', 'operation_stage_completed'],
      input_add: ['input_add_completed']
    },
    start: [{ event: 'operation_stage_started', correlate: 'flow_id' }],
    terminal: [
      { event: 'operation_stage_completed', correlate: 'flow_id' },
      { event: 'input_add_completed', correlate: 'none' }
    ],
    readiness: { event: 'tool_ready', correlate: 'none' },
    error: { event: 'error_occurred', correlate: 'flow_id' },
    platforms: BOTH,
    unobservable: ['native picker dialog visibility (hidden/foreground)'],
    producerStatus: 'emitted',
    source: 'events'
  },
  {
    id: 'stitcher.run',
    tool: 'stitcher',
    toolColumn: 'stitcher',
    title: 'Stitcher · stitch a job',
    stages: ['open', 'ready', 'input_add', 'start', 'terminal'],
    stageEvents: {
      open: ['tool_opened'],
      ready: ['tool_ready'],
      input_add: ['input_add_completed'],
      start: ['stitch_started', 'operation_started'],
      terminal: [
        'stitch_completed',
        'stitch_failed',
        'operation_completed',
        'operation_failed',
        'operation_cancelled'
      ]
    },
    start: [
      { event: 'stitch_started', correlate: 'run_id' },
      { event: 'operation_started', correlate: 'run_id' }
    ],
    terminal: [
      { event: 'stitch_completed', correlate: 'run_id' },
      { event: 'stitch_failed', correlate: 'run_id' },
      { event: 'operation_completed', correlate: 'run_id' },
      { event: 'operation_failed', correlate: 'run_id' },
      { event: 'operation_cancelled', correlate: 'run_id' }
    ],
    readiness: { event: 'tool_ready', correlate: 'none' },
    error: { event: 'error_occurred', correlate: 'run_id' },
    platforms: BOTH,
    unobservable: ['stitched file opened outside Soty'],
    producerStatus: 'emitted',
    source: 'events',
    note: 'stitch_started is one per accepted job; stitch_* and operation_* share the job id as run_id (031 T008).'
  },
  {
    id: 'transcription.run',
    tool: 'transcription',
    toolColumn: 'transcription',
    title: 'Transcription · transcribe files',
    stages: ['open', 'ready', 'input_add', 'start', 'terminal'],
    stageEvents: {
      open: ['tool_opened'],
      ready: ['tool_ready'],
      input_add: ['input_add_completed'],
      start: ['operation_started'],
      terminal: ['operation_completed', 'operation_failed', 'operation_cancelled']
    },
    start: [{ event: 'operation_started', correlate: 'run_id' }],
    terminal: [
      { event: 'operation_completed', correlate: 'run_id' },
      { event: 'operation_failed', correlate: 'run_id' },
      { event: 'operation_cancelled', correlate: 'run_id' }
    ],
    readiness: { event: 'tool_ready', correlate: 'none' },
    error: { event: 'error_occurred', correlate: 'run_id' },
    platforms: BOTH,
    unobservable: ['transcript text (never collected)'],
    producerStatus: 'emitted',
    source: 'events',
    note: 'operation_* is one event per job with the job id as run_id (031 T008).'
  },
  {
    id: 'transcription.translate',
    tool: 'transcription',
    toolColumn: 'transcription',
    title: 'Transcription · translate a transcript',
    stages: ['start', 'terminal'],
    stageEvents: {},
    start: [],
    terminal: [],
    platforms: BOTH,
    unobservable: ['translation request and result'],
    producerStatus: 'unsupported_by_producer',
    source: 'events',
    note: 'Translation shares the transcription queue and emits no event of its own.'
  },
  {
    id: 'landing_optimizer.run',
    tool: 'landing-optimizer',
    toolColumn: 'landing-optimizer',
    title: 'Landing optimizer · optimize a landing',
    stages: ['open', 'ready', 'loaded', 'start', 'terminal'],
    stageEvents: {
      open: ['tool_opened'],
      ready: ['tool_ready'],
      loaded: ['landing_loaded'],
      start: ['landing_optimization_started', 'operation_started'],
      terminal: [
        'landing_optimization_completed',
        'landing_optimization_failed',
        'operation_completed',
        'operation_failed',
        'operation_cancelled'
      ]
    },
    start: [
      { event: 'landing_optimization_started', correlate: 'run_id' },
      { event: 'operation_started', correlate: 'run_id' }
    ],
    terminal: [
      { event: 'landing_optimization_completed', correlate: 'run_id' },
      { event: 'landing_optimization_failed', correlate: 'run_id' },
      { event: 'operation_completed', correlate: 'run_id' },
      { event: 'operation_failed', correlate: 'run_id' },
      { event: 'operation_cancelled', correlate: 'run_id' }
    ],
    readiness: { event: 'tool_ready', correlate: 'none' },
    error: { event: 'error_occurred', correlate: 'run_id' },
    platforms: BOTH,
    unobservable: ['landing archive content'],
    producerStatus: 'emitted',
    source: 'events'
  },
  {
    id: 'landing_preview.open',
    tool: 'landing-preview',
    toolColumn: 'landing-preview',
    title: 'Landing preview · open a landing',
    stages: ['open', 'ready', 'input_add', 'start', 'terminal'],
    stageEvents: {
      open: ['tool_opened'],
      ready: ['tool_ready'],
      input_add: ['input_add_completed'],
      start: ['operation_started'],
      terminal: ['operation_completed', 'operation_failed']
    },
    start: [{ event: 'operation_started', correlate: 'run_id' }],
    terminal: [
      { event: 'operation_completed', correlate: 'run_id' },
      { event: 'operation_failed', correlate: 'run_id' }
    ],
    readiness: { event: 'tool_ready', correlate: 'none' },
    error: { event: 'error_occurred', correlate: 'run_id' },
    platforms: BOTH,
    unobservable: ['what the person saw in the rendered page'],
    producerStatus: 'emitted',
    source: 'events'
  },
  {
    id: 'landing_preview.render',
    tool: 'team',
    title: 'Landing preview · team landing tile render',
    stages: ['gallery_view', 'open', 'render'],
    stageEvents: {
      gallery_view: ['team_landing_gallery_view'],
      open: ['team_landing_open'],
      render: ['team_landing_render']
    },
    start: [
      {
        event: 'team_landing_gallery_view',
        correlate: 'attempt_id',
        producerStatus: 'unsupported_by_producer'
      },
      {
        event: 'team_landing_open',
        correlate: 'attempt_id',
        producerStatus: 'unsupported_by_producer'
      }
    ],
    terminal: [{ event: 'team_landing_render', correlate: 'attempt_id' }],
    platforms: BOTH,
    unobservable: [],
    producerStatus: 'emitted',
    source: 'events',
    note: 'Only team_landing_render has a call site; gallery_view/open helpers exist but nothing calls them.'
  },
  {
    id: 'two_factor.notebook',
    tool: 'two-factor',
    toolColumn: 'two-factor',
    title: '2FA notebook (browser-only tool)',
    stages: ['open', 'use'],
    stageEvents: { open: ['tool_opened'], use: ['feature_enabled'] },
    start: [{ event: 'tool_opened', correlate: 'none' }],
    terminal: [],
    platforms: BOTH,
    unobservable: ['codes and secrets (never collected)'],
    producerStatus: 'emitted',
    source: 'events',
    note: 'Opens and feature_enabled only; there is no operation to terminate, so the capability is at best partial.'
  },

  /* --------------------------------------------------------------------- *
   * Team workspace
   * --------------------------------------------------------------------- */
  {
    id: 'team.storage_connect',
    tool: 'team',
    title: 'Team · connect storage',
    stages: ['connect', 'attention'],
    stageEvents: {
      connect: ['team_storage_connected'],
      attention: ['team_storage_attention']
    },
    start: [{ event: 'team_storage_connected', correlate: 'none' }],
    terminal: [{ event: 'team_storage_connected', correlate: 'none' }],
    error: { event: 'team_storage_attention', correlate: 'none' },
    platforms: BOTH,
    unobservable: ['Google consent screen'],
    producerStatus: 'emitted',
    source: 'events'
  },
  {
    id: 'team.index',
    tool: 'team',
    title: 'Team · index storage and prepare previews',
    stages: ['index', 'previews'],
    stageEvents: {
      index: ['team_index_completed'],
      previews: ['team_previews_ready']
    },
    start: [{ event: 'team_index_completed', correlate: 'none' }],
    terminal: [{ event: 'team_previews_ready', correlate: 'none' }],
    platforms: BOTH,
    unobservable: ['per-folder scan progress (see `sync`)'],
    producerStatus: 'emitted',
    source: 'events'
  },
  {
    id: 'team.sync',
    tool: 'team',
    title: 'Team · catalog sync jobs',
    stages: ['queued', 'running', 'terminal'],
    stageEvents: {},
    start: [],
    terminal: [],
    platforms: BOTH,
    unobservable: [],
    producerStatus: 'emitted',
    source: 'authoritative_table',
    note: 'Authoritative in the view analytics_catalog_sync_jobs (`sync <team|owner>`), not in the event stream.'
  },
  {
    id: 'team.file_ops',
    tool: 'team',
    title: 'Team · upload/download/move/rename/delete/share a file',
    stages: ['start', 'terminal'],
    stageEvents: {
      start: ['team_file_attempt_started'],
      terminal: ['team_file_attempt_completed']
    },
    start: [{ event: 'team_file_attempt_started', correlate: 'attempt_id' }],
    terminal: [{ event: 'team_file_attempt_completed', correlate: 'attempt_id' }],
    platforms: BOTH,
    unobservable: ['share: Drive sharing dialog outcome'],
    producerStatus: 'emitted',
    source: 'events'
  },
  {
    id: 'team.process',
    tool: 'team',
    title: 'Team · process a material (workflow)',
    stages: ['start', 'terminal'],
    stageEvents: {
      start: ['team_workflow_started'],
      terminal: ['team_workflow_completed']
    },
    start: [{ event: 'team_workflow_started', correlate: 'workflow_id' }],
    terminal: [{ event: 'team_workflow_completed', correlate: 'workflow_id' }],
    error: { event: 'error_occurred', correlate: 'workflow_id' },
    platforms: BOTH,
    unobservable: ['material content'],
    producerStatus: 'emitted',
    source: 'events'
  },
  {
    id: 'team.restitch',
    tool: 'team',
    title: 'Team · restitch delivery',
    stages: ['start', 'terminal'],
    stageEvents: {
      start: ['team_workflow_started'],
      terminal: ['team_workflow_completed']
    },
    start: [{ event: 'team_workflow_started', correlate: 'workflow_id' }],
    terminal: [{ event: 'team_workflow_completed', correlate: 'workflow_id' }],
    error: { event: 'error_occurred', correlate: 'workflow_id' },
    platforms: BOTH,
    unobservable: [],
    producerStatus: 'emitted',
    source: 'events',
    note: 'Shares the workflow lifecycle with team.process; `category` tells them apart.'
  },
  {
    id: 'team.find',
    tool: 'team',
    title: 'Team · find a material (SC-005 study)',
    stages: ['start', 'terminal'],
    stageEvents: {
      start: ['team_find_started'],
      terminal: ['team_find_completed']
    },
    start: [{ event: 'team_find_started', correlate: 'attempt_id' }],
    terminal: [{ event: 'team_find_completed', correlate: 'attempt_id' }],
    platforms: BOTH,
    unobservable: ['search query text (never collected)'],
    producerStatus: 'emitted',
    source: 'events'
  },
  {
    id: 'team.preview',
    tool: 'team',
    title: 'Team · preview a material',
    stages: ['start', 'terminal'],
    stageEvents: {
      start: ['team_preview_started'],
      terminal: ['team_preview_completed']
    },
    start: [{ event: 'team_preview_started', correlate: 'attempt_id' }],
    terminal: [{ event: 'team_preview_completed', correlate: 'attempt_id' }],
    platforms: BOTH,
    unobservable: [],
    producerStatus: 'emitted',
    source: 'events',
    note: 'Emitted by MaterialPreview (033 FR-009); a failure adds error_occurred on the same attempt_id.'
  },
  {
    id: 'team.library',
    tool: 'team',
    title: 'Team · creative library contributions',
    stages: ['batch', 'processing'],
    stageEvents: {
      batch: ['team_library_batch_completed'],
      processing: ['team_library_processing_completed']
    },
    start: [],
    terminal: [
      { event: 'team_library_batch_completed', correlate: 'none' },
      { event: 'team_library_processing_completed', correlate: 'none' }
    ],
    platforms: BOTH,
    unobservable: ['library scores and content'],
    producerStatus: 'unsupported_by_producer',
    source: 'events',
    note: 'trackCreativeLibraryContribution exists but nothing calls it; contributions live in Postgres.'
  },
  {
    id: 'team.tasks',
    tool: 'team',
    title: 'Team · tasks',
    stages: ['create', 'complete'],
    stageEvents: { complete: ['team_task_completed'] },
    start: [],
    terminal: [{ event: 'team_task_completed', correlate: 'none' }],
    platforms: BOTH,
    unobservable: ['task text and attachments'],
    producerStatus: 'unsupported_by_producer',
    source: 'events',
    note: 'No task event is emitted; the task tables are the only record.'
  },
  {
    id: 'team.accounts_finance',
    tool: 'team',
    title: 'Team · accounts and finance metadata',
    stages: ['view', 'edit'],
    stageEvents: {},
    start: [],
    terminal: [],
    platforms: BOTH,
    unobservable: ['account and finance records (metadata only, never events)'],
    producerStatus: 'unsupported_by_producer',
    source: 'events'
  },
  {
    id: 'team.onboarding',
    tool: 'team',
    title: 'Team · create a space (SC-001 onboarding)',
    stages: ['start', 'terminal'],
    stageEvents: {
      start: ['team_onboarding_started'],
      terminal: ['team_onboarding_completed']
    },
    start: [{ event: 'team_onboarding_started', correlate: 'flow_id' }],
    terminal: [{ event: 'team_onboarding_completed', correlate: 'flow_id' }],
    platforms: BOTH,
    unobservable: [],
    producerStatus: 'emitted',
    source: 'events'
  },
  {
    id: 'team.session',
    tool: 'team',
    title: 'Team · authenticated workspace session',
    stages: ['session'],
    stageEvents: { session: ['team_workspace_session'] },
    start: [{ event: 'team_workspace_session', correlate: 'none' }],
    terminal: [{ event: 'team_workspace_session', correlate: 'none' }],
    platforms: BOTH,
    unobservable: [],
    producerStatus: 'emitted',
    source: 'events'
  },

  /* --------------------------------------------------------------------- *
   * Browser ↔ Agent link (032), updates, onboarding
   * --------------------------------------------------------------------- */
  {
    id: 'link.check',
    tool: 'link',
    title: 'Link · check the Agent',
    stages: ['start', 'terminal'],
    stageEvents: {
      start: ['link_check_started'],
      terminal: ['link_check_completed']
    },
    start: [{ event: 'link_check_started', correlate: 'flow_id' }],
    terminal: [{ event: 'link_check_completed', correlate: 'flow_id' }],
    platforms: BOTH,
    unobservable: ['browser private-network policy decisions'],
    producerStatus: 'emitted',
    source: 'events',
    sinceWebBuild: LINK_SINCE_WEB_BUILD
  },
  {
    id: 'link.lost',
    tool: 'link',
    title: 'Link · lost and recovered',
    stages: ['lost', 'reconnect_clicked', 'recovered'],
    stageEvents: {
      lost: ['link_lost'],
      reconnect_clicked: ['reconnect_clicked'],
      recovered: ['link_recovered']
    },
    start: [{ event: 'link_lost', correlate: 'flow_id' }],
    terminal: [{ event: 'link_recovered', correlate: 'flow_id' }],
    error: { event: 'link_inconsistency', correlate: 'flow_id' },
    platforms: BOTH,
    unobservable: ['why the OS dropped the socket'],
    producerStatus: 'emitted',
    source: 'events',
    sinceWebBuild: LINK_SINCE_WEB_BUILD
  },
  {
    id: 'link.blocked',
    tool: 'link',
    title: 'Link · blocked by the browser',
    stages: ['detected'],
    stageEvents: { detected: ['blocked_by_browser_detected'] },
    start: [{ event: 'blocked_by_browser_detected', correlate: 'none' }],
    terminal: [{ event: 'blocked_by_browser_detected', correlate: 'none' }],
    platforms: BOTH,
    unobservable: [],
    producerStatus: 'emitted',
    source: 'events',
    sinceWebBuild: LINK_SINCE_WEB_BUILD
  },
  {
    id: 'link.pairing',
    tool: 'link',
    title: 'Link · pairing (legacy names)',
    stages: ['start', 'terminal'],
    stageEvents: {
      start: ['pairing_started'],
      terminal: ['pairing_completed', 'pairing_failed']
    },
    start: [{ event: 'pairing_started', correlate: 'flow_id' }],
    terminal: [
      { event: 'pairing_completed', correlate: 'flow_id' },
      { event: 'pairing_failed', correlate: 'flow_id' }
    ],
    platforms: BOTH,
    unobservable: [],
    producerStatus: 'unsupported_by_producer',
    source: 'events',
    note: 'Pairing is observed through link_check_* with pairing_method since 032; the pairing_* names have no producer.'
  },
  {
    id: 'agent.session',
    tool: 'link',
    title: 'Agent · connected / disconnected',
    stages: ['connected', 'disconnected'],
    stageEvents: {
      connected: ['agent_connected'],
      disconnected: ['agent_disconnected']
    },
    start: [{ event: 'agent_connected', correlate: 'none' }],
    terminal: [{ event: 'agent_disconnected', correlate: 'none' }],
    platforms: BOTH,
    unobservable: [],
    producerStatus: 'emitted',
    source: 'events'
  },
  {
    id: 'update.run',
    tool: 'update',
    title: 'Update · discover, start, complete',
    stages: [
      'available',
      'prompt',
      'start',
      'download',
      'drain',
      'restart',
      'terminal',
      'dismissed'
    ],
    stageEvents: {
      available: ['update_available', 'agent_update_required'],
      prompt: ['update_prompt_shown'],
      start: ['update_started'],
      download: ['update_download_completed', 'update_verification_failed'],
      drain: ['update_deferred_busy', 'update_draining_started'],
      restart: ['update_restart_started'],
      terminal: ['update_completed', 'update_failed'],
      dismissed: ['update_dismissed']
    },
    start: [{ event: 'update_started', correlate: 'none' }],
    terminal: [
      { event: 'update_completed', correlate: 'none', producerStatus: 'unsupported_by_producer' },
      { event: 'update_failed', correlate: 'none', producerStatus: 'unsupported_by_producer' }
    ],
    platforms: BOTH,
    unobservable: [
      'agent-side download, verification, drain and restart (the browser loses the Agent while it restarts)'
    ],
    producerStatus: 'emitted',
    source: 'events',
    note: 'The browser emits available/prompt/started/dismissed; every stage after update_started has no producer. A later agent_connected with a newer local_app_version is the only evidence of completion.'
  },
  {
    id: 'update.agent_stages',
    tool: 'update',
    title: 'Update · agent-side stages (no producer)',
    stages: ['download', 'verify', 'defer', 'drain', 'restart'],
    stageEvents: {
      download: ['update_download_completed'],
      verify: ['update_verification_failed'],
      defer: ['update_deferred_busy'],
      drain: ['update_draining_started'],
      restart: ['update_restart_started']
    },
    start: [],
    terminal: [],
    platforms: BOTH,
    unobservable: ['everything: the Agent has no analytics client'],
    producerStatus: 'unsupported_by_producer',
    source: 'events'
  },
  {
    id: 'onboarding.local_app',
    tool: 'onboarding',
    title: 'Onboarding · install the local app',
    stages: ['prompt', 'download_clicked', 'blocked', 'install_detected', 'launch'],
    stageEvents: {
      prompt: ['setup_prompt_shown'],
      download_clicked: ['install_download_clicked'],
      blocked: ['blocked_action_attempted'],
      install_detected: ['install_detected'],
      launch: ['local_app_launch_clicked']
    },
    start: [{ event: 'setup_prompt_shown', correlate: 'none' }],
    terminal: [
      { event: 'install_detected', correlate: 'none', producerStatus: 'unsupported_by_producer' },
      {
        event: 'local_app_launch_clicked',
        correlate: 'none',
        producerStatus: 'unsupported_by_producer'
      }
    ],
    platforms: BOTH,
    unobservable: ['the installer running outside the browser'],
    producerStatus: 'emitted',
    source: 'events',
    note: 'The prompt and the download click are emitted; detection of the installed app is proven only by a later agent_connected.'
  },
  {
    id: 'onboarding.legacy',
    tool: 'onboarding',
    title: 'Onboarding · legacy funnel names (no producer)',
    stages: ['check', 'start', 'step', 'skip', 'complete'],
    stageEvents: {
      check: ['local_app_check_started', 'local_app_check_completed'],
      start: ['onboarding_started'],
      step: ['onboarding_step_completed'],
      skip: ['onboarding_skipped'],
      complete: ['onboarding_completed']
    },
    start: [{ event: 'onboarding_started', correlate: 'none' }],
    terminal: [
      { event: 'onboarding_completed', correlate: 'none', producerStatus: 'emitted' },
      { event: 'onboarding_skipped', correlate: 'none' }
    ],
    platforms: BOTH,
    unobservable: [],
    producerStatus: 'unsupported_by_producer',
    source: 'events',
    note: 'Only onboarding_completed is emitted (AuthContext, after sign-up); the rest are names without a producer.'
  },
  {
    id: 'account.auth',
    tool: 'onboarding',
    title: 'Account · sign in / sign out',
    stages: ['signed_in', 'signed_out'],
    stageEvents: { signed_in: ['user_signed_in'], signed_out: ['user_signed_out'] },
    start: [{ event: 'user_signed_in', correlate: 'none' }],
    terminal: [{ event: 'user_signed_out', correlate: 'none' }],
    platforms: BOTH,
    unobservable: [],
    producerStatus: 'emitted',
    source: 'events'
  },
  {
    id: 'home.discovery',
    tool: 'onboarding',
    title: 'Home · tool tiles seen and opened',
    stages: ['home', 'impression', 'click', 'open'],
    stageEvents: {
      home: ['home_viewed'],
      impression: ['tool_impression'],
      click: ['tool_open_clicked', 'tool_blocked_incompatible'],
      open: ['tool_opened']
    },
    start: [{ event: 'tool_open_clicked', correlate: 'none' }],
    terminal: [{ event: 'tool_opened', correlate: 'none' }],
    platforms: BOTH,
    unobservable: [],
    producerStatus: 'emitted',
    source: 'events'
  },
  {
    id: 'features.discovery',
    tool: 'onboarding',
    title: 'Features · seen, enabled, helped',
    stages: ['impression', 'interaction'],
    stageEvents: {
      impression: ['feature_impression'],
      interaction: ['feature_enabled', 'setting_changed', 'feature_help_opened', 'feature_disabled']
    },
    start: [{ event: 'feature_impression', correlate: 'none' }],
    terminal: [
      { event: 'feature_enabled', correlate: 'none' },
      { event: 'setting_changed', correlate: 'none' },
      {
        event: 'feature_help_opened',
        correlate: 'none',
        producerStatus: 'unsupported_by_producer'
      },
      { event: 'feature_disabled', correlate: 'none', producerStatus: 'unsupported_by_producer' }
    ],
    platforms: BOTH,
    unobservable: [],
    producerStatus: 'emitted',
    source: 'events'
  },
  {
    id: 'ui.blocked',
    tool: 'onboarding',
    title: 'UI · blocked actions and validation',
    stages: ['blocked', 'validation'],
    stageEvents: {
      blocked: ['blocked_action_attempted'],
      validation: ['validation_message_shown']
    },
    start: [{ event: 'blocked_action_attempted', correlate: 'none' }],
    terminal: [
      {
        event: 'validation_message_shown',
        correlate: 'none',
        producerStatus: 'unsupported_by_producer'
      }
    ],
    platforms: BOTH,
    unobservable: [],
    producerStatus: 'emitted',
    source: 'events'
  },
  {
    id: 'support.diagnostics',
    tool: 'analytics',
    title: 'Support · diagnostics bundle copied',
    stages: ['opened', 'copied'],
    stageEvents: { opened: ['support_opened'], copied: ['diagnostics_copied'] },
    start: [{ event: 'support_opened', correlate: 'none' }],
    terminal: [{ event: 'diagnostics_copied', correlate: 'none' }],
    platforms: BOTH,
    unobservable: ['the bundle text itself'],
    producerStatus: 'emitted',
    source: 'events'
  },
  {
    id: 'analytics.delivery',
    tool: 'analytics',
    title: 'Analytics · delivery report (rejected / evicted / expired)',
    stages: ['report'],
    stageEvents: { report: ['analytics_delivery_report'] },
    start: [{ event: 'analytics_delivery_report', correlate: 'none' }],
    terminal: [{ event: 'analytics_delivery_report', correlate: 'none' }],
    platforms: BOTH,
    unobservable: ['events lost before the client could count them'],
    producerStatus: 'emitted',
    source: 'events',
    note: 'Emitted by the client queue (T005) once per session and on the next delivery after a loss.'
  }
];

/* -------------------------------------------------------------------------
 * Helpers used by the queries, `audit` and `inspect`.
 * ---------------------------------------------------------------------- */

export function signalStatus(capability: Capability, signal: CapabilitySignal): ProducerStatus {
  return signal.producerStatus ?? capability.producerStatus;
}

export function capabilitySignals(capability: Capability): CapabilitySignal[] {
  const list: CapabilitySignal[] = [...capability.start, ...capability.terminal];
  if (capability.readiness) list.push(capability.readiness);
  if (capability.error) list.push(capability.error);
  return list;
}

const STATUS_RANK: Record<ProducerStatus, number> = {
  emitted: 2,
  pending_producer: 1,
  unsupported_by_producer: 0
};

/**
 * Every event the registry knows with one producer status. A signal takes the
 * strongest status any capability gives it (an `error_occurred` emitted by one
 * tool is emitted). An event that is only stage evidence takes the weakest
 * status of the capabilities listing it, so an agent-side update stage shared
 * by `update.run` (emitted) and `update.agent_stages` (unsupported) stays
 * unsupported.
 */
export function registryEventStatuses(): Map<string, ProducerStatus> {
  const signals = new Map<string, ProducerStatus>();
  const stagesOnly = new Map<string, ProducerStatus>();
  for (const capability of COVERAGE_REGISTRY) {
    for (const signal of capabilitySignals(capability)) {
      const status = signalStatus(capability, signal);
      const current = signals.get(signal.event);
      if (!current || STATUS_RANK[status] > STATUS_RANK[current]) signals.set(signal.event, status);
    }
    for (const events of Object.values(capability.stageEvents)) {
      for (const event of events ?? []) {
        const current = stagesOnly.get(event);
        if (!current || STATUS_RANK[capability.producerStatus] < STATUS_RANK[current]) {
          stagesOnly.set(event, capability.producerStatus);
        }
      }
    }
  }
  const out = new Map<string, ProducerStatus>(signals);
  for (const [event, status] of stagesOnly) if (!out.has(event)) out.set(event, status);
  return out;
}

export function producerStatusOf(event: string): ProducerStatus | null {
  return registryEventStatuses().get(event) ?? null;
}

export function isEmitted(event: string): boolean {
  return producerStatusOf(event) === 'emitted';
}

/** Keep only the events a producer emits today — what SQL may compute from. */
export function emittedOnly<T extends string>(events: readonly T[]): T[] {
  return events.filter(event => isEmitted(event));
}

/** The complement: events the CLI must report as `unsupported_by_producer`. */
export function notEmitted<T extends string>(events: readonly T[]): T[] {
  return events.filter(event => !isEmitted(event));
}

export function capabilityById(id: string): Capability | undefined {
  return COVERAGE_REGISTRY.find(capability => capability.id === id);
}

/** Every event name the registry mentions anywhere (signals and stage evidence). */
export function registryEventNames(): string[] {
  return [...registryEventStatuses().keys()].sort();
}
