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
import { RECOVERY_RETIREMENT_STAGES } from '../../packages/shared/src/team/recovery.js';

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
  /** Closed discriminator for a capability sharing generic 031 operation events. */
  flowStep?:
    | `workspace_${'task_copy' | 'task_detach' | 'task_cleanup' | 'bulk_trash'}`
    | 'theme'
    | 'recovery_retirement_ack'
    | 'auth_session_sdk_logout'
    | 'auth_profile_refresh'
    | 'auth_profile_update'
    | `launch_defaults_${'read' | 'save' | 'apply'}_${'offer' | 'workspace'}`
    | `launch_copy_marks_${'read' | 'write'}`
    | 'launch_notes_copy'
    | 'launch_account_picker'
    | 'launch_settings_editor'
    | 'launch_detail_session'
    | 'members_list'
    | 'assignees_list'
    | `task_${'create' | 'list' | 'read' | 'update' | 'editor_refresh' | 'editor_preserve_draft'}`
    | 'member_permissions_save'
    | 'member_remove'
    | 'member_access_refresh'
    | `catalog_manager_${'list' | 'filter' | 'profile' | 'bulk' | 'template'}`;
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
  {
    id: 'team.process_output_cleanup',
    tool: 'team',
    title: 'Team · canceled process output reconciliation',
    stages: [
      'reserved',
      'upload_started',
      'published',
      'cleanup_pending',
      'trash_confirmed',
      'attention'
    ],
    stageEvents: {},
    start: [],
    terminal: [],
    platforms: BOTH,
    producerStatus: 'pending_producer',
    source: 'authoritative_table',
    unobservable: [
      'A settled local request or provider 404 does not prove that a late upload cannot commit.',
      'Legacy operations without captured ownership remain unknown. The current projection omits rows changed after as-of instead of reconstructing history.',
      'Database state and provider readback do not prove browser delivery. Producer and worker integration is implemented but full real-agent and scheduled-provider acceptance is not yet verified.'
    ],
    note: 'The private ownership ledger and restricted workspace projection record exact operation identity, grant expiry, bounded leases and cleanup outcomes without exposing provider identifiers or content. investigate reads the projection and points uncertainty at the ownership code map. Keep pending_producer until the real agent, Edge start/finalize and cleanup worker are wired and verified.'
  },
  {
    id: 'members.access_refresh',
    tool: 'team',
    title: 'Membership signal and authoritative access reread',
    stages: ['requested', 'terminal'],
    stageEvents: {
      requested: ['operation_started'],
      terminal: ['operation_completed', 'operation_failed']
    },
    start: [
      { event: 'operation_started', correlate: 'attempt_id', flowStep: 'member_access_refresh' }
    ],
    terminal: [
      { event: 'operation_completed', correlate: 'attempt_id', flowStep: 'member_access_refresh' },
      { event: 'operation_failed', correlate: 'attempt_id', flowStep: 'member_access_refresh' }
    ],
    error: { event: 'error_occurred', correlate: 'attempt_id', flowStep: 'member_access_refresh' },
    platforms: BOTH,
    producerStatus: 'emitted',
    source: 'events',
    unobservable: [
      'A signal never delivered to a disconnected browser cannot emit a refresh attempt. Inspect the durable own-row revision and current membership.',
      'Completion proves an authoritative access reread, not a visible DOM commit. Browser interruption or absent terminal remains unknown.',
      'The separate invitation/seat read is not proved by access or member-list completion. Compare the current protected tariff/invitation snapshot and native counts; absent evidence remains unknown.'
    ],
    note: '036: role changes and removal invalidate the affected client; membership and invitation changes also invalidate current managers through their own content-free rows. Members and pending seats reread the shared workspace revision. Reconnect/foreground still reread authoritatively. Opaque attempt/flow IDs only; no target identity, role or permission values. Synthetic local capture is separate from ordinary disabled beta analytics. Authoritative view=false also unmounts retained workspace content and media (036 T133); a successful access-refresh attempt proves the reread, while browser removal/restoration needs separate UI evidence. No permission values or content are emitted.'
  },

  {
    id: 'members.assignees',
    tool: 'team',
    title: 'Safe assignee directory read',
    stages: ['requested', 'terminal'],
    stageEvents: {
      requested: ['operation_started'],
      terminal: ['operation_completed', 'operation_failed']
    },
    start: [{ event: 'operation_started', correlate: 'attempt_id', flowStep: 'assignees_list' }],
    terminal: [
      { event: 'operation_completed', correlate: 'attempt_id', flowStep: 'assignees_list' },
      { event: 'operation_failed', correlate: 'attempt_id', flowStep: 'assignees_list' }
    ],
    error: { event: 'error_occurred', correlate: 'attempt_id', flowStep: 'assignees_list' },
    platforms: BOTH,
    producerStatus: 'emitted',
    source: 'events',
    unobservable: [
      'Completion proves a validated view-authorized directory response, not a visible selected option. Native browser evidence is separate.',
      'A missing terminal or unavailable directory remains unknown; the stored task assignee snapshot is a safe display fallback.'
    ],
    note: 'Tasks and Launches reuse the existing narrow projection. No assignee identity, label, email, role or permission values enter events. Full member-management reads stay restricted.'
  },

  ...(['members_list', 'member_permissions_save', 'member_remove'] as const).map(
    (step): Capability => ({
      id:
        step === 'members_list'
          ? 'members.list'
          : step === 'member_permissions_save'
            ? 'members.permissions'
            : 'members.remove',
      tool: 'team',
      title:
        step === 'members_list'
          ? 'Members list delivery'
          : step === 'member_permissions_save'
            ? 'Member permissions save and delivery'
            : 'Member removal and delivery',
      stages: ['requested', ...(step === 'members_list' ? [] : ['accepted']), 'terminal'],
      stageEvents: {
        requested: ['operation_started'],
        ...(step === 'members_list' ? {} : { accepted: ['operation_stage_completed' as const] }),
        terminal: [
          'operation_completed',
          'operation_failed',
          ...(step === 'members_list' ? ['operation_cancelled' as const] : [])
        ]
      },
      start: [{ event: 'operation_started', correlate: 'attempt_id', flowStep: step }],
      terminal: [
        { event: 'operation_completed', correlate: 'attempt_id', flowStep: step },
        { event: 'operation_failed', correlate: 'attempt_id', flowStep: step },
        ...(step === 'members_list'
          ? [
              {
                event: 'operation_cancelled' as const,
                correlate: 'attempt_id' as const,
                flowStep: step
              }
            ]
          : [])
      ],
      error: { event: 'error_occurred', correlate: 'attempt_id', flowStep: step },
      platforms: BOTH,
      unobservable: [
        'Unsaved permission values and draft gestures are deliberately uncollected.',
        'A lost mutation reply or browser interruption cannot prove whether the server committed. Check the existing protected membership audit and read current permissions before retrying.'
      ],
      producerStatus: 'emitted',
      source: 'events',
      note: 'Only opaque flow and attempt IDs and closed failure codes are collected. List requests cancel when obsolete. Mutation acceptance proves a valid server response; completion follows React commit of the member list and success feedback. An absent terminal remains unknown, never success or a proved cancellation. Beta analytics is disabled; producer and CLI regressions provide local evidence. Existing membership.updated and membership.removed server audits remain authoritative. No new SQL or production writes.'
    })
  ),
  ...(['task_copy', 'task_detach', 'task_cleanup', 'bulk_trash'] as const).map(action => ({
    id: `team.workspace_${action}`,
    tool: 'team' as const,
    title: `Workspace · ${action}`,
    stages: ['requested', 'observed_stage', 'terminal'],
    stageEvents: {
      requested: ['operation_started' as const],
      observed_stage: ['operation_stage_completed' as const],
      terminal: ['operation_completed' as const, 'operation_failed' as const]
    },
    start: [
      {
        event: 'operation_started' as const,
        correlate: 'attempt_id' as const,
        flowStep: `workspace_${action}` as const
      }
    ],
    terminal: (['operation_completed', 'operation_failed'] as const).map(event => ({
      event,
      correlate: 'attempt_id' as const,
      flowStep: `workspace_${action}` as const
    })),
    platforms: BOTH,
    producerStatus: 'emitted' as const,
    source: 'events' as const,
    unobservable: [
      'Missing visible completion is unknown. A retained cleanup is an observed retention outcome, never proof that a file was trashed.',
      'A browser interrupted before rendering leaves its request unfinished; server receipts remain authoritative. Beta disables analytics.'
    ],
    note: 'Typed workspace operation flows contain only opaque IDs, bounded counts and closed stage/reason values. investigate joins the restricted analytics_workspace_operations projection, including copy replay, cleanup provenance/refusal/worker recovery and per-item trash receipts. A current projection cannot reconstruct state after as-of; that limitation and absent views stay explicit. New references are fenced while a cleanup provider result is unknown. All discovered consumer tables, including Launch offer defaults, must retain an enabled reference guard. Missing coverage remains cleanup_unverified; an existing reference remains cleanup_referenced. These receipts prove retention, not provider deletion. Neither a toast nor an emitted event substitutes for provider readback.'
  })),
  ...(['list', 'filter', 'profile', 'bulk', 'template'] as const).map(action => ({
    id: `team.catalog_manager_${action}`,
    tool: 'team' as const,
    title: `Catalog manager · ${action}`,
    stages: ['requested', 'observed_stage', 'terminal'],
    stageEvents: {
      requested: ['operation_started' as const],
      observed_stage: ['operation_stage_completed' as const],
      terminal: [
        'operation_completed' as const,
        'operation_failed' as const,
        'operation_cancelled' as const
      ]
    },
    start: [
      {
        event: 'operation_started' as const,
        correlate: 'attempt_id' as const,
        flowStep: `catalog_manager_${action}` as const
      }
    ],
    terminal: (['operation_completed', 'operation_failed', 'operation_cancelled'] as const).map(
      event => ({
        event,
        correlate: 'attempt_id' as const,
        flowStep: `catalog_manager_${action}` as const
      })
    ),
    platforms: BOTH,
    unobservable: [
      'Missing browser completion means visible delivery is unknown, even when the authoritative mutation succeeded.',
      'Unsaved field values, search text and visual comprehension are intentionally unobserved. Beta disables analytics.'
    ],
    producerStatus: 'emitted' as const,
    source: 'events' as const,
    note: 'Generic operation lifecycle is isolated by flow_step and correlated by flow_id/attempt_id. action_identifier is a closed UI stage; save_confirmed precedes result_visible. inspect reconstructs the UI observation separately from catalog update receipts. Creation-period filtering records setting_name=createdAt and visible result count, never date bounds; cleared ranges use the same filter lifecycle. Inline changes include only a closed setting_name field; undo_requested and readback_requested expose recovery attempts. Runtime status is read independently of profile version. Launch-linked catalogs use the same explicit schedule/manual-run path as other catalogs. tests/launch-state.test.ts verifies worker delivery, unchanged Launch snapshots, names-only reuse after product growth, restitch replacement with retained historical video and URL-only reuse, and getCatalogUpdateDiagnosis receipts with a synthetic Google transport; those tests do not prove live Google delivery or browser visibility. Typed schedule rejections reach the inline row, picker and correlated error_code without being replaced by an unclassified error. tests/catalog-inline-changes.test.tsx covers the hook producer; tests/catalog-ui-diagnosis.test.ts persists the produced lifecycle and reads its exact cause through getInspect. Transport uncertainty remains UNKNOWN until authoritative readback. The catalog-trends read-only command separately projects authoritative committed schedule/option history, baseline observation, actor attribution, transitions and as-of state into JSON/offline charts; private journal event IDs and transaction IDs identify server evidence. Legacy/bulk/undo writers are covered at the DB boundary. Baselines do not prove historical choices, missing client completion remains unknown, and bounded user/timeline samples declare truncation. Counts contain no catalog names, queries or provider content. Completion is only emitted after visible UI commit; silence is unknown, never success.'
  })),
  {
    id: 'team.catalog_settings',
    tool: 'team',
    title: 'Team · committed catalog settings',
    stages: ['observed_baseline', 'committed_change'],
    stageEvents: {},
    start: [],
    terminal: [],
    platforms: BOTH,
    unobservable: [
      'Settings before the installation/first-observation boundary are unknown; baselines are not user choices.',
      'A nullable actor is explicitly system_unknown; a creator is not necessarily the editor or workspace owner.',
      'The journal proves committed settings, not browser delivery or downstream advertising results.'
    ],
    producerStatus: 'emitted',
    source: 'authoritative_table',
    note: 'Deferred database triggers observe final interval, civil schedule and five content switches across profile/legacy/bulk/undo writers. analytics_catalog_settings_history/current/coverage provide source-specific evidence; capture health checks all five profile/item/catalog/material lifecycle triggers. Samples include baseline observations, not only edits. catalog-trends separates actions, baselines, active/archived state and as-of coverage without names, content or credentials.'
  },
  {
    id: 'team.catalog_update',
    tool: 'team',
    title: 'Team · product catalog update',
    stages: [
      'requested',
      'claimed',
      'preparing',
      'refreshing',
      'building',
      'uploading',
      'verifying',
      'finalizing',
      'terminal'
    ],
    stageEvents: {},
    start: [],
    terminal: [],
    platforms: BOTH,
    unobservable: [
      'Video preparation before a worker claim is not in the sheet stage history.',
      'An unknown terminal has no delivery proof; external ad-platform ingestion is not observable.'
    ],
    producerStatus: 'emitted',
    source: 'authoritative_table',
    note: 'Catalog and attempt IDs, profile version, trigger, result, safe code and readback confirmation are available through analytics_catalog_updates and the read-only catalog <id> command. Delivery proof means Drive readback of the stable sheet ID and version, not downstream ad ingestion.'
  },
  ...(['read', 'save', 'apply'] as const).map((action): Capability => ({
    id: `launches.defaults.${action}`,
    tool: 'team' as const,
    title: `Launch default settings ${action}`,
    stages: ['requested', 'terminal'],
    stageEvents: {
      requested: ['operation_started'],
      terminal: ['operation_completed', 'operation_failed', 'operation_cancelled']
    },
    start: (['offer', 'workspace'] as const).map(scope => ({
      event: 'operation_started',
      correlate: 'attempt_id' as const,
      flowStep: `launch_defaults_${action}_${scope}`
    })),
    terminal: (['offer', 'workspace'] as const).flatMap(scope =>
      (['operation_completed', 'operation_failed', 'operation_cancelled'] as const).map(event => ({
        event,
        correlate: 'attempt_id' as const,
        flowStep: `launch_defaults_${action}_${scope}`
      }))
    ),
    platforms: BOTH,
    producerStatus: 'emitted' as const,
    source: 'events' as const,
    unobservable: [
      'A lost save response may have committed. Missing browser delivery or an unfinished attempt remains unknown; retry the frozen request key or read the protected profile.'
    ],
    note: 'Closed action/scope flow_step and opaque flow/attempt IDs only. Read completion proves the RPC returned, apply completion follows the matching draft commit, and save completion follows rendered feedback. Failure proves request failure, not absence of a database commit. Profile values, offer names, buyer IDs, URLs and creative content are excluded. Scope versions and idempotency receipts guard writes. Selection replacement cancels obsolete reads. The compact defaults actions preserve these seams: no profile or identical values offer no apply action; keeping manual values and opening profile help are intentionally unobserved, never inferred as an apply or save. Beta disables delivery; producer, SQL, UI, sanitizer and CLI regressions verify the path.'
  })),
  ...(['read', 'write'] as const).map((action): Capability => ({
    id: `launches.copy-marks.${action}`,
    tool: 'team' as const,
    title: `Personal Launch copy marks ${action}`,
    stages: ['requested', 'terminal'],
    stageEvents: {
      requested: ['operation_started'],
      terminal: ['operation_completed', 'operation_failed']
    },
    start: [
      {
        event: 'operation_started' as const,
        correlate: 'attempt_id' as const,
        flowStep: `launch_copy_marks_${action}` as const
      }
    ],
    terminal: [
      {
        event: 'operation_completed' as const,
        correlate: 'attempt_id' as const,
        flowStep: `launch_copy_marks_${action}` as const
      },
      {
        event: 'operation_failed' as const,
        correlate: 'attempt_id' as const,
        flowStep: `launch_copy_marks_${action}` as const
      }
    ],
    platforms: BOTH,
    producerStatus: 'emitted' as const,
    source: 'events' as const,
    unobservable: [
      'Clipboard delivery is separate. Missing diagnostics or a lost RPC reply does not prove receipt persistence.'
    ],
    note: 'Personal HMAC receipts are written only after clipboard success or explicit marker undo; reset clears only the current actor. No values, hashes, note IDs, keys or URLs enter telemetry/browser storage. Read failure is unknown, write failure retains tab-local proof and offers retry. Protected RPC ACL, baseline/value matching, actor swap fences, manual-save lineage, new generations, notes title/body changes, reset/undo and late-read regressions verify the journey.'
  })),
  {
    id: 'launches.notes-copy',
    tool: 'team',
    title: 'Launch note clipboard copy',
    stages: ['requested', 'terminal'],
    stageEvents: {
      requested: ['operation_started'],
      terminal: ['operation_completed', 'operation_failed']
    },
    start: [{ event: 'operation_started', correlate: 'attempt_id', flowStep: 'launch_notes_copy' }],
    terminal: [
      { event: 'operation_completed', correlate: 'attempt_id', flowStep: 'launch_notes_copy' },
      { event: 'operation_failed', correlate: 'attempt_id', flowStep: 'launch_notes_copy' }
    ],
    platforms: BOTH,
    producerStatus: 'emitted',
    source: 'events',
    unobservable: [
      'Browser termination or missing delivery leaves an unmatched attempt. Clipboard rejection does not identify OS policy.'
    ],
    note: 'Completion follows the clipboard promise; failure is explicit and the user can retry. Note IDs, titles and text are never telemetry. Editing, removal and unsaved cells are intentionally unobserved; the protected versioned draft save receipt and revision snapshot are fallback evidence. Notes do not enter reusable profiles or provider payloads. Delivery of a result and clipboard success remain distinct.'
  },
  {
    id: 'launches.account-picker',
    tool: 'team',
    title: 'Launch account browser selection',
    stages: ['requested', 'terminal'],
    stageEvents: {
      requested: ['operation_started'],
      terminal: ['operation_completed', 'operation_cancelled']
    },
    start: [
      { event: 'operation_started', correlate: 'attempt_id', flowStep: 'launch_account_picker' }
    ],
    terminal: [
      { event: 'operation_completed', correlate: 'attempt_id', flowStep: 'launch_account_picker' },
      { event: 'operation_cancelled', correlate: 'attempt_id', flowStep: 'launch_account_picker' }
    ],
    platforms: BOTH,
    producerStatus: 'emitted',
    source: 'events',
    unobservable: [
      'Unexpected browser termination or missing delivery leaves an unmatched attempt; no selection is inferred.'
    ],
    note: 'Completion follows the parent selection callback. Closing, Escape and permission loss cancel. No search text, names, IDs or run content is collected. Selection does not prove a launch was saved or generated.'
  },
  {
    id: 'launches.editor',
    tool: 'team',
    title: 'Launch settings editor loading',
    stages: ['requested', 'terminal'],
    stageEvents: {
      requested: ['operation_started'],
      terminal: ['operation_completed', 'operation_failed', 'operation_cancelled']
    },
    start: [
      { event: 'operation_started', correlate: 'attempt_id', flowStep: 'launch_settings_editor' }
    ],
    terminal: [
      { event: 'operation_completed', correlate: 'attempt_id', flowStep: 'launch_settings_editor' },
      { event: 'operation_failed', correlate: 'attempt_id', flowStep: 'launch_settings_editor' },
      { event: 'operation_cancelled', correlate: 'attempt_id', flowStep: 'launch_settings_editor' }
    ],
    error: { event: 'error_occurred', correlate: 'attempt_id', flowStep: 'launch_settings_editor' },
    platforms: BOTH,
    producerStatus: 'emitted',
    source: 'events',
    unobservable: [
      'Browser network/provider root cause; raw import errors and URLs are never collected.'
    ],
    note: 'flow_step=launch_settings_editor bounds generic operations to this capability. Completion proves the editor DOM committed, pending close cancels, retry keeps its flow and creates a new attempt; failure uses team:library:LAUNCH_EDITOR_LOAD_FAILED. A missing terminal remains unknown.'
  },
  {
    id: 'launches.session',
    tool: 'team',
    title: 'Launch detail session loading',
    stages: ['requested', 'terminal'],
    stageEvents: {
      requested: ['operation_started'],
      terminal: ['operation_completed', 'operation_failed', 'operation_cancelled']
    },
    start: [
      { event: 'operation_started', correlate: 'attempt_id', flowStep: 'launch_detail_session' }
    ],
    terminal: [
      { event: 'operation_completed', correlate: 'attempt_id', flowStep: 'launch_detail_session' },
      { event: 'operation_failed', correlate: 'attempt_id', flowStep: 'launch_detail_session' },
      { event: 'operation_cancelled', correlate: 'attempt_id', flowStep: 'launch_detail_session' }
    ],
    error: { event: 'error_occurred', correlate: 'attempt_id', flowStep: 'launch_detail_session' },
    platforms: BOTH,
    producerStatus: 'emitted',
    source: 'events',
    unobservable: [
      'Browser network/provider root cause; raw import errors and URLs are never collected.'
    ],
    note: 'flow_step=launch_detail_session bounds generic operations to this capability. Completion proves the session DOM committed, pending close cancels, retry keeps its flow and creates a new attempt; failure uses team:library:LAUNCH_SESSION_LOAD_FAILED. A missing terminal remains unknown.'
  },
  ...(
    [
      'overview',
      'reorder',
      'lifecycle',
      'decoration',
      'finance_edit',
      'topup_copy',
      'retained_action'
    ] as const
  ).map(action => ({
    id: `accounts.${action}`,
    tool: 'team' as const,
    title: `Accounts · ${action}`,
    stages: ['requested', 'accepted', 'applied'],
    stageEvents: {
      requested: ['team_account_stage' as const],
      accepted: ['team_account_terminal' as const],
      applied: ['team_account_visible' as const]
    },
    start: [
      {
        event: 'team_account_stage' as const,
        correlate: action === 'finance_edit' ? ('attempt_id' as const) : ('flow_id' as const)
      }
    ],
    terminal: [
      {
        event: 'team_account_terminal' as const,
        correlate: action === 'finance_edit' ? ('attempt_id' as const) : ('flow_id' as const)
      }
    ],
    readiness: {
      event: 'team_account_visible' as const,
      correlate: action === 'finance_edit' ? ('attempt_id' as const) : ('flow_id' as const)
    },
    platforms: BOTH,
    unobservable: [
      'A browser crash before collection is unobservable; absent events never prove success.',
      'Commit acceptance does not prove browser visibility; external clipboard delivery is unobservable.',
      'Local pre-request cancellations are session aggregates, not individual write attempts.',
      ...(action === 'finance_edit'
        ? [
            'Older producers without attempt IDs cannot prove per-cell correlation; missing attempt evidence is unknown, never zero failures.'
          ]
        : [])
    ],
    producerStatus: 'emitted' as const,
    source: 'events' as const,
    note: 'Only independent diagnostic flow IDs and closed enums are collected. Creation retains the safe account_day bucket through requested/accepted/applied or failure, distinguishing selected-day creation without literal dates. Finance values, account IDs, preferences and clipboard contents are never read by diagnostics. Signal counts are transitions rather than unique actions; correlation proves an attempt.'
  })),
  {
    id: 'team.launches',
    tool: 'team',
    title: 'Launches · prepare an advertising launch',
    stages: ['intent', 'accepted', 'generation', 'terminal', 'result_visible'],
    stageEvents: {
      intent: ['team_launch_intent'],
      terminal: ['team_launch_terminal'],
      result_visible: ['team_launch_visible']
    },
    start: [{ event: 'team_launch_intent', correlate: 'flow_id' }],
    terminal: [{ event: 'team_launch_terminal', correlate: 'run_id' }],
    platforms: BOTH,
    unobservable: [
      'Browser visibility when its signal is absent; authoritative commit is separate evidence.',
      'Browser storage can reject analytics enqueue before delivery; a missing client event does not negate an authoritative Launch commit.',
      'External Ads Manager use and tracking-platform interpretation.',
      'A missing native quiescence receipt or incomplete Drive lookup cannot prove that a canceled video upload is safe to clean; cleanup_pending remains explicit.',
      'A source-video or image grant with an unknown create reply or unprovable competing use keeps cancellation in cleanup_pending; exact known grants are reconciled by fenced provider lookup.'
    ],
    producerStatus: 'emitted',
    source: 'authoritative_table',
    note: 'Settings-editor loading uses generic 031 operation_started/completed/failed/cancelled with flow_step=launch_settings_editor, stable flow and distinct retry attempt IDs. Completion follows the committed editor subtree; pending close cancels. LAUNCH_EDITOR_LOAD_FAILED maps to team/library without collecting raw import messages or URLs. The launches.editor capability isolates these generic events by their closed flow_step discriminator in audit and inspect. inspect joins the restricted Launch diagnostic projection. Server stages remain authoritative; missing browser events and unsettled child cleanup are not inferred as success. Launch creative preview reuses team.preview attempt correlation, safe error codes and protected media access; aliases, names and signed media URLs are never telemetry. Dictionary rename/archive/restore use closed action names and flow IDs without names or search content; permission, conflict and replay receipts prove commit, while missing UI delivery remains unknown. One persistent edit-status row exposes pending save and preparation state; Generate keeps its caption and links to this status, while copy waits for confirmed changes; indicator visibility is not commit evidence and URL content is never collected. The compact update review lists affected outputs and retains existing generate/abandon correlation; viewing it is not evidence that processing started, and no configuration content is collected. Autosave reuses save_draft action correlation and protected authoritative versions; retry reuses its request key, conflicts stop writes, and unacknowledged RAM edits remain an explicit reload blind spot. Literal SUB aliases sub1/sub_1 through sub3/sub_3 share the same detection and lossless patching; no URL content or credentials are added to diagnostics. Date shortcuts resolve in the launch timezone and use the existing saved revision, validation and generation lifecycle; unsaved date clicks are intentionally unobserved. Budget bounds share the typed preview and server validator; invalid or too narrow integer ranges stop at validation with LAUNCH_BUDGET_INVALID. Saved revisions prove the chosen bounds; unsaved field edits are intentionally unobserved. Unified Launch progress uses current-attempt durable receipts and matching native snapshots, never timer-estimated stage completion. Catalog cache invalidation is separate from connection health; a stale observation preserves confirmed fill without declaring failure or completion. Older generation versions are rejected, and observed fill resets for another attempt. Visual stability is verified by progress and workspace regressions, not inferred from telemetry. Quiet/disconnected observations trigger one bounded status read and remain last-confirmed/unknown; native media work has no network-reply deadline. Lost mutation replies keep their exact keys with LAUNCH_RESULT_UNCERTAIN, and authoritative terminal receipts release old UI waits without replaying processing. Scroll gestures and quiet-time notices are not independent executor evidence. Launches without saved restitch settings freeze automatic source-frame mode; automatic_frame_started/completed/failed journal records correlate to the child operation without media content. Frame completion does not prove video or catalog delivery; existing finalized-material and registered-catalog receipts remain authoritative. A pre-acceptance RESTITCH_INVALID refusal records generate/failure with the flow and saved launch IDs, releases the pending request and preserves the draft for correction; there is no accepted run to infer. Beta disables analytics, so hook regressions and local UI checks provide evidence for this path. Reuse provenance is projected as opaque video operation and origin generation IDs plus the source catalog revision; launch-state exercises actual SQL receipts through the read-only CLI, while launch-analytics covers unavailable and malformed evidence. Historical duration reuse is rejected against the original processing revision. A receipt proves origin, not browser visibility or the reason for an absent child. Duration bounds are validated configuration; a random duration is drawn once into durable restitch preparation and reused on retry. Missing Launch images retain RESTITCH_POOL_EMPTY at restitch_preparing in the diagnostic projection; tests/launch-state.test.ts covers shared, inherited, personal and truly empty pools. Image recovery links consume that same closed code. Parallel grant reads do not claim a measured end-to-end speedup; bounded coordination timeouts remain LAUNCH_RESULT_UNCERTAIN, and late replies cannot start obsolete native work. Pointer gestures and unsaved duration edits are intentionally unobserved; validation regressions and saved revision/preparation evidence cover the outcome without collecting pointer telemetry. Versioned catalog SUBs stay pending in the editor; catalog_planning binds the durable name reservation, and catalog_registering commits the resolved URL only with a matching registered catalog. The intent checkpoint and revision baseline are fallback evidence; names and SUB contents are never telemetry. Missing registration cannot prove resolution reached the user. Ad-account selection keeps stable row IDs and the existing source-refresh, save_draft and generation diagnostic path. Local search text, full advertising IDs and social names are never telemetry. Searching or abandoning a search is not a saved choice; missing/archived options remain explicit in the UI and source validation. Unsubmitted selection is an intentional blind spot; a protected draft/source snapshot plus its save receipt is the fallback evidence. Account-selector regressions cover colliding suffixes, exact full-ID selection, keyboard commit, abandoned search, revoked rows and disabled input.'
  },
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
    unobservable: [
      'result file opened outside Soty',
      'static-edge cache hits and per-filter compression timings'
    ],
    producerStatus: 'emitted',
    source: 'events',
    note: 'Explicit image jobs retain frozen start/end selection-mode booleans in correlated compression run events, without asset identifiers or content. Historical jobs lacking those flags remain unknown. IMAGE_UNAVAILABLE rejects stale explicit choices before native work; a missing run start is not proof of execution. Preparation caching and frame-rate filter ordering retain the existing run_id start/terminal signals. Local benchmarks prove measured cases only; production speedup cannot be attributed to either optimization from these events.'
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
    note: 'stitch_started is one per accepted job; stitch_* and operation_* share the job id as run_id (031 T008). stitcher:pipeline_stage_started/completed records carry runId, stage, durationBucket and body fromCache; tests/stitch-first-frame.test.ts verifies production and tests/agent-journal-ingest.test.ts verifies ingestion. Team restitch uses its operationId as runId. A copied-body timing or audio defect emits stitcher:body_recovery_* with the same runId and a bounded reason. A missing completion can be interruption or missing delivery, not proof of a slow stage; older agents without journal delivery leave the cause unknown. Media phase timings exclude source inspection, network transfer and final installation.'
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
    source: 'events',
    note: '036 T135 verifies web ZIP packaging with synthetic fixtures: no macOS AppleDouble/resource metadata and no transport-only source.bin folder name. Lifecycle events prove processing outcomes, not archive contents or size savings; inspect the synthetic archive and browser render separately. No filenames, paths or archive content are added to diagnostics.'
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
    id: 'team.transfer_retention',
    tool: 'team',
    title: 'Team · transfer ticket lifecycle and database pressure',
    stages: ['issued', 'consumed', 'expired', 'retained'],
    stageEvents: {},
    start: [],
    terminal: [],
    platforms: BOTH,
    unobservable: ['historical Disk I/O budget and HTTP failures before analytics delivery'],
    producerStatus: 'emitted',
    source: 'authoritative_table',
    note: 'database-health reports purpose, producer and unused/expired/cleanup-eligible counts; --management is required for private aggregates. database-retention probes job outcomes, reuse/expiry indexes, cumulative inserts/deletes/index lookups and current Auth/REST health without scanning user tables. Timed snapshots measure activation and churn; historical I/O causality remains unobserved.'
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
    id: 'team.product_catalog',
    tool: 'team',
    title: 'Team · product catalog creation and scheduled updates',
    stages: ['accepted', 'refreshing', 'building', 'uploading', 'finalizing', 'terminal'],
    stageEvents: {},
    start: [],
    terminal: [],
    platforms: BOTH,
    unobservable: [
      'Standalone catalog creation and updater attempts have no dedicated correlated lifecycle in the analytics CLI.',
      'Catalog defaults-read pending/success/failure/retry remains UI-only: toggles reuse the dialog read; failed reads are retryable, not missing settings. Safe fallback is the rendered state and tests/product-catalog-dialog.test.tsx call-count/recovery regressions; remote diagnosis cannot infer the result.',
      'Per-image sharing and Drive conversion latency; a missing signal cannot establish a slow or failed stage.',
      'Personal catalog duration preferences are device-local and not emitted: remote diagnosis cannot prove storage writes or restoration. Safe fallback is the rendered control after reopening; tests/catalog-duration-preference.test.ts and tests/product-catalog-dialog.test.tsx cover corruption, blocked storage, isolation and exact/range restoration without exposing stored values.'
    ],
    producerStatus: 'unsupported_by_producer',
    source: 'events',
    note: 'Launch catalog intents have separate authoritative evidence through team.launches. Standalone duration selection is intentionally unobserved and adds no values to telemetry. Explicit bounds are frozen to exact seconds at the existing restitch operation boundary; the operation ID, agent workflow terminal and protected processing receipt are fallback evidence, never proof that the final catalog reached the user. tests/catalog-orchestration.test.ts covers invalid bounds before IO, range-sensitive receipt reuse and exact agent handoff. Updater progress/retry and catalog permission receipts remain operational evidence, not a measured speedup. tests/catalog-image-sharing.test.ts models 100 images; handler and worker regressions verify terminal ordering. A future restricted diagnostic projection must expose attempt correlation, stage durations and delivery without image IDs, links or row content. Catalog creation now observes its restitch child through the existing protected operation snapshots and agent stream before awaiting the local request. catalog-restitch-progress and product-catalog-dialog regressions cover immediate unknown feedback, measured cloud/local stages, unrelated/late replies, disconnect/reconnect and ordered video-to-sheet delivery; catalog-orchestration verifies ID-only notification before the long request. No per-frame telemetry is added. Operation/journal evidence can explain a failed video, but does not prove rendered progress or spreadsheet delivery; source-beta synthetic previews are fallback UI evidence, not live provider acceptance.'
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
    source: 'events',
    note: 'Catalog restitch processing includes a Drive result upload. Explorer queue jobs also emit workflow start/terminal before requesting a grant; a late cloud receipt canceled before agent dispatch retains its run_id and workflow_id. tests/agent-queue-cancel.test.tsx covers early cancellation, local grant cancellation, fresh queued work and durable cancellation. A canceled pre-grant workflow has no operation id; final file delivery and provider cleanup remain separate evidence. Local acknowledged-byte progress is covered by tests/team-transfer-upload.test.ts and partial acknowledgements/terminal states by tests/team-bridge.test.ts. Workflow lifecycle events do not establish per-request latency or a measured upload speedup.'
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
    note: 'Shares the workflow lifecycle with team.process; `category` tells them apart. Drive-screen downloads require teamRestitchSources revision 2: revision 1 dropped screens in the HTTP route. For historical 1.2.6 failures without a forwarded agent journal, intermediate transfer/cache stages remain unknown. 036 T134 registers destination selection as active before opening the native picker and passes per-waiter cancellation through macOS/Windows. The picker journal records bounded interrupted/chosen outcomes, never paths. DOWNLOAD_CANCELED finishes the delivery workflow as cancelled; the browser stays in choosing until actual agent progress. A missing picker exit or missing workflow terminal remains unknown; native visibility and saved-file delivery still need browser/filesystem evidence.'
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
    note: 'Legacy team_task_completed remains unsupported and cannot reconstruct historical journeys. Current036 API and visible editor attempts are inventoried separately under team.tasks.create/list/read/update/editor_refresh/editor_preserve_draft.'
  },
  ...(['create', 'list', 'read', 'update', 'editor_refresh', 'editor_preserve_draft'] as const).map(
    action => ({
      id: `team.tasks.${action}`,
      tool: 'team' as const,
      title: `Task ${action}`,
      stages: ['requested', 'accepted', 'terminal'],
      stageEvents: {
        requested: ['operation_started' as const],
        accepted: ['operation_stage_completed' as const],
        terminal: [
          'operation_completed' as const,
          'operation_failed' as const,
          'operation_cancelled' as const
        ]
      },
      start: [
        {
          event: 'operation_started' as const,
          correlate: 'attempt_id' as const,
          flowStep: `task_${action}` as const
        }
      ],
      terminal: [
        {
          event: 'operation_completed' as const,
          correlate: 'attempt_id' as const,
          flowStep: `task_${action}` as const
        },
        {
          event: 'operation_failed' as const,
          correlate: 'attempt_id' as const,
          flowStep: `task_${action}` as const
        },
        {
          event: 'operation_cancelled' as const,
          correlate: 'attempt_id' as const,
          flowStep: `task_${action}` as const
        }
      ],
      error: {
        event: 'error_occurred' as const,
        correlate: 'attempt_id' as const,
        flowStep: `task_${action}` as const
      },
      platforms: BOTH,
      producerStatus: 'emitted' as const,
      source: 'events' as const,
      unobservable: [
        'No title, description, attachment, assignee identity, account tag or task content is collected.',
        'RPC completion proves a validated server response, not a visible board, editor or another user’s delivery.',
        'Editor refresh completion follows a committed render in a visible document; it is not proof of user attention or pixels. Implicit preserve-draft retains local fields and their original conflict version. Explicit Keep mine selects the reviewed version and still rejects any further change; Take their version applies the newest confirmed snapshot for the same task.',
        'Missing terminal after browser interruption remains unknown. An absent refresh cannot prove no server update; inspect the protected current task and version before retrying.',
        'A list response covers its server page, not visibility of each row. In-memory reply correlation can be lost across transformed objects or reload; only observed flow links may be joined.'
      ],
      note: '036 T106: separate attempts for API create/list/read/update, clean editor refresh and local-draft preservation. Opaque flow/attempt IDs only. Task-object UUID may correlate later edits and refreshes without content. Closed failures map to authority and UI sources; raw exception messages are never recorded. Historical task events remain unsupported and cannot be reconstructed.'
    })
  ),
  {
    id: 'team.accounts_finance',
    tool: 'team',
    title: 'Team · accounts and finance metadata',
    stages: ['view', 'edit'],
    stageEvents: {},
    start: [],
    terminal: [],
    platforms: BOTH,
    unobservable: [
      'Full aggregate proof requires all accounts sub-capabilities and separate visible evidence; old builds and missing browser evidence stay unknown.'
    ],
    producerStatus: 'pending_producer',
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
    sinceWebBuild: LINK_SINCE_WEB_BUILD,
    note: 'API calls and subresource ticket requests share api/request-failures.ts. Current ticket 401/403 and transport failures reach the existing AgentProvider inconsistency/loss/recheck flow; stale replies from a replaced origin/session are discarded without blaming the new link. subresource-tickets, subresource-request-failures, subresource-repair, link-owner and analytics-connection-command regressions cover the producer, observer, recovery owner and read-only diagnosis. Legacy clients can emit link events without the ticket producer, so absent ticket failures are not proof of zero failures. Other HTTP/protocol failures remain unknown from these link events. A confirmed ticket or repaired URL is not image/media visibility; native display/output evidence is still needed.'
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
    id: 'account.session_logout',
    tool: 'onboarding',
    title: 'Account · coordinated SDK logout',
    stages: ['requested', 'lane_acquired', 'terminal'],
    stageEvents: {
      requested: ['operation_started'],
      lane_acquired: ['operation_stage_started'],
      terminal: ['operation_completed', 'operation_failed', 'operation_cancelled']
    },
    start: [
      { event: 'operation_started', correlate: 'attempt_id', flowStep: 'auth_session_sdk_logout' }
    ],
    terminal: [
      {
        event: 'operation_completed',
        correlate: 'attempt_id',
        flowStep: 'auth_session_sdk_logout'
      },
      { event: 'operation_failed', correlate: 'attempt_id', flowStep: 'auth_session_sdk_logout' },
      { event: 'operation_cancelled', correlate: 'attempt_id', flowStep: 'auth_session_sdk_logout' }
    ],
    platforms: BOTH,
    source: 'events',
    producerStatus: 'emitted',
    unobservable: [
      'Anonymous or already-lost sessions cannot emit actor-attributed diagnostics. Never inherit the current replacement actor.',
      'SDK signout can clear analytics identity before acquisition or terminal delivery; missing evidence remains unknown, including a still-running SDK request.',
      'A completed SDK boundary does not prove browser UI settlement, committed recovery retirement or native protected-key cleanup.',
      'Older tabs not participating in the session lane and physical-browser ordering require separate compatibility acceptance.'
    ],
    note: 'One attempt joins requested, lane acquisition and the SDK outcome using the same actor. Only closed failure codes are collected. Superseded means the old logout was abandoned. Acquisition waits expire after10seconds; an acquired SDK operation is never released early by that timer. Missing terminal remains a coverage gap, never a fabricated success. Real typed producer, session ownership and read-only command regressions are separate from automatic beta collection.'
  },
  {
    id: 'account.profile_refresh',
    tool: 'onboarding',
    title: 'Account · profile refresh',
    stages: ['requested', 'terminal'],
    stageEvents: {
      requested: ['operation_started'],
      terminal: ['operation_completed', 'operation_failed', 'operation_cancelled']
    },
    start: [
      { event: 'operation_started', correlate: 'attempt_id', flowStep: 'auth_profile_refresh' }
    ],
    terminal: [
      { event: 'operation_completed', correlate: 'attempt_id', flowStep: 'auth_profile_refresh' },
      { event: 'operation_failed', correlate: 'attempt_id', flowStep: 'auth_profile_refresh' },
      { event: 'operation_cancelled', correlate: 'attempt_id', flowStep: 'auth_profile_refresh' }
    ],
    platforms: BOTH,
    source: 'events',
    producerStatus: 'emitted',
    unobservable: [
      'A terminal proves profile state publication or a closed read/write failure, not browser paint or delivery to every sibling tab.',
      'Closed, frozen, offline or storage-restricted tabs may not observe an invalidation until activation; no active-tab inventory is collected.',
      'Identity replacement suppresses late old-actor diagnostics. Missing terminal or delivery stays unknown rather than borrowing another actor outcome.'
    ],
    note: 'Opaque project-scoped invalidation triggers an authenticated read of the recipient own profile. Reads are bounded to10seconds, coalesced and retried on activation; late responses are fenced by identity/load/write revisions. No profile values, names, emails or credentials are collected. Update attempts and recipient refresh attempts are separate: there is no claim of end-to-end message acknowledgement.'
  },
  {
    id: 'account.profile_update',
    tool: 'onboarding',
    title: 'Account · profile update',
    stages: ['requested', 'terminal'],
    stageEvents: {
      requested: ['operation_started'],
      terminal: ['operation_completed', 'operation_failed', 'operation_cancelled']
    },
    start: [
      { event: 'operation_started', correlate: 'attempt_id', flowStep: 'auth_profile_update' }
    ],
    terminal: [
      { event: 'operation_completed', correlate: 'attempt_id', flowStep: 'auth_profile_update' },
      { event: 'operation_failed', correlate: 'attempt_id', flowStep: 'auth_profile_update' },
      { event: 'operation_cancelled', correlate: 'attempt_id', flowStep: 'auth_profile_update' }
    ],
    platforms: BOTH,
    source: 'events',
    producerStatus: 'emitted',
    unobservable: [
      'A terminal proves profile state publication or a closed read/write failure, not browser paint or delivery to every sibling tab.',
      'Closed, frozen, offline or storage-restricted tabs may not observe an invalidation until activation; no active-tab inventory is collected.',
      'Identity replacement suppresses late old-actor diagnostics. Missing terminal or delivery stays unknown rather than borrowing another actor outcome.'
    ],
    note: 'Opaque project-scoped invalidation triggers an authenticated read of the recipient own profile. Reads are bounded to10seconds, coalesced and retried on activation; late responses are fenced by identity/load/write revisions. No profile values, names, emails or credentials are collected. Update attempts and recipient refresh attempts are separate: there is no claim of end-to-end message acknowledgement.'
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
    id: 'team.recovery_retirement_ack',
    tool: 'team',
    title: 'Browser recovery retirement acknowledgement',
    stages: ['requested', 'terminal'],
    stageEvents: {
      requested: ['operation_started'],
      terminal: ['operation_completed', 'operation_failed']
    },
    start: [
      { event: 'operation_started', correlate: 'attempt_id', flowStep: 'recovery_retirement_ack' }
    ],
    terminal: [
      {
        event: 'operation_completed',
        correlate: 'attempt_id',
        flowStep: 'recovery_retirement_ack'
      },
      { event: 'operation_failed', correlate: 'attempt_id', flowStep: 'recovery_retirement_ack' }
    ],
    platforms: BOTH,
    producerStatus: 'emitted',
    source: 'events',
    unobservable: [
      'Missing browser session or delivery can prevent these events reaching the collector. Missing evidence never proves server revocation.',
      'An acknowledgement failure can follow a committed server action; protected-key cleanup requires separate native evidence.'
    ],
    note: 'The exact attempt is also the observed server-RPC key. Closed acknowledgement categories carry no credentials or provider text. Old-actor callbacks are dropped when the current analytics actor differs. Server receipts remain authoritative, and generic event coverage here proves browser acknowledgement observability only.'
  },
  {
    id: 'team.recovery_retirement',
    tool: 'team',
    title: 'Team · native recovery retirement',
    stages: [...RECOVERY_RETIREMENT_STAGES],
    stageEvents: {},
    start: [],
    terminal: [],
    platforms: BOTH,
    source: 'authoritative_table',
    producerStatus: 'emitted',
    unobservable: [
      'Native observations reach the server only when the browser forwards the bounded journal. Missing delivery never proves retirement.',
      'Browser server receipts and acknowledgements are diagnosed separately. Without a usable matching session, delivery may be absent; neither receipt nor acknowledgement proves native protected-key cleanup.',
      'One native instance observation is not a live status check and cannot order different boots by wall clock alone.'
    ],
    note: 'The worker emits only a closed phase and opaque delegation ID, after durable local preparation or acknowledgement commits. investigate distinguishes pending server, confirmed server with unfinished protected-key cleanup and observed local completion. audit reads matching journal groups by per-instance sequence, not unrelated sync jobs. Browser server outcome can be proven by the separate committed receipt; native cleanup and original-actor attribution still require their own evidence and keep this capability partial.'
  },
  {
    id: 'team.tariff_recovery',
    tool: 'team',
    title: 'Team · tariff pause and recovery',
    stages: ['registered', 'queued', 'claimed', 'started', 'terminal', 'delivered'],
    stageEvents: {},
    start: [],
    terminal: [],
    platforms: BOTH,
    source: 'authoritative_table',
    producerStatus: 'emitted',
    unobservable: [
      'A queued schedule is not a worker start.',
      'A server terminal without a correlated output observation has unknown user delivery.',
      'Eligible terminal lifecycle histories older than 30 days can be pruned; absence is not proof of successful recovery.'
    ],
    note: 'Durable pause provenance, actor checks, original attempts and recovery items are read through analytics_workspace_recovery. inspect and investigate expose safe reasons and last proven stages; audit refuses unrelated sync rows as recovery proof. The separate immutable execution reservation is read through analytics_recovery_execution even without a tariff recovery item. A reservation forbids replay but proves neither native start nor delivery. The reader bounds and scopes reservations by actor, team or operation and excludes future reservations at as-of; an older database leaves an explicit projection gap. Lifecycle cleanup retains unresolved dependencies and at least 30 days of terminal history; each retention class and lifecycle-root deletion is bounded to 100 candidates per sweep, with locked candidates skipped. Cascaded descendant counts and overall dispatch time are not a fixed bound. Current complete acceptance and LOAD resource measurements remain required.'
  },
  {
    id: 'team.tariff',
    tool: 'team',
    title: 'Team · space tariff (showcase → contact → granted)',
    stages: ['showcase', 'contact', 'granted'],
    stageEvents: {
      showcase: ['space_showcase_viewed'],
      contact: ['space_contact_clicked'],
      granted: ['space_tariff_granted']
    },
    start: [{ event: 'space_showcase_viewed', correlate: 'none' }],
    terminal: [{ event: 'space_tariff_granted', correlate: 'none' }],
    platforms: BOTH,
    unobservable: [
      'unsent plan selection; external message sending, delivery and conversation (Telegram, mail)',
      'payment, which happens outside the product',
      'Tariff recovery is incomplete: recurring schedules restore server-side, but a restored interval does not prove first worker start, output or browser delivery. One-off checkpoints, background agent delegation and correlated recovery diagnosis remain unverified (034 T033–T038 / 036).'
    ],
    producerStatus: 'emitted',
    source: 'events',
    note: 'Before the workspace announcement, the public entry emits screen_viewed with screen_identifier=space_coming_soon instead of space_showcase_viewed; no contact or grant is expected from that screen. Missing screen delivery remains unknown. The grant is emitted by the administrator’s browser, not the owner’s; the authoritative record is space_tariffs / space_tariff_events. Local acceptance mail capture reports its own claim, capture and database-commit result. A skipped notice and a matching redacted local artifact prove neither provider delivery nor user receipt; an unconfirmed commit and absent artifact remain explicit. This tooling evidence is separate from production mail diagnostics.'
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
  },
  {
    id: 'settings.theme',
    tool: 'analytics',
    title: 'Display theme preference',
    stages: ['theme_observed'],
    stageEvents: { theme_observed: ['setting_changed'] },
    start: [{ event: 'setting_changed', correlate: 'none', flowStep: 'theme' }],
    terminal: [],
    platforms: BOTH,
    unobservable: [
      'Users on builds predating this signal and users who do not open the app during the period have no observed preference.',
      'Only the latest received signal in a period is counted; an absent signal is unknown.'
    ],
    producerStatus: 'emitted',
    source: 'events',
    note: "Isolated by flow_step='theme' and setting_name='theme'; setting_value is light or dark. The `themes` command groups users by their latest signal in the period."
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
