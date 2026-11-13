import { RESTITCH_RECOVERY_ERROR_CODES } from '../../packages/shared/src/team/restitch-recovery-errors.js';
import { STITCH_ERROR_CODES } from '../../packages/shared/src/stitch-errors.js';
import { CATALOG_IMAGE_ERROR_CODES } from '../../packages/shared/src/team/catalog-images.js';
import { CATALOG_VIDEO_R2_REASONS } from '../../packages/shared/src/team/catalog-video-r2.js';
import {
  AUTH_SESSION_MUTATION_CODES,
  MACOS_STARTUP_CODES,
  PROFILE_SYNC_CODES,
  WORKSPACE_READ_CODES
} from '../../packages/shared/src/types.js';
import { RECOVERY_REASONS } from '../../packages/shared/src/team/recovery.js';
import { ACCOUNT_ANALYTICS_CODES } from '../../packages/shared/src/team/analytics.js';
/**
 * 033 FR-008 — where a failure starts in the code, by its fingerprint.
 *
 * Every `error_fingerprint` the web sends is `<tool>:<stage>:<code>` with the code from one of
 * the agent's closed lists (`packages/shared/src/types.ts`) and the stage from the web's
 * code→stage map (`apps/web/src/analytics/errors.ts`, `compression.ts`). Every record the
 * agent writes to its diagnostics journal is `journal:<category>:<code>`; every link reason is
 * `link:<reason>`; a failed `tool_ready` is `readiness:<stage>:<code>`.
 *
 * For each key the map names the repo-relative files where that failure originates (agent)
 * and where it is surfaced (web), plus one sentence on what to check first. `investigate`
 * attaches the entry to each finding as `code_locations`, so an agent fixing a complaint
 * knows which file to open without asking anyone.
 *
 * `tests/analytics-code-map.test.ts` fails when a code of a closed list, a journal
 * (category, code) pair written in `apps/agent/src`, or a link reason has no entry, when a
 * stage here disagrees with the web's map, and when a listed file does not exist.
 *
 * The check sentences are printed by the CLI, so they never contain a path, an address or a
 * credential word.
 */

export interface CodeLocation {
  /** Repo-relative paths under product source roots, including the native Windows host; origin first, then surface. */
  files: string[];
  /** One sentence: what to verify first. */
  check: string;
}

/** What `lookupCodeLocations` returns: the entry and which key it came from. */
export interface CodeLocationMatch extends CodeLocation {
  fingerprint: string;
  /** The key that matched: the fingerprint itself or a `…:*` fallback. */
  matched: string;
}

/* ---------------------------------------------------------------------------
 * Shared file groups
 * ------------------------------------------------------------------------- */

const SHARED_TYPES = 'packages/shared/src/types.ts';
const WEB_ERRORS = 'apps/web/src/analytics/errors.ts';
const WEB_COMPRESSION = 'apps/web/src/analytics/compression.ts';
const WEB_APP = 'apps/web/src/App.tsx';
const WEB_TRANSCRIPTION = 'apps/web/src/transcription/TranscriptionPage.tsx';
const WEB_STITCHER = 'apps/web/src/stitcher/StitcherPage.tsx';
const WEB_LANDING = 'apps/web/src/landing/LandingOptimizerPage.tsx';
const WEB_LINK = 'apps/web/src/analytics/link.ts';
const WEB_CONNECTION = 'apps/web/src/connection.ts';
const WEB_AGENT_CONTEXT = 'apps/web/src/AgentContext.tsx';

const AGENT_QUEUE = 'apps/agent/src/queue/queue.ts';
const AGENT_FFMPEG_TOOLS = 'apps/agent/src/ffmpeg/tools.ts';
const AGENT_FAILURE_CODES = 'apps/agent/src/server/failure-codes.ts';
const AGENT_IMAGES = 'apps/agent/src/images/store.ts';
const AGENT_ESTIMATE = 'apps/agent/src/estimate/worker.ts';
const AGENT_TRANSCRIPTION_QUEUE = 'apps/agent/src/queue/transcription-queue.ts';
const AGENT_TRANSCRIPTION_STORE = 'apps/agent/src/queue/transcription-store.ts';
const AGENT_TRANSLATION = SHARED_TYPES;
const AGENT_TRANSLATOR = SHARED_TYPES;
const AGENT_WHISPER_DOWNLOADER = 'apps/agent/src/whisper/downloader.ts';
const AGENT_WHISPER_TRANSCRIBER = 'apps/agent/src/whisper/transcriber.ts';
const AGENT_STITCH_QUEUE = 'apps/agent/src/stitcher/queue.ts';
const AGENT_STITCH_PLAN = 'apps/agent/src/stitcher/plan.ts';
const AGENT_STITCH_PROBE = 'apps/agent/src/stitcher/probe.ts';
const AGENT_STITCH_PIPELINE = 'apps/agent/src/stitcher/pipeline.ts';
const AGENT_STITCH_SEGMENTS = 'apps/agent/src/stitcher/segments.ts';
const AGENT_STITCH_BODY = 'apps/agent/src/stitcher/body-cache.ts';
const AGENT_STITCH_SILENCE = 'apps/agent/src/stitcher/silence.ts';
const AGENT_STITCH_ROUTES = 'apps/agent/src/stitcher/routes.ts';
const AGENT_LANDING = 'apps/agent/src/landing/optimizer.ts';
const AGENT_LANDING_WORKSPACE = 'apps/agent/src/landing/workspace.ts';
const AGENT_LANDING_REFERENCES = 'apps/agent/src/landing/references.ts';
const AGENT_JOURNAL = 'apps/agent/src/server/diagnostics-log.ts';

/* ---------------------------------------------------------------------------
 * <tool>:<stage>:<code> — the agent's closed lists
 *
 * The stage of each code repeats the web's map; the test compares them, so a
 * change in `errors.ts` or `compression.ts` without a change here fails.
 * ------------------------------------------------------------------------- */

interface CodeSpec {
  stage: string;
  agent: string[];
  check: string;
}

const COMPRESSOR_WEB = [WEB_COMPRESSION, WEB_APP];

export const COMPRESSOR_CODES: Readonly<Record<string, CodeSpec>> = {
  UNSUPPORTED_MEDIA: {
    stage: 'input',
    agent: [AGENT_QUEUE],
    check:
      'Which container or codec the probe refused and whether the input filter should accept it.'
  },
  SOURCE_NOT_FOUND: {
    stage: 'input',
    agent: [AGENT_QUEUE],
    check: 'Whether the source moved or lost permission between adding it and the encode starting.'
  },
  MEDIA_TOOL_UNAVAILABLE: {
    stage: 'encode',
    agent: [AGENT_FFMPEG_TOOLS, AGENT_QUEUE],
    check:
      'Whether the bundled FFmpeg binary resolves and starts on this platform and architecture.'
  },
  DISK_FULL: {
    stage: 'output',
    agent: [AGENT_FAILURE_CODES, AGENT_QUEUE],
    check: 'How the out-of-space error is recognised and whether partial output is cleaned up.'
  },
  DESTINATION_NOT_WRITABLE: {
    stage: 'output',
    agent: [AGENT_QUEUE],
    check: 'The output destination permission check and the fallback folder choice.'
  },
  OUTPUT_VALIDATION_FAILED: {
    stage: 'output',
    agent: [AGENT_QUEUE],
    check: 'Which post-encode validation rejected the file (duration, streams or size).'
  },
  IMAGE_DAMAGED: {
    stage: 'image_embedding',
    agent: [AGENT_IMAGES, AGENT_QUEUE],
    check: 'Whether the stored screen image decodes and how the library marks a damaged entry.'
  },
  IMAGE_UNAVAILABLE: {
    stage: 'image_embedding',
    agent: [AGENT_IMAGES, AGENT_QUEUE, 'apps/agent/src/compressor/settings-validation.ts'],
    check:
      'Whether the explicit start or end choice still belongs to its enabled gallery and the frozen job image remains available.'
  },
  IMAGE_FILTER_GRAPH_INVALID: {
    stage: 'image_embedding',
    agent: [AGENT_QUEUE],
    check: 'The FFmpeg filter graph built for the end or start image and its size arguments.'
  },
  IMAGE_ADAPT_FAILED: {
    stage: 'image_embedding',
    agent: [AGENT_QUEUE],
    check: 'The image adaptation encode that fits the screen image to the output frame.'
  },
  FFMPEG_FAILED: {
    stage: 'encode',
    agent: [AGENT_QUEUE, AGENT_FFMPEG_TOOLS],
    check: 'The encoder arguments for this preset and the FFmpeg exit classification.'
  },
  PROCESSING_FAILED: {
    stage: 'encode',
    agent: [AGENT_QUEUE],
    check: 'The catch-all branch of the compression queue: which exception reached it unnamed.'
  }
};

export const ESTIMATE_CODES: Readonly<Record<string, CodeSpec>> = {
  SOURCE_NOT_FOUND: {
    stage: 'estimate',
    agent: [AGENT_ESTIMATE],
    check: 'Whether the source stat fails because the file moved or is not permitted.'
  },
  MEDIA_TOOL_UNAVAILABLE: {
    stage: 'estimate',
    agent: [AGENT_ESTIMATE, AGENT_FFMPEG_TOOLS],
    check: 'Whether FFmpeg and FFprobe start for the estimate worker on this platform.'
  },
  ESTIMATE_PROBE_FAILED: {
    stage: 'estimate',
    agent: [AGENT_ESTIMATE],
    check: 'Why FFprobe could not read the duration of this source.'
  },
  ESTIMATE_DURATION_UNAVAILABLE: {
    stage: 'estimate',
    agent: [AGENT_ESTIMATE],
    check: 'Whether the trims leave any duration to sample.'
  },
  ESTIMATE_SAMPLES_UNREADABLE: {
    stage: 'estimate',
    agent: [AGENT_ESTIMATE],
    check: 'Why fewer than half of the sample encodes produced output.'
  },
  ESTIMATE_IMAGE_DIMENSIONS_UNAVAILABLE: {
    stage: 'estimate',
    agent: [AGENT_ESTIMATE],
    check: 'Whether the output frame size is known before the image estimate runs.'
  },
  IMAGE_DAMAGED: {
    stage: 'estimate',
    agent: [AGENT_ESTIMATE, AGENT_IMAGES],
    check: 'Whether the screen image used by the estimate decodes.'
  },
  IMAGE_UNAVAILABLE: {
    stage: 'estimate',
    agent: [AGENT_ESTIMATE, AGENT_IMAGES],
    check: 'Whether the screen image used by the estimate is still in the library.'
  },
  ESTIMATE_IMAGE_SAMPLE_FAILED: {
    stage: 'estimate',
    agent: [AGENT_ESTIMATE],
    check: 'The sample encode of the screen image and its filter arguments.'
  },
  ESTIMATE_INSUFFICIENT_DATA: {
    stage: 'estimate',
    agent: [AGENT_ESTIMATE],
    check: 'How the sample sizes are combined and which input made the sum unusable.'
  },
  DISK_FULL: {
    stage: 'estimate',
    agent: [AGENT_ESTIMATE, AGENT_FAILURE_CODES],
    check: 'Whether the temporary sample folder could be written and is cleaned up afterwards.'
  }
};

const TRANSCRIPTION_WEB = [WEB_ERRORS, WEB_TRANSCRIPTION];

export const TRANSCRIPTION_CODES: Readonly<Record<string, CodeSpec>> = {
  FEATURE_RETIRED: {
    stage: 'transcribe',
    agent: [
      'apps/agent/src/transcription/routes.ts',
      'apps/agent/src/team-bridge/routes.ts',
      'apps/agent/src/team-bridge/process.ts',
      'apps/agent/src/team-bridge/library.ts'
    ],
    check: 'An obsolete command was refused; no new execution was accepted.'
  },
  MODEL_MISSING: {
    stage: 'model',
    agent: [AGENT_TRANSCRIPTION_QUEUE, AGENT_WHISPER_DOWNLOADER],
    check:
      'Whether the speech model download finished and the queue looks for it in the same place.'
  },
  MEDIA_TOOL_UNAVAILABLE: {
    stage: 'transcribe',
    agent: [AGENT_TRANSCRIPTION_QUEUE, AGENT_FFMPEG_TOOLS],
    check: 'Whether FFmpeg or whisper failed to spawn (look for spawn exits in the journal).'
  },
  AUDIO_EXTRACT_FAILED: {
    stage: 'input',
    agent: [AGENT_TRANSCRIPTION_QUEUE],
    check: 'The FFmpeg audio extraction arguments for this source and its audio streams.'
  },
  TRANSCRIBE_FAILED: {
    stage: 'transcribe',
    agent: [AGENT_TRANSCRIPTION_QUEUE, AGENT_WHISPER_TRANSCRIBER],
    check: 'Why whisper exited without a transcript: exit classification and chunk handling.'
  },
  DOCUMENT_WRITE_FAILED: {
    stage: 'save',
    agent: [AGENT_TRANSCRIPTION_QUEUE],
    check: 'The transcript document write and the destination folder permissions.'
  },
  DOCUMENT_UNAVAILABLE: {
    stage: 'save',
    agent: [AGENT_TRANSCRIPTION_STORE],
    check: 'How the store restores a completed job whose saved document went missing.'
  },
  INTERRUPTED: {
    stage: 'transcribe',
    agent: [AGENT_TRANSCRIPTION_STORE],
    check: 'Whether the local app stopped mid-run (shutdown or boot records in the journal).'
  },
  DISK_FULL: {
    stage: 'transcribe',
    agent: [AGENT_TRANSCRIPTION_QUEUE],
    check: 'How the out-of-space error is recognised in the extract and transcribe steps.'
  },
  TRANSLATION_FAILED: {
    stage: 'translate',
    agent: [AGENT_TRANSLATION],
    check: 'Historical error from an older producer; current API6 cannot execute this command.'
  },
  TRANSLATOR_UNAVAILABLE: {
    stage: 'translate',
    agent: [AGENT_TRANSLATOR, AGENT_TRANSLATION],
    check: 'Historical unavailable error; retained installations are inert on API6.'
  }
};

const STITCH_WEB = [WEB_ERRORS, WEB_STITCHER];
const PLAN_CHECK = (what: string) =>
  `Which input the stitch planner refused for ${what} and whether the rule is right.`;

export const STITCH_CODES: Readonly<Record<string, CodeSpec>> = {
  ...Object.fromEntries(
    RESTITCH_RECOVERY_ERROR_CODES.map(code => [
      code,
      {
        stage: 'stitch',
        agent: [
          'apps/agent/src/team-bridge/screen-recovery.ts',
          'supabase/functions/drive-ops/restitch-root.ts',
          'supabase/migrations/20261207157000_restitch_candidate_versions.sql',
          'supabase/migrations/20261207158000_restitch_pool_admission.sql',
          'supabase/functions/drive-ops/restitch-range-authority.ts',
          'supabase/functions/drive-ops/restitch-range-issue.ts',
          'supabase/functions/drive-ops/restitch-range-dispatch.ts',
          'supabase/migrations/20261207162000_restitch_screen_range_authority.sql',
          'supabase/functions/drive-ops/restitch-range-reader.ts',
          'supabase/functions/drive-ops/restitch-range-source.ts',
          'supabase/functions/drive-ops/restitch-selection-store.ts',
          'supabase/migrations/20261207156000_restitch_frozen_range_context.sql',
          'packages/shared/src/team/restitch-selection.ts'
        ],
        check:
          'Inspect the bound slot budget and last confirmed acquisition. Complete pool exhaustion, remembered defects, resource limits and uncertain accounting are distinct; an unknown reservation never permits another transfer.'
      }
    ])
  ),
  STITCH_INTERRUPTED: {
    stage: 'stitch',
    agent: [AGENT_STITCH_QUEUE],
    check: 'Whether the local app stopped mid-stitch (shutdown or boot records in the journal).'
  },
  STITCH_TOOL_FAILED: {
    stage: 'stitch',
    agent: [AGENT_STITCH_QUEUE],
    check: 'The unexpected-exception branch of the stitch queue: which error reached it.'
  },
  STITCH_PATH_INVALID: {
    stage: 'input_probe',
    agent: [AGENT_STITCH_QUEUE, AGENT_STITCH_ROUTES, AGENT_STITCH_PROBE],
    check: 'Whether the chosen source still resolves and passes the probe.'
  },
  STITCH_PLAN_VIDEO_CODEC: {
    stage: 'input_probe',
    agent: [
      'apps/agent/src/team-bridge/process.ts',
      'apps/agent/src/team-bridge/restitch.ts',
      AGENT_STITCH_QUEUE,
      AGENT_STITCH_PLAN
    ],
    check: PLAN_CHECK('its video codec')
  },
  STITCH_PLAN_AUDIO_CODEC: {
    stage: 'input_probe',
    agent: [
      'apps/agent/src/team-bridge/process.ts',
      'apps/agent/src/team-bridge/restitch.ts',
      AGENT_STITCH_QUEUE,
      AGENT_STITCH_PLAN
    ],
    check: PLAN_CHECK('its audio codec')
  },
  STITCH_PLAN_VARIABLE_FRAME_RATE: {
    stage: 'input_probe',
    agent: [
      'apps/agent/src/team-bridge/process.ts',
      'apps/agent/src/team-bridge/restitch.ts',
      AGENT_STITCH_QUEUE,
      AGENT_STITCH_PLAN
    ],
    check: PLAN_CHECK('a variable frame rate')
  },
  STITCH_PLAN_CONTAINER: {
    stage: 'input_probe',
    agent: [
      'apps/agent/src/team-bridge/process.ts',
      'apps/agent/src/team-bridge/restitch.ts',
      AGENT_STITCH_QUEUE,
      AGENT_STITCH_PLAN
    ],
    check: PLAN_CHECK('its container')
  },
  STITCH_PLAN_UNREADABLE: {
    stage: 'input_probe',
    agent: [
      'apps/agent/src/team-bridge/process.ts',
      'apps/agent/src/team-bridge/restitch.ts',
      AGENT_STITCH_QUEUE,
      AGENT_STITCH_PROBE
    ],
    check: 'Why the probe could not read the source (stat, spawn or exit failure).'
  },
  STITCH_PLAN_NOTHING_TO_REMOVE: {
    stage: 'input_probe',
    agent: [AGENT_STITCH_QUEUE, AGENT_STITCH_PLAN],
    check: PLAN_CHECK('having nothing to remove')
  },
  STITCH_PLAN_NO_SCREENS: {
    stage: 'input_probe',
    agent: [AGENT_STITCH_QUEUE, AGENT_STITCH_PLAN],
    check: PLAN_CHECK('having no screens')
  },
  STITCH_OUTPUT_UNWRITABLE: {
    stage: 'output',
    agent: [AGENT_STITCH_QUEUE],
    check: 'The output folder permission check before the stitch writes.'
  },
  STITCH_VERIFICATION_FAILED: {
    stage: 'output',
    agent: [AGENT_STITCH_PIPELINE],
    check: 'Which post-stitch verification (duration, streams) disagreed with the plan.'
  },
  RESTITCH_SCREEN_UNAVAILABLE: {
    stage: 'stitch',
    agent: ['apps/agent/src/team-bridge/screen-cache.ts', 'apps/agent/src/team-bridge/restitch.ts'],
    check: 'Verify the granted picture is available to the local preparation.'
  },
  RESTITCH_SCREEN_FETCH_FAILED: {
    stage: 'stitch',
    agent: ['apps/agent/src/team-bridge/screen-cache.ts', 'apps/agent/src/team-bridge/restitch.ts'],
    check: 'Check the picture transfer endpoint, grant and checksum before retrying preparation.'
  },
  RESTITCH_SCREEN_UNSUPPORTED: {
    stage: 'stitch',
    agent: [
      'apps/agent/src/team-bridge/screen-cache.ts',
      'apps/agent/src/team-bridge/screen-decode.ts',
      'apps/agent/src/team-bridge/restitch.ts'
    ],
    check:
      'Check the strict managed decode, frame and pixel ceiling; metadata alone does not establish usable image bytes.'
  },
  STITCH_IMAGE_UNAVAILABLE: {
    stage: 'stitch',
    agent: [AGENT_STITCH_PIPELINE, AGENT_IMAGES],
    check: 'Whether the screen image of the stitch is still in the image library.'
  },
  STITCH_JOIN_FAILED: {
    stage: 'stitch',
    agent: [AGENT_STITCH_PIPELINE],
    check: 'The final concat of screens and body and its FFmpeg exit.'
  },
  STITCH_AUDIO_MISMATCH: {
    stage: 'stitch',
    agent: [AGENT_STITCH_PIPELINE],
    check: 'Why the segment audio parameters disagree before the join.'
  },
  MEDIA_TOOL_UNAVAILABLE: {
    stage: 'stitch',
    agent: [AGENT_STITCH_PIPELINE, AGENT_FFMPEG_TOOLS],
    check: 'Whether FFmpeg starts for the stitcher (look for spawn exits in the journal).'
  },
  SILENCE_BANK_FAILED: {
    stage: 'stitch',
    agent: [AGENT_STITCH_SILENCE],
    check: 'The silence bank encode and its cache.'
  },
  SCREEN_ENCODE_FAILED: {
    stage: 'stitch',
    agent: [AGENT_STITCH_SEGMENTS],
    check: 'The screen picture encode arguments and the FFmpeg exit.'
  },
  SCREEN_SILENCE_FAILED: {
    stage: 'stitch',
    agent: [AGENT_STITCH_SEGMENTS],
    check: 'The silent audio track encode for a screen segment.'
  },
  SCREEN_MUX_FAILED: {
    stage: 'stitch',
    agent: [AGENT_STITCH_SEGMENTS],
    check: 'The mux of a screen picture with its silence.'
  },
  BODY_PREPARE_FAILED: {
    stage: 'stitch',
    agent: [AGENT_STITCH_BODY],
    check: 'Why the body cache could not prepare the main video.'
  },
  BODY_REMUX_FAILED: {
    stage: 'stitch',
    agent: [AGENT_STITCH_BODY],
    check: 'The body remux arguments and the FFmpeg exit.'
  },
  BODY_HEAD_FAILED: {
    stage: 'stitch',
    agent: [AGENT_STITCH_BODY],
    check: 'The head re-encode of the body around the first cut.'
  },
  BODY_TAIL_FAILED: {
    stage: 'stitch',
    agent: [AGENT_STITCH_BODY],
    check: 'The tail re-encode of the body around the last cut.'
  },
  BODY_AUDIO_MISMATCH: {
    stage: 'stitch',
    agent: [AGENT_STITCH_BODY],
    check: 'Why the body pieces disagree on audio parameters.'
  },
  BODY_RECOVERY_FAILED: {
    stage: 'stitch',
    agent: [AGENT_STITCH_BODY],
    check: 'Why full-body recovery failed after copied tracks disagreed.'
  },
  BODY_RECOVERY_VERIFICATION_FAILED: {
    stage: 'stitch',
    agent: [AGENT_STITCH_BODY, AGENT_STITCH_PIPELINE],
    check: 'Which recovered body track still disagreed with the planned duration.'
  },
  BODY_TIMING_UNREADABLE: {
    stage: 'stitch',
    agent: [AGENT_STITCH_BODY, 'apps/agent/src/ffmpeg/encoder.ts'],
    check: 'Why the keyframe timing of the body could not be read.'
  },
  BODY_JOIN_FAILED: {
    stage: 'stitch',
    agent: [AGENT_STITCH_BODY],
    check: 'The concat of the body head, middle and tail.'
  }
};

const LANDING_WEB = [WEB_ERRORS, WEB_LANDING];

export const LANDING_CODES: Readonly<Record<string, CodeSpec>> = {
  LANDING_WORKSPACE_LOST: {
    stage: 'upload',
    agent: [AGENT_LANDING, AGENT_LANDING_WORKSPACE],
    check: 'Whether the prepared working copy was cleaned up before the run started.'
  },
  MEDIA_TOOL_UNAVAILABLE: {
    stage: 'optimize',
    agent: [AGENT_LANDING, AGENT_FFMPEG_TOOLS],
    check: 'Whether FFmpeg and FFprobe start for the landing optimizer.'
  },
  DISK_FULL: {
    stage: 'package',
    agent: [AGENT_LANDING],
    check: 'How the out-of-space error is recognised while the landing is written.'
  },
  DESTINATION_NOT_WRITABLE: {
    stage: 'package',
    agent: [AGENT_LANDING],
    check: 'The destination permission check for the optimized folder or archive.'
  },
  LANDING_OPTIMIZE_FAILED: {
    stage: 'optimize',
    agent: [AGENT_LANDING],
    check: 'Which media pass failed outside any single file.'
  },
  LANDING_REWRITE_FAILED: {
    stage: 'package',
    agent: [AGENT_LANDING, AGENT_LANDING_REFERENCES],
    check: 'The reference rewrite of the landing pages.'
  },
  LANDING_PACKAGE_FAILED: {
    stage: 'package',
    agent: [AGENT_LANDING],
    check: 'The folder or archive packaging step.'
  }
};

/* ---------------------------------------------------------------------------
 * journal:<category>:<code> — every record the agent writes
 * ------------------------------------------------------------------------- */

interface JournalSpec {
  files: string[];
  check: string;
}

const AGENT_INDEX = 'apps/agent/src/index.ts';
const AGENT_SPAWN = 'apps/agent/src/power/spawn.ts';
const AGENT_APP = 'apps/agent/src/server/app.ts';
const AGENT_SSE = 'apps/agent/src/server/sse.ts';
const AGENT_PICKER = 'apps/agent/src/files/picker.ts';
const AGENT_DROP = 'apps/agent/src/files/dropped-source.ts';
const AGENT_ENTITLEMENT = 'apps/agent/src/entitlement/entitlement.ts';
const WEB_FORWARDER = 'apps/web/src/analytics/journal-forwarder.ts';

/** Keyed `<category>:<code>`; the test scans `apps/agent/src` for every literal pair. */
export const JOURNAL_CODES: Readonly<Record<string, JournalSpec>> = {
  'transcription:feature_retired': {
    files: [
      'apps/agent/src/transcription/routes.ts',
      'apps/agent/src/transcription/diagnostics.ts'
    ],
    check: 'An obsolete command was refused before execution; no run was started.'
  },
  'boot:started': {
    files: [AGENT_INDEX],
    check: 'A boot record: compare with the failure time to see whether the local app restarted.'
  },
  'boot:tools_probed': {
    files: [AGENT_INDEX, AGENT_FFMPEG_TOOLS],
    check: 'Which bundled media tools the boot probe found missing.'
  },
  'boot:listening': {
    files: [AGENT_INDEX],
    check: 'The local server came up; a failure right before it means the app was restarting.'
  },
  'shutdown:requested': {
    files: [AGENT_INDEX],
    check: 'Why the local app was asked to stop (reason prop) while work was running.'
  },
  'shutdown:completed': {
    files: [AGENT_INDEX],
    check: 'A clean stop; running jobs become interrupted on the next boot.'
  },
  'shutdown:failed': {
    files: [AGENT_INDEX],
    check: 'Which step of the shutdown sequence threw.'
  },
  'shutdown:listen_failed': {
    files: [AGENT_INDEX],
    check: 'The local server could not bind its port: another copy running or the port taken.'
  },
  'spawn:started': {
    files: [AGENT_SPAWN],
    check: 'A child tool started; pair it with the matching exited record.'
  },
  'spawn:exited': {
    files: [AGENT_SPAWN, AGENT_FFMPEG_TOOLS],
    check: 'The outcome prop: nonzero or spawn_error means the media tool itself failed to run.'
  },
  'stitcher:body_recovery_started': {
    files: [AGENT_STITCH_BODY],
    check: 'The reason prop identifies the copied body defect that triggered a full re-encode.'
  },
  'stitcher:pipeline_stage_started': {
    files: [AGENT_STITCH_PIPELINE, AGENT_STITCH_SILENCE, AGENT_STITCH_BODY],
    check:
      'Pair stage and runId with pipeline_stage_completed; an absent completion alone does not distinguish interruption from missing journal delivery.'
  },
  'stitcher:pipeline_failed': {
    files: [
      'apps/agent/src/team-bridge/restitch.ts',
      AGENT_STITCH_BODY,
      'supabase/migrations/20261206149100_catalog_failed_browser_process.sql'
    ],
    check:
      'Read the closed errorCode and correlated runId, then the catalog job retry and operation terminal. A native execution fence or provider upload remains uncertain and must not be replayed.'
  },
  'stitcher:automatic_frame_started': {
    files: ['apps/agent/src/team-bridge/restitch.ts'],
    check:
      'Automatic Launch end-frame extraction began for this operation; missing completion is interruption or missing journal delivery, not proof of success.'
  },
  'stitcher:automatic_frame_completed': {
    files: ['apps/agent/src/team-bridge/restitch.ts'],
    check:
      'The source frame exists locally; inspect later pipeline and finalization receipts to prove the video and catalog reached the user.'
  },
  'stitcher:automatic_frame_failed': {
    files: ['apps/agent/src/team-bridge/restitch.ts'],
    check:
      'Check cancellation and source decoding for the correlated operation; no image library or saved workspace setup is required.'
  },
  'stitcher:pipeline_stage_completed': {
    files: [AGENT_STITCH_PIPELINE, AGENT_STITCH_SILENCE, AGENT_STITCH_BODY],
    check:
      'Compare durationBucket by stage and body fromCache; body_recovery records explain a full re-encode. Completion of one stage is not delivery of the result.'
  },
  'stitcher:body_recovery_completed': {
    files: [AGENT_STITCH_BODY],
    check: 'The recovered body passed its track-length check; confirm the run later completed.'
  },
  'stitcher:body_recovery_failed': {
    files: [AGENT_STITCH_BODY],
    check: 'The reason and stage props identify why full-body recovery did not pass.'
  },
  'auth:route_budget_exceeded': {
    files: [AGENT_APP],
    check: 'The per-route request budget refused the page; look for a retry loop in the web.'
  },
  'auth:token_mismatch': {
    files: [AGENT_APP, 'apps/agent/src/server/session-token.ts', WEB_AGENT_CONTEXT],
    check: 'The page presented a stale pairing credential; check whether pairing was renewed.'
  },
  'auth:limiter_hit': {
    files: [AGENT_APP],
    check: 'The auth limiter refused repeated bad attempts; the page kept retrying a stale pairing.'
  },
  'auth:handshake': {
    files: [AGENT_APP, 'apps/web/src/api/pairing-token.ts'],
    check: 'The pairing handshake outcome prop and whether the page accepted it.'
  },
  'stream:subscribe': {
    files: [AGENT_SSE, 'apps/agent/src/server/stream.ts'],
    check: 'A page subscribed to the live stream; a missing one after a loss means no reconnect.'
  },
  'stream:close_all': {
    files: [AGENT_SSE],
    check: 'Every stream was closed (reason prop): the page should see a link loss right after.'
  },
  'stream:evict': {
    files: [AGENT_SSE],
    check: 'A stream was evicted for capacity, a failed write or a stall.'
  },
  'update:drain_requested': {
    files: [AGENT_QUEUE],
    check: 'An update asked the queues to drain; new work is refused until restart.'
  },
  'update:drain_idle': {
    files: [AGENT_QUEUE],
    check: 'The queues drained and the update could proceed.'
  },
  'drop:resolve_file': {
    files: [AGENT_DROP, 'apps/agent/src/platform/platform.ts'],
    check: 'Whether a dropped file was found in the usual folders or the OS index (outcome prop).'
  },
  'drop:resolve_folder': {
    files: [AGENT_DROP, 'apps/agent/src/platform/platform.ts'],
    check: 'Whether a dropped folder was found in the usual folders or the OS index.'
  },
  'entitlement:decision': {
    files: [AGENT_ENTITLEMENT],
    check: 'The account check decision and clock skew props; invalid blocks every tool.'
  },
  'auth:identity_publication_rejected': {
    files: [AGENT_ENTITLEMENT, 'apps/agent/src/server/app.ts', 'apps/web/src/api/entitlement.ts'],
    check:
      'Whether logout, account handoff or restart invalidated the captured publication revision; obtain a fresh authenticated exchange.'
  },
  'picker:launch': {
    files: [AGENT_PICKER],
    check: 'A native file dialog was launched; pair it with the exit record.'
  },
  'picker:exit': {
    files: [AGENT_PICKER, WEB_STITCHER],
    check:
      'The outcome prop: failed, unavailable or timeout means the native dialog never returned a choice.'
  },
  'picker:visibility_unknown': {
    files: [AGENT_PICKER],
    check: 'The dialog process never answered: it may have opened behind other windows.'
  }
};

/** A category with no exact entry still points at its subsystem. */
const JOURNAL_CATEGORY_FILES: Readonly<Record<string, JournalSpec>> = {
  boot: { files: [AGENT_INDEX], check: 'The boot sequence of the local app.' },
  shutdown: { files: [AGENT_INDEX], check: 'The shutdown sequence of the local app.' },
  stream: { files: [AGENT_SSE], check: 'The live stream between the local app and the page.' },
  auth: { files: [AGENT_APP], check: 'Request authentication on the local server.' },
  entitlement: { files: [AGENT_ENTITLEMENT], check: 'The account entitlement check.' },
  spawn: { files: [AGENT_SPAWN], check: 'Child process lifecycle of the media tools.' },
  picker: { files: [AGENT_PICKER], check: 'The native file dialog.' },
  drop: { files: [AGENT_DROP], check: 'Resolving dropped files to their originals.' },
  update: { files: [AGENT_QUEUE], check: 'The update drain of the local queues.' },
  power: {
    files: ['apps/agent/src/power/governor.ts'],
    check: 'The local resource budget governor.'
  },
  transcription: {
    files: ['apps/agent/src/transcription/diagnostics.ts', AGENT_TRANSCRIPTION_QUEUE],
    check:
      'Read accepted, saved and terminal separately; missing terminal or visibility remains unknown.'
  },
  stitcher: { files: [AGENT_STITCH_BODY], check: 'Prepared body recovery and verification.' },
  team: {
    files: ['apps/agent/src/team-bridge/routes.ts'],
    check: 'The team bridge of the local app.'
  }
};

/* ---------------------------------------------------------------------------
 * link:<reason> — why a link check failed (032)
 * ------------------------------------------------------------------------- */

const LINK_WEB = [WEB_CONNECTION, WEB_AGENT_CONTEXT, WEB_LINK];

export const LINK_REASON_CHECKS: Readonly<Record<string, JournalSpec>> = {
  not_running: {
    files: LINK_WEB,
    check: 'Whether the local app was running; a boot record afterwards means it was started later.'
  },
  not_installed: {
    files: LINK_WEB,
    check: 'Whether the page could ever reach the local app on this machine.'
  },
  blocked_by_browser: {
    files: [...LINK_WEB, 'apps/web/src/lib/browser.ts'],
    check:
      'Which browser family blocks the loopback request and whether the local copy was offered.'
  },
  pairing_rejected: {
    files: [...LINK_WEB, 'apps/web/src/api/pairing-token.ts', AGENT_APP],
    check:
      'Why the local app refused the pairing (auth journal records) and whether the page renews it.'
  },
  agent_too_old: {
    files: [...LINK_WEB, 'apps/agent/src/server/capabilities.ts'],
    check: 'The minimum local app version the page requires and the update prompt.'
  },
  web_too_old: {
    files: [...LINK_WEB, 'apps/agent/src/server/capabilities.ts'],
    check: 'The minimum page version the local app requires and the reload prompt.'
  },
  account_check_required: {
    files: [...LINK_WEB, AGENT_ENTITLEMENT],
    check: 'Whether the account check ran and what the entitlement decision was.'
  },
  account_check_unavailable: {
    files: [...LINK_WEB, AGENT_ENTITLEMENT, WEB_APP],
    check: 'Why the account check could not reach the server.'
  },
  update_in_progress: {
    files: [...LINK_WEB, AGENT_QUEUE],
    check: 'Whether an update drain was running (update journal records).'
  },
  timeout: {
    files: LINK_WEB,
    check: 'Which link stage timed out (link_stage) and whether the local app was busy or asleep.'
  },
  unknown: {
    files: LINK_WEB,
    check: 'The check ended without a classified reason; add one in the connection classifier.'
  }
};

/* ---------------------------------------------------------------------------
 * Assembly
 * ------------------------------------------------------------------------- */

function fromCodes(
  tool: string,
  specs: Readonly<Record<string, CodeSpec>>,
  web: string[],
  into: Record<string, CodeLocation>
): void {
  for (const [code, spec] of Object.entries(specs)) {
    if (tool === 'stitcher')
      into[`catalog:video:${code}`] = {
        files: unique([
          ...spec.agent,
          'apps/agent/src/team-bridge/restitch.ts',
          'apps/agent/src/team-bridge/recovery-worker.ts',
          'supabase/functions/team-recovery/handler.ts',
          'supabase/migrations/20261207100000_recovery_screen_failure_receipt.sql',
          'supabase/migrations/20261206149100_catalog_failed_browser_process.sql'
        ]),
        check:
          'Read the exact local processing failure and catalog retry state. A queued job with an open operation cannot be retried; provider upload or native execution uncertainty must remain fenced.'
      };
    into[`${tool}:${spec.stage}:${code}`] = {
      files: unique([...spec.agent, ...web, SHARED_TYPES]),
      check: spec.check
    };
  }
}

function unique(files: string[]): string[] {
  return [...new Set(files)];
}

function build(): Record<string, CodeLocation> {
  const map: Record<string, CodeLocation> = {};
  for (const [code, source] of Object.entries(STITCH_CODES)) {
    map[`team:process:${code}`] = {
      files: [
        ...source.agent,
        'apps/agent/src/team-bridge/process.ts',
        'apps/web/src/team/restitch/useRestitchDelivery.ts'
      ],
      check: source.check
    };
  }
  for (const code of ['AGENT_UPDATE_REQUIRED', 'RESTITCH_CLIENT_OUTDATED']) {
    map[`team:process:${code}`] = {
      files: [
        'apps/web/src/api/client.ts',
        'apps/web/src/team/restitch/claim.ts',
        'apps/web/src/team/catalog-updater/useRestitchPreparer.ts',
        'supabase/functions/drive-ops/updater-restitch.ts',
        'supabase/functions/team-recovery/handler.ts',
        'apps/agent/src/team-bridge/recovery-worker.ts'
      ],
      check:
        'Inspect the actual installed executor probe before the cloud claim. For native background claims inspect the installed executor declaration and durable replay, rather than assuming the broker version. An old local app and an old page need different recovery; refusal and idle claims do not prove processing or video delivery.'
    };
  }
  for (const stage of ['download', 'process'])
    map[`team:${stage}:RESTITCH_INVALID`] = {
      files: [
        'supabase/functions/drive-ops/restitch-root.ts',
        'supabase/migrations/20261207158000_restitch_pool_admission.sql',
        'apps/web/src/team/restitch/useRestitchDelivery.ts',
        'supabase/functions/drive-ops/updater-restitch.ts'
      ],
      check:
        'The accepted settings or requested preparation are invalid. Confirm source mode, enabled slots and the immutable recipe; this refusal is not proof that every image is broken.'
    };
  map['restitch:selection:accounting'] = {
    files: [
      'supabase/functions/drive-ops/restitch-executor.ts',
      'supabase/migrations/20261207160000_restitch_owned_executor.sql',
      'supabase/functions/drive-ops/restitch-selection-store.ts',
      'supabase/functions/drive-ops/restitch-range-reader.ts',
      'supabase/functions/drive-ops/restitch-range-authority.ts',
      'supabase/functions/drive-ops/restitch-range-issue.ts',
      'supabase/functions/drive-ops/restitch-range-dispatch.ts',
      'supabase/migrations/20261207162000_restitch_screen_range_authority.sql',
      'supabase/migrations/20261207156000_restitch_frozen_range_context.sql',
      'supabase/functions/drive-ops/restitch-range-source.ts',
      'supabase/migrations/20261207155000_restitch_selection_storage.sql',
      'packages/shared/src/team/restitch-selection.ts'
    ],
    check:
      'Inspect the original executor epoch, slot and exact reservation. Superseded claims never authorize new reads. A held range proves neither an upstream read nor its absence. Preserve unknown accounting and confirm recorded measurements before issuing more work.'
  };
  const materialLinkFiles = [
    'supabase/functions/library-ops/share-resolution.ts',
    'supabase/functions/library-ops/index.ts',
    'supabase/migrations/20261207140000_material_share_intents.sql',
    'apps/web/src/team/materials/useMaterialLink.ts',
    'apps/web/src/team/materials/MaterialActionHost.tsx'
  ];
  for (const code of [
    'CATALOG_LINK_UNAVAILABLE',
    'CATALOG_LINK_SHARING_UNCERTAIN',
    'CATALOG_LINK_REQUEST_EXPIRED',
    'CATALOG_LINK_UPDATE_REQUIRED'
  ])
    map[`team:library:${code}`] = {
      files: materialLinkFiles,
      check:
        'Separate the verified provider URL from visibility and permission intent. Inspect the retained per-file share receipt and opaque authority version. Unknown acknowledgement never permits another POST; read status with the original actor. An expired or legacy confirmation needs a fresh read, not an old mutation fallback.'
    };
  map['catalog:stop:*'] = {
    files: [
      'apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx',
      'apps/web/src/api/team.ts',
      'supabase/migrations/20261207135000_catalog_cancel_observed_round.sql',
      'supabase/migrations/20261207137000_catalog_legacy_stop_hold.sql'
    ],
    check:
      'Separate the browser Stop reply, read-only Check, visible feedback and current target attempt. Preserve provider and execution holds; never repeat a write to infer its result. Missing or conflicting evidence is unknown.'
  };
  map['team:library:PROCESS_RESULT_UNCERTAIN'] = {
    files: [
      'supabase/functions/drive-ops/mutation-preflight.ts',
      'supabase/functions/drive-ops/index.ts',
      'supabase/migrations/20261207149000_bulk_trash_overlap_fence.sql',
      'apps/web/src/team/materials/file-operation-outcome.ts',
      'apps/web/src/team/materials/tail.ts',
      'apps/web/src/team/catalog/useMaterialActions.ts',
      'apps/web/src/team/explorer/ExplorerShell.tsx',
      'apps/web/src/team/catalog/TrashView.tsx'
    ],
    check:
      'Inspect the exact file operation receipt and its accepted generation. Historical success does not confirm the material is still in that state. A fulfilled request with a non-success state does not confirm trash or restore, permit companion mutation or establish quiescence. A replacement bulk group cannot bypass unresolved overlapping files, folders or frozen members; reconcile the original group.'
  };
  map['team:library:CLIPBOARD_UNAVAILABLE'] = {
    files: [
      'apps/web/src/team/materials/useMaterialLink.ts',
      'apps/web/src/team/materials/link-analytics.ts'
    ],
    check:
      'Clipboard refused after URL resolution. The selectable URL must remain visible; Copy retries clipboard only, never provider sharing. Clipboard contents and use elsewhere remain unobservable.'
  };
  map['team:library:TEAM_TRANSPORT_UNAVAILABLE'] = {
    files: [
      'apps/web/src/api/team.ts',
      'apps/web/src/team/catalog-updater/useCatalogCommands.ts',
      'apps/web/src/team/materials/useMaterialLink.ts'
    ],
    check:
      'The browser fetch failed without a server response. Reconcile the retained command identity; connectivity failure does not prove an in-flight mutation was absent.'
  };
  const claimQuarantine = {
    files: [
      'supabase/functions/catalog-updater/claim-preparation.ts',
      'supabase/migrations/20261207139000_catalog_claim_quarantine.sql'
    ],
    check:
      'The current lease found an open round without a running matching attempt. Its old terminal and provider receipts were preserved; review them before releasing the quarantine. Healthy sibling claims may continue.'
  };
  map['team:library:CATALOG_ATTEMPT_STATE_INCONSISTENT'] = claimQuarantine;
  map['catalog:update:CATALOG_ATTEMPT_STATE_INCONSISTENT'] = claimQuarantine;
  const publicationPending = {
    files: [
      'supabase/functions/catalog-updater/worker.ts',
      'supabase/functions/catalog-updater/nonvideo-writer.ts',
      'supabase/functions/drive-ops/catalog-publication.ts',
      'supabase/migrations/20261207169000_catalog_publication_jobs.sql',
      'supabase/migrations/20261207177000_catalog_nonvideo_preservation.sql',
      'supabase/migrations/20261207178000_catalog_growth_video_recipes.sql'
    ],
    check:
      'Inspect the original ordinary attempt, frozen growth recipe and publication reservation. Nonvideo changes preserve stored video cells; pending row growth waits for its exact ready recipe. Read due time, hold and verified active delivery before retrying; a refusal proves no new delivery.'
  };
  const variantAuthority = {
    files: [
      'apps/agent/src/team-bridge/recovery-worker.ts',
      'apps/agent/src/team-bridge/native-restitch-controller.ts',
      'supabase/functions/drive-ops/updater-variants.ts',
      'supabase/functions/drive-ops/catalog-video-set-admission.ts',
      'supabase/migrations/20261207168000_catalog_video_sets.sql',
      'supabase/migrations/20261207172000_catalog_updater_video_variants.sql'
    ],
    check:
      'Inspect the accepted set and original child request and server process identities. A provider-proof failure after admission retains the original manager command. Registered outputs do not prove catalog cells or browser delivery; unknown native work remains fenced.'
  };
  map['catalog:variants:*'] = variantAuthority;
  for (const code of [
    'UNKNOWN',
    'SOURCE_CHANGED',
    'PERMISSION_DENIED',
    'RESTITCH_INVALID',
    'DRIVE_UNAVAILABLE',
    'RATE_LIMITED',
    'PROCESS_RESULT_UNCERTAIN',
    'INVALID_RESPONSE',
    'SHARE_NOT_ALLOWED'
  ])
    map[`catalog:variants:${code}`] = variantAuthority;
  map['team:library:CATALOG_PUBLICATION_PENDING'] = publicationPending;
  map['catalog:update:CATALOG_PUBLICATION_PENDING'] = publicationPending;
  const unsupportedPublication = {
    files: [
      'supabase/functions/catalog-updater/publication-authority.ts',
      'supabase/functions/catalog-updater/publication-io.ts',
      'supabase/functions/catalog-updater/publication-cells.ts',
      'supabase/functions/catalog-updater/index.ts',
      'supabase/migrations/20261207176000_catalog_video_cell_publication.sql'
    ],
    check:
      'No supported cell writer is enabled for this target. Preserve the current delivery and inspect the job and writer capability; a saved schedule is not published delivery and does not authorize a whole-file replacement.'
  };
  map['team:library:CATALOG_WRITE_UNSUPPORTED'] = unsupportedPublication;
  map['catalog:update:CATALOG_WRITE_UNSUPPORTED'] = unsupportedPublication;
  map['catalog:update:PROCESS_RESULT_UNCERTAIN'] = {
    files: [
      'supabase/functions/catalog-updater/nonvideo-writer.ts',
      'supabase/functions/catalog-updater/publication-cells.ts',
      'supabase/functions/catalog-updater/index.ts',
      'supabase/migrations/20261207177000_catalog_nonvideo_preservation.sql',
      'supabase/migrations/20261207178000_catalog_growth_video_recipes.sql'
    ],
    check:
      'Read the original attempt, exact cell receipt and current row binding. An atomic marker alone does not prove current cell delivery; reconcile cells without replaying a dispatched write or releasing its reservation.'
  };

  map['team:library:CATALOG_STOP_TARGET_UNKNOWN'] = {
    files: [
      'apps/web/src/api/team.ts',
      'apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx',
      'supabase/migrations/20261207143000_catalog_actor_bound_mutations.sql'
    ],
    check:
      'Stop was refused before dispatch because the manager had no observed round. Refresh the catalog state and target that exact round; never fall back to stopping an unobserved current operation.'
  };
  map['team:library:CATALOG_COMMAND_UNSUPPORTED'] = {
    files: [
      'apps/web/src/api/team.ts',
      'supabase/migrations/20261207138000_catalog_command_receipts.sql'
    ],
    check:
      'The command RPC is absent from the server schema cache. This rejected request did not start work; apply the matching backend contract before retrying. Never fall back to an untracked writer.'
  };
  map['team:library:CATALOG_COMMAND_STORAGE_UNAVAILABLE'] = {
    files: [
      'apps/web/src/team/catalog-updater/catalogCommandJournal.ts',
      'apps/web/src/team/catalog-updater/catalogCommandCoordinator.ts',
      'apps/web/src/team/workspace/mutationJournal.ts',
      'apps/web/src/team/explorer/useBulkTrash.ts',
      'apps/web/src/team/catalog/TrashView.tsx'
    ],
    check:
      'The browser refused bounded pending-intent storage. A new request is not dispatched without its saved identity. A failure clearing a confirmed receipt is a local storage failure, not proof that the provider action failed. Do not infer that older unknown commands failed; reconcile their retained IDs.'
  };
  map['team:library:CATALOG_UPDATE_RECONCILIATION_REQUIRED'] = {
    files: [
      'supabase/migrations/20261207135000_catalog_cancel_observed_round.sql',
      'supabase/migrations/20261207137000_catalog_legacy_stop_hold.sql',
      'apps/web/src/api/team.ts',
      'apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx'
    ],
    check:
      'The provider outcome is still being reconciled. Refresh the authoritative attempt; do not claim it stopped or replay a write.'
  };
  for (const stage of ['download', 'process'])
    map[`team:${stage}:SOURCE_CHANGED`] = {
      files: [
        'apps/agent/src/team-bridge/transfer.ts',
        'apps/agent/src/team-bridge/restitch-screen-download.ts',
        'apps/agent/src/team-bridge/process.ts',
        'apps/agent/src/team-bridge/download.ts'
      ],
      check:
        'Compare the accepted source with the native terminal stage and safe integrity reason. A checksum mismatch refuses the bytes before processing; metadata identity changes remain distinct. Missing checksum or historical detail does not prove byte verification, and a failed source is not evidence that every image is broken.'
    };
  map['team:download:CATALOG_EXPORT_TOO_LARGE'] = {
    files: [
      'supabase/functions/drive-transfer/catalog-export.ts',
      'supabase/functions/_shared/drive.ts',
      'supabase/functions/drive-transfer/index.ts',
      'apps/web/src/team/catalog/useMaterialActions.ts'
    ],
    check:
      'The authorized native catalog export exceeded the provider ceiling; changing the local downloader cannot increase that export limit.'
  };
  for (const stage of ['download', 'process'])
    map[`team:${stage}:RESTITCH_SCREEN_SELECTION_LIMIT`] = {
      files: [
        'apps/agent/src/team-bridge/screen-decode.ts',
        'apps/agent/src/team-bridge/screen-cache.ts',
        'apps/web/src/team/restitch/screens.ts',
        'supabase/functions/drive-ops/updater-restitch.ts'
      ],
      check:
        'Inspect the consumed selection or scaled decode budget. A resource limit does not prove every image is broken and does not blacklist the source.'
    };

  for (const stage of ['download', 'process'])
    for (const code of RESTITCH_RECOVERY_ERROR_CODES)
      map[`team:${stage}:${code}`] = {
        files: [
          'apps/agent/src/team-bridge/screen-recovery.ts',
          'apps/agent/src/team-bridge/restitch-screen-download.ts',
          'supabase/functions/drive-ops/restitch-root.ts',
          'supabase/functions/drive-ops/restitch-executor.ts',
          'supabase/functions/drive-ops/restitch-range-authority.ts',
          'supabase/functions/drive-ops/restitch-range-issue.ts',
          'supabase/functions/drive-ops/restitch-range-dispatch.ts',
          'supabase/migrations/20261207162000_restitch_screen_range_authority.sql',
          'supabase/functions/drive-ops/restitch-range-reader.ts',
          'supabase/functions/drive-ops/restitch-range-source.ts',
          'supabase/functions/drive-ops/restitch-selection-store.ts',
          'supabase/migrations/20261207156000_restitch_frozen_range_context.sql',
          'packages/shared/src/team/restitch-selection.ts'
        ],
        check:
          'Inspect the original slot and acquisition, exact reservation and frozen provider mapping. A missing or canceled provider response cannot prove zero cost. Unknown accounting stops new transfers; only a complete eligible snapshot establishes exhaustion.'
      };

  map['catalog:video:*'] = {
    files: [
      'apps/agent/src/team-bridge/restitch.ts',
      'apps/web/src/team/catalog-updater/useRestitchPreparer.ts',
      'supabase/migrations/20261206149100_catalog_failed_browser_process.sql'
    ],
    check:
      'Inspect the correlated local journal and job operation. A generic processing failure does not prove native quiescence; retain provider and execution fences until the outcome is known.'
  };
  map['journal:team:catalog_variant_stage'] = {
    files: [
      'apps/agent/src/team-bridge/catalog-variant-executor.ts',
      'supabase/functions/drive-ops/catalog-video-set-store.ts',
      'supabase/migrations/20261207168000_catalog_video_sets.sql',
      'supabase/migrations/20261207199000_catalog_video_variant_retry.sql'
    ],
    check:
      'Read the original video set, child identity and bounded ready count. A prepared output is not a verified catalog publication; missing admission or dispatch evidence remains unknown. Stage retrying with retryAttempt 1 or 2 means the server proved the previous operation failed without output and requeued the variant; an unknown stage with no retrying after it is a variant that cannot be proven or has no retry left.'
  };
  map['journal:team:process_terminal'] = {
    files: [
      'apps/agent/src/team-bridge/transfer.ts',
      'apps/agent/src/team-bridge/process.ts',
      'apps/agent/src/team-bridge/native-restitch-controller.ts',
      'supabase/functions/drive-ops/process-finalize.ts',
      'supabase/functions/drive-ops/handler.ts'
    ],
    check:
      'Inspect operationId, last native stage, safe errorCode and optional sourceIntegrityReason. Missing binary integrity detail stays unknown. A failed native finalize may coexist with a running legacy server child; explicit Repeat retires only the matching child. The beta manual native controller correlates its terminal to the cloud root and preserves the trusted delivery phase when observed; an unknown phase must not be reconstructed. Missing journal delivery leaves the cause unknown.'
  };
  map['journal:team:screen_candidate_rejected'] = {
    files: ['apps/agent/src/team-bridge/screen-cache.ts', 'apps/web/src/team/restitch/screens.ts'],
    check:
      'A confirmed file-specific image failure was persisted for the next random draw. Correlate the operation and material; network and disk failures do not blacklist candidates. Repaired versions and changed settings can be checked again.'
  };
  map['journal:team:screen_fetch_failed'] = {
    files: [
      'apps/agent/src/team-bridge/screen-cache.ts',
      'apps/agent/src/team-bridge/recovery-worker.ts'
    ],
    check:
      'Read the closed transfer, checksum or cache-write reason. Historical missing reasons remain unknown; verify the native failure receipt and catalog retry before claiming recovery.'
  };
  map['team:process:LEASE_EXPIRED'] = {
    files: [
      'supabase/migrations/20261206146000_catalog_expired_browser_handoff.sql',
      'apps/web/src/team/catalog-updater/useRestitchPreparer.ts'
    ],
    check:
      'Inspect the expired or returned browser handoff and its replacement claim. Native execution reservations and provider upload receipts prohibit automatic replay; LEASE_EXPIRED alone does not prove delivery.'
  };
  fromCodes('compressor', COMPRESSOR_CODES, COMPRESSOR_WEB, map);
  fromCodes('compressor', ESTIMATE_CODES, COMPRESSOR_WEB, map);
  fromCodes('transcription', TRANSCRIPTION_CODES, TRANSCRIPTION_WEB, map);
  fromCodes('stitcher', STITCH_CODES, STITCH_WEB, map);
  fromCodes('landing-optimizer', LANDING_CODES, LANDING_WEB, map);

  // Tool and stage fallbacks: an `unknown` code, or a web-side code outside the lists.
  const toolFallback: Array<[string, string[], string]> = [
    [
      'compressor',
      [AGENT_QUEUE, ...COMPRESSOR_WEB],
      'The compression queue failure branch: which error left it without a code.'
    ],
    [
      'compressor:estimate',
      [AGENT_ESTIMATE, ...COMPRESSOR_WEB],
      'The estimate worker: which failure left it without a code.'
    ],
    [
      'transcription',
      [AGENT_TRANSCRIPTION_QUEUE, ...TRANSCRIPTION_WEB],
      'The transcription queue failure branch: which error left it without a code.'
    ],
    [
      'stitcher',
      [AGENT_STITCH_QUEUE, ...STITCH_WEB],
      'The stitch queue normalisation: which error string is not in the closed list.'
    ],
    [
      'stitcher:picker',
      [AGENT_PICKER, WEB_STITCHER],
      'The native file dialog for the stitcher: read the picker journal records around it.'
    ],
    [
      'stitcher:drop_resolve',
      [AGENT_DROP, WEB_STITCHER],
      'Resolving a dropped file to its original: read the drop journal records around it.'
    ],
    [
      'stitcher:settings_read',
      [AGENT_STITCH_ROUTES, WEB_STITCHER],
      'Reading the stitcher settings from the local app.'
    ],
    [
      'landing-optimizer',
      [AGENT_LANDING, ...LANDING_WEB],
      'The landing optimizer failure branch: which error left it without a code.'
    ],
    [
      'landing-preview',
      [
        'apps/agent/src/landing-preview/routes.ts',
        'apps/web/src/landing-preview/LandingPreviewPage.tsx',
        'apps/web/src/landing-viewer/useLandingViewer.ts'
      ],
      'The landing preview route and the page that opens, renders or refreshes it.'
    ],
    [
      'team',
      ['apps/agent/src/team-bridge/routes.ts', 'apps/web/src/team/processing/useTeamOperation.ts'],
      'The team bridge operation and the web hook that reported it.'
    ],
    [
      'team:transfer',
      ['apps/agent/src/team-bridge/transfer.ts', 'apps/web/src/team/catalog/useMaterialActions.ts'],
      'Inspect source range identity, measured binary checksum and upload acknowledgements between the local app and team storage.'
    ],
    [
      'team:process',
      [
        'apps/agent/src/team-bridge/process.ts',
        'apps/web/src/team/processing/useTeamOperation.ts',
        'apps/web/src/team/restitch/useRestitchDelivery.ts'
      ],
      'The team processing or restitch workflow step in the local app.'
    ],
    [
      'team:download',
      [
        'apps/agent/src/team-bridge/routes.ts',
        'apps/agent/src/team-bridge/download.ts',
        'apps/agent/src/team-bridge/restitch.ts',
        'apps/web/src/team/catalog/useMaterialActions.ts',
        'apps/web/src/team/restitch/useRestitchDelivery.ts',
        'apps/web/src/team/restitch/RestitchDeliveryNotices.tsx'
      ],
      'The download of a team material: for NO_SCREENS check that the HTTP route preserves the space screens and grants; for a blank page check terminal delivery notices.'
    ],
    [
      'team:library',
      [
        'apps/agent/src/team-bridge/library.ts',
        'apps/web/src/team/preview/previewAnalytics.ts',
        'apps/web/src/team/catalog/useMaterialActions.ts'
      ],
      'The team library action or preview that failed.'
    ],
    [
      'readiness',
      ['apps/web/src/lib/use-tool-state-read.ts', 'apps/web/src/analytics/readiness.ts', WEB_APP],
      'The first read of the tool state after the page opened: which request failed and why.'
    ],
    [
      'readiness:initial_read',
      ['apps/web/src/lib/use-tool-state-read.ts', 'apps/web/src/analytics/readiness.ts', WEB_APP],
      'The first state request of the tool page: status code and whether the link was up.'
    ],
    [
      'readiness:subscribe',
      ['apps/web/src/lib/use-tool-state-read.ts', AGENT_SSE],
      'The live stream subscription of the tool page.'
    ],
    ['link', LINK_WEB, 'The link classifier: which check failed and with which reason.'],
    [
      'journal',
      [AGENT_JOURNAL, WEB_FORWARDER],
      'The agent journal and its forwarder: whether the records reached the database.'
    ]
  ];
  for (const [prefix, files, check] of toolFallback) {
    map[`${prefix}:*`] = { files: unique(files), check };
  }

  map['team:library:LAUNCH_EDITOR_LOAD_FAILED'] = {
    files: ['apps/web/src/team/launches/DeferredLaunchEditor.tsx', WEB_ERRORS],
    check:
      'Whether loading launch settings failed, was cancelled, or reached the committed editor; correlate the settings attempt before retrying.'
  };

  map['team:library:LAUNCH_SESSION_LOAD_FAILED'] = {
    files: ['apps/web/src/team/launches/DeferredLaunchSession.tsx', WEB_ERRORS],
    check:
      'Whether loading the launch detail session failed, was cancelled, or reached the committed detail session; correlate the detail-session attempt before retrying.'
  };

  // `investigate`'s stale-agent hypothesis: the user runs an older local app than others do.
  map['agent:stale_version'] = {
    files: ['apps/web/src/components/ReleaseUpdateNotice.tsx', WEB_AGENT_CONTEXT, AGENT_QUEUE],
    check: 'Whether the update prompt was shown and why the local app was not updated.'
  };

  for (const [key, spec] of Object.entries(JOURNAL_CODES)) {
    map[`journal:${key}`] = { files: unique(spec.files), check: spec.check };
  }
  for (const [category, spec] of Object.entries(JOURNAL_CATEGORY_FILES)) {
    map[`journal:${category}:*`] = {
      files: unique([...spec.files, AGENT_JOURNAL]),
      check: spec.check
    };
  }
  for (const [reason, spec] of Object.entries(LINK_REASON_CHECKS)) {
    map[`link:${reason}`] = { files: unique(spec.files), check: spec.check };
  }
  const catalogGenerationFiles = [
    'supabase/functions/drive-ops/catalog-initial-video-authority.ts',
    'supabase/functions/drive-ops/catalog-initial-publication.ts',
    'supabase/functions/drive-ops/catalog-initial-recovery.ts',
    'supabase/migrations/20261207169000_catalog_publication_jobs.sql',
    'supabase/functions/drive-ops/product-catalog.ts',
    'supabase/functions/drive-ops/catalog-durable.ts',
    'supabase/functions/_shared/drive.ts',
    'packages/shared/src/team/material-category.ts',
    'apps/web/src/team/product-catalog/CreateProductCatalogDialog.tsx'
  ];
  map['catalog:generation:SOURCE_CHANGED'] = {
    files: catalogGenerationFiles,
    check:
      'Compare the selected live parent and media category with the indexed source before retrying. Keep the same intent while a provider result remains uncertain; this refusal does not require completion of the whole scan.'
  };
  map['catalog:generation:*'] = {
    files: catalogGenerationFiles,
    check:
      'Read the closed failure and last observed checkpoint, then verify the selected dependency before retrying the same intent. Missing cause or provider acknowledgement remains unknown.'
  };
  for (const code of [
    'INVALID_INPUT',
    'INVALID_RESPONSE',
    'SOURCE_CHANGED',
    'PERMISSION_DENIED',
    'NOT_FOUND',
    'SPACE_BLOCKED',
    'LEASE_MISMATCH',
    'NO_WORK',
    'LAUNCH_VERSION_CONFLICT',
    'LAUNCH_BUSY',
    'LAUNCH_URL_INVALID',
    'LAUNCH_SUB_INVALID',
    'LAUNCH_BUDGET_INVALID',
    'LAUNCH_RESULT_UNCERTAIN',
    'LAUNCH_INTERNAL_ERROR'
  ]) {
    map[`launches:generation:${code}`] = {
      files: [
        'supabase/functions/drive-ops/launches.ts',
        'supabase/functions/drive-ops/process-finalize.ts',
        'supabase/functions/drive-ops/launch-recovery.ts',
        'supabase/migrations/20261207097000_launch_cleanup_completion_proof.sql',
        'supabase/functions/drive-ops/handler.ts',
        'packages/shared/src/team/launches/validation.ts',
        'apps/web/src/team/errors.ts'
      ],
      check:
        'Verify the saved draft version, source expectation and last proven generation state before retrying.'
    };
  }
  for (const code of ['PERMISSION_DENIED', 'SPACE_BLOCKED']) {
    map[`launches:generation:${code}`].files.push(
      'supabase/migrations/20261201175000_launch_authority_loss_settlement.sql'
    );
  }
  map['launches:generation:LEASE_MISMATCH'].files.push(
    'supabase/migrations/20261201178000_launch_cleanup_lease_presence.sql',
    'supabase/functions/drive-ops/launch-recovery.ts'
  );
  map['launches:generation:LAUNCH_RESULT_UNCERTAIN'] = {
    files: [
      'supabase/functions/drive-ops/launch-catalog-video.ts',
      'supabase/migrations/20261207171000_launch_catalog_video_protocol.sql',
      'apps/web/src/team/launches/reply.ts',
      'apps/web/src/team/launches/useLaunchProgressWatch.ts',
      'apps/web/src/team/launches/preparation.ts',
      'apps/web/src/team/launches/useLaunchGeneration.ts',
      'supabase/migrations/20261201179000_launch_restitch_upload_phase.sql',
      'supabase/migrations/20261201181000_launch_restitch_upload_cancel_order.sql',
      'supabase/migrations/20261201182000_launch_restitch_orphan_cleanup.sql',
      'supabase/migrations/20261201184000_launch_video_cleanup_quiescence.sql',
      'supabase/migrations/20261201185000_launch_video_claim_requires_quiescence.sql',
      'supabase/migrations/20261201186000_launch_video_cleanup_dispatch.sql',
      'supabase/migrations/20261201187000_launch_video_cleanup_retry_backoff.sql',
      'supabase/migrations/20261201192000_launch_source_permission_cleanup.sql',
      'supabase/functions/drive-ops/launch-recovery.ts',
      'supabase/functions/drive-ops/index.ts',
      'apps/agent/src/team-bridge/process.ts'
    ],
    check:
      'Preflight read deadlines mean generation has not started; lost mutation replies require reconciliation with the same key. For cleanup, inspect native quiescence, provider ownership, consumer state and confirmed trash; silence never proves that restarting or deleting is safe.'
  };
  map['launches:generation:AGENT_REQUIRED'] = {
    files: [
      'supabase/functions/drive-ops/launch-catalog-video.ts',
      'apps/agent/src/team-bridge/catalog-video-foreground.ts',
      'apps/web/src/api/catalog-video-foreground-client.ts',
      'supabase/migrations/20261207180000_catalog_foreground_authority.sql',
      'apps/web/src/team/launches/restitch-runner.ts',
      'supabase/migrations/20261201153000_launch_restitch_waiting_reason.sql'
    ],
    check:
      'Before admission, distinguish a missing paired session executor from a transport failure using the original enrollment and request. Verified READY reuse needs no new executor. Manual work has a one-set native proof; do not enable broad recovery. Inspect current session validity, exact set binding, native redemption and physical child receipts separately. Preserve frozen identities and unknown provider outcomes during recovery.'
  };
  map['launches:generation:UNKNOWN'] = {
    files: [
      'supabase/functions/drive-ops/launch-catalog.ts',
      'supabase/functions/drive-ops/catalog-durable.ts',
      'supabase/functions/_shared/launch-failures.ts'
    ],
    check:
      'The cause is unknown. Inspect the last proven stage and child receipts; add a bounded failure code without logging configuration or output.'
  };
  for (const code of [
    'PROCESS_FAILED',
    'PROCESS_CANCELED',
    'AGENT_UPDATE_REQUIRED',
    'RESTITCH_INVALID',
    'RESTITCH_NO_SCREENS',
    'RESTITCH_POOL_EMPTY',
    'RESTITCH_SCREEN_SELECTION_LIMIT',
    ...RESTITCH_RECOVERY_ERROR_CODES,
    'RESTITCH_SOURCES_INVALID',
    'RESTITCH_CLIENT_OUTDATED',
    'RESTITCH_SCREEN_UNAVAILABLE',
    'RESTITCH_SCREEN_FETCH_FAILED',
    'RESTITCH_SCREEN_UNSUPPORTED',
    'RESTITCH_DEFAULTS_INVALID',
    'RESTITCH_SOURCE_FORBIDDEN',
    'WRONG_STATE'
  ]) {
    map[`launches:generation:${code}`] = {
      files: [
        'apps/web/src/team/launches/restitch-runner.ts',
        'apps/web/src/team/restitch/screens.ts',
        'apps/agent/src/team-bridge/restitch.ts',
        'supabase/migrations/20261202133000_launch_automatic_restitch.sql',
        'supabase/migrations/20261202134000_launch_restitch_pool_scope.sql',
        'supabase/migrations/20261201153000_launch_restitch_waiting_reason.sql',
        'supabase/migrations/20261201145000_launch_restitch_settlement.sql',
        'supabase/migrations/20261201149000_launch_restitch_explicit_retry.sql'
      ],
      check:
        'Inspect the bound child operation and its last proven stage. For missing screens, verify the effective shared or personal pool and source version; the Launch recovery link opens restitch settings. Retry explicitly with the frozen preparation; never restart a running or successful child.'
    };
  }
  // 047: a catalog video variant child reports its exact stitch/body/screen failure to Launch.
  for (const code of STITCH_ERROR_CODES) {
    const fingerprint = `launches:generation:${code}`;
    if (map[fingerprint]) continue;
    map[fingerprint] = {
      files: [
        'apps/agent/src/stitcher/plan.ts',
        'apps/agent/src/stitcher/run.ts',
        'apps/agent/src/stitcher/verify.ts',
        'apps/agent/src/stitcher/body-cache.ts',
        'apps/agent/src/stitcher/silence.ts',
        'apps/agent/src/team-bridge/process.ts',
        'packages/shared/src/stitch-errors.ts',
        'supabase/functions/drive-ops/catalog-video-generation.ts',
        'supabase/functions/drive-ops/launch-catalog-video.ts'
      ],
      check:
        'A variant child failed with this exact stitch code; the Launch keeps it instead of a generic wait. Inspect the child operation and its source (codec, frame rate, container) before retrying. Retrying the same source with an unsupported codec fails the same way; cancel and choose a compatible source.'
    };
  }
  if (!map['launches:generation:PROCESS_RESULT_UNCERTAIN'])
    map['launches:generation:PROCESS_RESULT_UNCERTAIN'] = {
      files: [
        'apps/agent/src/team-bridge/process.ts',
        'apps/agent/src/team-bridge/catalog-video-foreground.ts',
        'supabase/functions/drive-ops/launch-catalog-video.ts',
        'supabase/migrations/20261207181000_catalog_video_cancellation_settlement.sql'
      ],
      check:
        'A variant child outcome is unknown. Reconcile the original operation and its upload receipt with the same key; never rerun media for an unknown child.'
    };
  map['launches:generation:WRONG_STATE'] = {
    files: [
      'supabase/migrations/20261206148000_launch_current_assignments.sql',
      'supabase/migrations/20261207094000_launch_optional_assignment.sql',
      'apps/web/src/team/launches/LaunchAssignmentControls.tsx',
      'apps/web/src/team/accounts/AccountLinkedLaunchRow.tsx',
      'supabase/functions/drive-ops/catalog-durable.ts',
      'supabase/migrations/20261201189000_launch_catalog_explicit_child_retry.sql',
      'apps/web/src/team/launches/useLaunchGeneration.ts',
      'apps/web/src/team/launches/restitch-runner.ts',
      'apps/web/src/team/restitch/screens.ts',
      'supabase/migrations/20261201153000_launch_restitch_waiting_reason.sql',
      'supabase/migrations/20261201145000_launch_restitch_settlement.sql',
      'supabase/migrations/20261201149000_launch_restitch_explicit_retry.sql'
    ],
    check:
      'Assignment is optional after the correction; on older servers verify whether the mandatory-assignment migration is still active. Inspect the bound child operation, last proven stage and catalog intent attempt. A failed child needs an explicit parent retry for that exact attempt; a running or successful child must not be replaced.'
  };
  for (const code of [
    'NEEDS_REAUTH',
    'DRIVE_UNAVAILABLE',
    'DRIVE_FILE_MISSING',
    'SHARE_NOT_ALLOWED'
  ]) {
    map[`launches:generation:${code}`] = {
      files: [
        'supabase/functions/drive-ops/launch-catalog.ts',
        'supabase/functions/drive-ops/catalog-durable.ts',
        'supabase/functions/_shared/drive.ts',
        'apps/web/src/team/launches/useLaunchGeneration.ts',
        'apps/web/src/team/launches/restitch-runner.ts',
        'supabase/migrations/20261201145000_launch_restitch_settlement.sql'
      ],
      check:
        'Inspect the generation and child receipt, including a child found by the frozen process key but not yet bound. Settle before choosing explicit retry; reconcile lost acceptance replies without creating a new Launch. Do not repeat provider creation while its outcome is unknown.'
    };
  }
  for (const code of ACCOUNT_ANALYTICS_CODES) {
    map[`accounts:workspace:${code}`] = {
      files: [
        'apps/web/src/team/accounts/analytics.ts',
        'apps/web/src/team/accounts/AccountSpace.tsx',
        'apps/web/src/team/accounts/useAccounts.ts',
        'apps/web/src/api/team-accounts-workspace.ts',
        'supabase/migrations/20261207114000_workspace_read_analytics_guard.sql',
        'apps/web/src/api/team.ts'
      ],
      check:
        'Inspect the correlated request and canonical response; acceptance proves persistence while a separate applied signal proves display. Reconcile an uncertain response before retrying.'
    };
  }
  for (const code of [
    'DELIVERY_UNAVAILABLE',
    'DRIVE_UNAVAILABLE',
    'NEEDS_REAUTH',
    'INVALID_RESPONSE'
  ]) {
    map[`catalog:update:${code}`] = {
      files: [
        'supabase/functions/catalog-updater/worker.ts',
        'supabase/functions/_shared/drive.ts',
        'apps/web/src/team/catalog-updater/CatalogStatusDetails.tsx'
      ],
      check:
        'Check the sheet readback and persisted attempt before retrying; an unknown provider reply is not delivery proof.'
    };
  }
  for (const step of [
    'members_list',
    'assignees_list',
    'member_permissions_save',
    'member_remove',
    'member_access_refresh'
  ]) {
    map[`members:${step}:*`] = {
      files: [
        'apps/web/src/team/members/MemberList.tsx',
        'apps/web/src/team/members/MemberPermissionsDialog.tsx',
        'apps/web/src/team/members/diagnostics.ts',
        ...(step === 'assignees_list'
          ? [
              'apps/web/src/team/tasks/TaskSpace.tsx',
              'apps/web/src/team/tasks/TaskEditor.tsx',
              'apps/web/src/team/launches/LaunchSpace.tsx',
              'supabase/migrations/20261202124000_launch_assignee_options.sql'
            ]
          : []),
        ...(step === 'member_access_refresh'
          ? [
              'apps/web/src/team/useTeamRealtime.ts',
              'apps/web/src/team/TeamContext.tsx',
              'apps/web/src/team/workspace/MembersSection.tsx',
              'supabase/migrations/20261206130000_membership_access_signals.sql',
              'supabase/migrations/20261206132000_membership_manager_invalidation.sql'
            ]
          : []),
        'apps/web/src/api/team.ts',
        'supabase/migrations/20260801100000_team_membership_actions.sql'
      ],
      check:
        'Inspect the correlated list or membership mutation attempt and current manage_members authority. A valid RPC response proves acceptance, while completion follows UI commit. For missing replies, read the existing protected membership audit and current permissions before retrying; no absence proves rollback.'
    };
  }
  for (const action of [
    'create',
    'list',
    'read',
    'update',
    'editor_refresh',
    'editor_preserve_draft'
  ]) {
    map[`tasks:task_${action}:*`] = {
      files: [
        'apps/web/src/team/tasks/diagnostics.ts',
        'apps/web/src/api/team.ts',
        'apps/web/src/team/tasks/TaskEditor.tsx',
        'apps/web/src/team/tasks/useTasks.ts',
        'apps/web/src/team/tasks/useTaskAutosave.ts',
        'supabase/migrations/20260814101000_creative_library_actions.sql',
        'supabase/migrations/20260916140000_task_conflict_answers_at_once.sql'
      ],
      check:
        'Inspect this exact correlated attempt. API completion validates the server response only; visible editor refresh is separate. Implicit preserve-draft keeps local typing and its original conflict version. An explicit Keep mine retries only unacknowledged fields against the reviewed version; a further peer change must conflict again. Take their version clears pending typing and renders the newest confirmed snapshot for that same task. For missing terminals read the protected current task before retrying; do not infer rollback or delivery from missing events.'
    };
  }
  for (const code of CATALOG_IMAGE_ERROR_CODES) {
    map[`catalog:update:${code}`] = {
      files: [
        'supabase/functions/catalog-updater/worker.ts',
        'supabase/functions/_shared/catalog-image-rows.ts',
        'supabase/migrations/20261206152000_catalog_r2_integration.sql'
      ],
      check:
        'Check the outgoing picture identities and the retained publication state before retrying the catalog write.'
    };
    map[`launches:generation:${code}`] = {
      files: [
        'supabase/functions/drive-ops/launch-catalog.ts',
        'supabase/functions/drive-ops/catalog-durable.ts',
        'supabase/functions/_shared/catalog-image-rows.ts',
        'supabase/functions/_shared/catalog-images.ts',
        'apps/web/src/team/errors.ts'
      ],
      check:
        'Inspect the persisted catalog image version, frozen pool snapshot, image and text pairing, and durable use receipts before retrying the same Launch attempt.'
    };
    map[`catalog:image:${code}`] = {
      files:
        code === 'IMAGE_CLIPBOARD_UNAVAILABLE'
          ? [
              'apps/web/src/team/product-catalog/catalogImagePrompt.ts',
              'apps/web/src/team/product-catalog/CatalogImageImport.tsx'
            ]
          : [
              'supabase/functions/catalog-images/worker.ts',
              'supabase/functions/_shared/catalog-image-optimization.ts',
              'supabase/migrations/20261206157000_catalog_image_storage.sql',
              'supabase/functions/catalog-images/drive-sources.ts',
              'supabase/functions/catalog-images/handler.ts',
              'apps/web/src/team/product-catalog/CatalogImageImport.tsx'
            ],
      check:
        'Inspect the immutable image stages and publication receipt before retrying; normal unclassified pictures are random-mode successes, while missing readback or a lost response remains unknown.'
    };
  }
  for (const code of [...CATALOG_VIDEO_R2_REASONS, 'UNKNOWN']) {
    map[`catalog:video_r2:${code}`] = {
      files:
        code === 'PERMISSION_DENIED' ||
        code === 'VIDEO_R2_DISABLED' ||
        code === 'VIDEO_R2_POLICY_PENDING' ||
        code === 'VIDEO_R2_NOT_CONFIGURED'
          ? [
              'supabase/functions/catalog-video-r2/handler.ts',
              'supabase/migrations/20261207193000_catalog_video_r2.sql',
              'apps/web/src/team/product-catalog/CatalogVideoR2Toggle.tsx'
            ]
          : code === 'VIDEO_R2_QUOTA_EXCEEDED' ||
              code === 'TOO_LARGE' ||
              code === 'VIDEO_R2_UNSUPPORTED_FORMAT'
            ? [
                'supabase/migrations/20261207193000_catalog_video_r2.sql',
                'supabase/functions/_shared/catalog-video-link.ts',
                'apps/web/src/team/tariffs/CatalogVideoR2UsageSection.tsx'
              ]
            : code === 'VIDEO_R2_CLEANUP_PARTIAL'
              ? [
                  'supabase/functions/catalog-video-r2/worker.ts',
                  'supabase/functions/_shared/r2-catalog-video.ts',
                  'supabase/migrations/20261207193000_catalog_video_r2.sql'
                ]
              : code === 'VIDEO_R2_CATALOG_WRITE_FAILED'
                ? [
                    'supabase/functions/catalog-updater/publication-io.ts',
                    'supabase/migrations/20261207193000_catalog_video_r2.sql',
                    'supabase/functions/catalog-updater/worker.ts'
                  ]
                : [
                    'supabase/functions/catalog-video-r2/worker.ts',
                    'supabase/functions/_shared/r2-catalog-video.ts',
                    'supabase/functions/_shared/catalog-video-link.ts',
                    'apps/web/src/team/product-catalog/CatalogVideoR2Toggle.tsx'
                  ],
      check:
        code === 'UNKNOWN'
          ? 'Missing or malformed stage evidence is unknown, never proof that the copy stopped there; read the copy state and tombstones directly.'
          : 'The catalog kept its Drive link. Check the copy state, verified parts and full_hash_verified before retrying; the next update retries on its own.'
    };
  }
  map['catalog:image:POOL_REMOVED'] = {
    files: [
      'supabase/migrations/20261206150000_catalog_r2_images.sql',
      'supabase/migrations/20261206151000_catalog_r2_diagnostics.sql',
      'apps/web/src/team/product-catalog/useCatalogImageImport.ts'
    ],
    check:
      'The image was removed from future pool selection. Its publication may remain ready for existing catalogs; inspect revocation and purge receipts separately.'
  };
  return map;
}

export const CODE_MAP: Readonly<Record<string, CodeLocation>> = Object.freeze({
  ...build(),
  ...Object.fromEntries(
    MACOS_STARTUP_CODES.map(code => [
      `native:macos:${code}`,
      {
        files: ['packaging/Launcher.swift', 'apps/agent/src/server/startup-evidence.ts'],
        check:
          'Inspect the last proven native stage and exact package target; absent evidence does not establish OS rejection or delivery.'
      }
    ])
  ),
  'tariff:commercial:review_required': {
    files: [
      'supabase/migrations/20261207110000_commercial_access_guards.sql',
      'apps/web/src/pages/admin/TariffEditDialog.tsx'
    ],
    check:
      'Compare the approval journal and migration capacity observation with the latest protected admin snapshot before changing Google access or seats.'
  },
  'team:access:*': {
    files: [
      'supabase/migrations/20261207110000_commercial_access_guards.sql',
      'apps/web/src/team/drive/commercialDiagnostics.ts',
      'supabase/functions/drive-connect/index.ts',
      'apps/web/src/team/drive/DriveConnectionPanel.tsx'
    ],
    check:
      'Inspect the last proven permission stage and current owner, tariff and identity reservation; absent callback delivery does not prove that Google consent failed.'
  },
  'team:access:GOOGLE_ACCOUNT_NOT_APPROVED': {
    files: [
      'supabase/migrations/20261207110000_commercial_access_guards.sql',
      'supabase/migrations/20261207112000_designated_space_drive_access.sql',
      'supabase/functions/drive-oauth-callback/handler.ts',
      'apps/web/src/team/storage/ConnectStorageFlow.tsx'
    ],
    check:
      'Verify the approved identity reservation and paid or explicitly designated no-tariff owner access before retrying; a rejected different account must not invalidate the working connection.'
  },
  'launcher:windows:unobserved': {
    files: [
      'packaging/windows/SotyAgentHost/AgentHealthClient.cs',
      'packaging/windows/SotyAgentHost/TrayApplication.cs',
      'packaging/windows/SotyAgentHost/AgentProcess.cs',
      'apps/agent/src/server/diagnostics-log.ts'
    ],
    check:
      'Distinguish native probe failure from a listening agent. The launcher currently hides probe exceptions and terminates its child after the error dialog closes; its decisions are not delivered in the agent journal.'
  },
  'process:output:PROCESS_RESULT_UNCERTAIN': {
    files: [
      'supabase/migrations/20261206134000_process_upload_ownership.sql',
      'supabase/migrations/20261206135000_process_output_adoption_fence.sql',
      'supabase/migrations/20261206136000_process_upload_service_readback.sql',
      'supabase/migrations/20261206137000_process_output_cleanup_dispatch.sql',
      'supabase/migrations/20261206138000_process_output_catalog_ingest_fence.sql',
      'supabase/functions/drive-ops/process-output-upload.ts',
      'supabase/functions/drive-ops/process-output-recovery.ts',
      'supabase/functions/_shared/drive.ts',
      'supabase/functions/drive-ops/index.ts',
      'apps/agent/src/team-bridge/transfer.ts',
      'packages/shared/src/team/transport.ts'
    ],
    check:
      'Inspect the captured new-output identity, grant deadline, cleanup lease, durable mutation and adoption reservation and conditional v2 provider readback. A pending 404 or lost upload reply does not prove absence. Preserve original, published, moved or modified files; never retry the processing operation blindly.'
  },
  'material:group:execution': {
    files: [
      'supabase/migrations/20261207161000_material_group_claim_epochs.sql',
      'supabase/migrations/20261207151000_material_group_execution.sql',
      'supabase/migrations/20261207152000_confirmed_material_group_reconciliation.sql',
      'supabase/migrations/20261207153000_material_group_late_failure.sql',
      'supabase/migrations/20261207154000_material_group_observed_completion.sql',
      'supabase/functions/_shared/library.ts',
      'supabase/functions/_shared/operations.ts',
      'supabase/functions/drive-ops/index.ts',
      'supabase/functions/library-ops/index.ts'
    ],
    check:
      'Inspect immutable managed nonce, executor closure, pending member and confirmed counts. A reserved member is not proof that a provider write started; a lost reply cannot authorize another PATCH. Legacy unclassified execution remains unknown. A positive no-pending closure permits only the original intent to resume after current rights and source checks. Provider-confirmed members do not prove registration or browser delivery.'
  },
  'workspace:receipt': {
    files: [
      'supabase/functions/drive-ops/material-historical-receipt.ts',
      'supabase/migrations/20261207167000_material_historical_receipts.sql',
      'apps/web/src/team/explorer/BulkTrashPanel.tsx',
      'supabase/migrations/20261205122000_task_attachment_cleanup.sql',
      'supabase/migrations/20261206140500_launch_offer_defaults_reference_fence.sql',
      'supabase/migrations/20261205121000_bulk_trash_receipts.sql',
      'supabase/migrations/20261207120000_drive_mutation_preflight_receipts.sql',
      'supabase/functions/drive-ops/mutation-preflight.ts',
      'supabase/functions/drive-ops/index.ts',
      'supabase/functions/drive-ops/task-cleanup.ts',
      'apps/web/src/team/tasks/TaskEditor.tsx',
      'apps/web/src/team/explorer/useBulkTrash.ts',
      'apps/web/src/team/catalog/TrashView.tsx',
      'supabase/functions/drive-ops/handler.ts',
      'supabase/migrations/20261207146000_restore_diagnostic_projection.sql',
      'supabase/migrations/20261207147000_bulk_trash_retry_provenance.sql'
    ],
    check:
      'For restore inspect its actor-bound request, hosted operation state and committed visible result; a missing reply is unknown and cannot prove nonexecution. For bulk trash inspect source_kind: trash_prepare (hosted retry preparation), trash_mark_request (request marker), trash_request (file-operation call including companion cleanup), trash_reconcile (receipt read), trash_refresh (initial read), trash_overlap (existing in-flight selection), trash_start (group acceptance). A call error cannot prove provider nonexecution. Reconcile the durable receipt, current rights and known references before retrying. Fresh trash metadata refusals record preflight_refused only while the operation remains pending without a lifecycle intent. A historical failed or canceled receipt alone cannot authorize a new provider key. An advanced or previously unknown write retains reconciliation. A refusal before Soty approval has no new receipt. Missing or disabled consumer fences retain files as cleanup_unverified; an existing reference yields cleanup_referenced. A late reference after a cleanup claim is rejected with WRONG_STATE. Missing provider or visible delivery remains unknown.'
  },
  ...Object.fromEntries(
    RECOVERY_REASONS.map(reason => [
      `tariff:recovery:${reason}`,
      {
        files: [
          'supabase/migrations/20261205110000_tariff_recovery.sql',
          'supabase/functions/team-recovery/handler.ts',
          'apps/agent/src/team-bridge/recovery-worker.ts',
          'apps/web/src/team/tariffs/UpdaterResumeNotice.tsx'
        ],
        check:
          'Inspect pause provenance, current authority and the last durable checkpoint before retrying.'
      }
    ])
  ),
  ...Object.fromEntries(
    AUTH_SESSION_MUTATION_CODES.map(code => [
      `auth:library:${code}`,
      {
        files: [
          'apps/web/src/auth/session-mutations.ts',
          'apps/web/src/auth/session-mutation-analytics.ts',
          'apps/web/src/auth/AuthContext.tsx',
          'packages/shared/src/types.ts'
        ],
        check:
          'Check cooperative session ownership and lock availability. A refused or timed-out lane must not clear a replacement session; an absent terminal after SDK signout remains unknown.'
      }
    ])
  ),
  ...Object.fromEntries(
    PROFILE_SYNC_CODES.map(code => [
      `auth:library:${code}`,
      {
        files: [
          'apps/web/src/auth/AuthContext.tsx',
          'apps/web/src/auth/profile-invalidation.ts',
          'apps/web/src/auth/profile-sync-analytics.ts',
          'packages/shared/src/types.ts'
        ],
        check:
          'Inspect the bounded profile refresh or update attempt and actor ownership. A failed refresh retains the last known profile and retries on activation; state publication does not prove sibling receipt or browser paint.'
      }
    ])
  ),
  ...Object.fromEntries(
    WORKSPACE_READ_CODES.flatMap(code =>
      [
        'team:read',
        'members:members_list',
        'members:assignees_list',
        'members:member_access_refresh',
        'tasks:task_list',
        'tasks:task_read'
      ].map(prefix => [
        `${prefix}:${code}`,
        {
          files: [
            'apps/web/src/team/readCoordinator.ts',
            'apps/web/src/team/useScopedRefresh.ts',
            'apps/web/src/team/catalog/useVisibleSerialRead.ts',
            'apps/web/src/team/members/diagnostics.ts',
            'apps/web/src/team/tasks/diagnostics.ts',
            'apps/web/src/api/team.ts',
            'packages/shared/src/types.ts'
          ],
          check:
            'A bounded browser read exceeded its deadline. Check session readiness and transport separately; the abort does not prove server cancellation or a failed write. The generic deadline alone does not identify the affected domain.'
        }
      ])
    )
  ),
  'team:library:RECOVERY_RETIREMENT_UNCONFIRMED': {
    files: [
      'apps/web/src/api/recovery-server-retirement.ts',
      'packages/shared/src/types.ts',
      'supabase/migrations/20261206139980_recovery_retirement_receipts.sql'
    ],
    check:
      'The browser could not confirm its retirement request. Read the closed error category and matching server attempt receipt; do not infer that server retirement failed or that protected-key cleanup completed.'
  },
  'team:recovery_retirement:server_confirmed': {
    files: [
      'supabase/migrations/20261206139980_recovery_retirement_receipts.sql',
      'apps/web/src/api/recovery-server-retirement.ts'
    ],
    check:
      'A committed actor-scoped receipt proves server retirement only. Correlate the matching browser attempt and native cleanup separately; a lost response or missing session remains unconfirmed at the client.'
  },
  'journal:team:recovery_retirement': {
    files: [
      'apps/agent/src/team-bridge/recovery-worker.ts',
      'apps/agent/src/team-bridge/recovery-journal.ts',
      'apps/agent/src/entitlement/entitlement.ts',
      'supabase/migrations/20261206139975_recovery_actor_retirement.sql'
    ],
    check:
      'Distinguish durable local retirement, committed server acknowledgement and protected-key cleanup. Reconcile the same delegation across boots; a browser signout or missing native record never proves server revocation. Preserve the last protected handle until acknowledgement and do not replay processing.'
  },
  'journal:team:recovery_empty_claim': {
    files: [
      'apps/agent/src/team-bridge/recovery-worker.ts',
      'supabase/functions/team-recovery/handler.ts'
    ],
    check:
      'The broker returned no job. Read current catalog claim eligibility; this sample does not prove why an earlier claim was empty or that video processing completed.'
  },
  'catalog:claim:*': {
    files: [
      'supabase/migrations/20261207124000_catalog_claim_eligibility.sql',
      'supabase/functions/team-recovery/handler.ts'
    ],
    check:
      'Inspect shared eligibility predicates, lease deadlines and retained operation receipts. Preserve execution and upload fences; a current snapshot cannot establish a historical rejection.'
  },
  'journal:team:recovery_state': {
    files: [
      'apps/agent/src/team-bridge/recovery-worker.ts',
      'supabase/functions/team-recovery/handler.ts'
    ],
    check:
      'Inspect the correlated request, installed restitch_contract_version and closed error_code alongside the persisted checkpoint. A proven pre-lease executor refusal closes only its no-job receipt; lost bookkeeping or unknown Drive outcomes remain fenced. Older producers may omit the cause, which remains unknown.'
  },
  'tariff:recovery:execution_reserved': {
    files: [
      'supabase/migrations/20261206139500_recovery_execution_fence.sql',
      'supabase/functions/team-recovery/handler.ts',
      'apps/agent/src/team-bridge/recovery-worker.ts'
    ],
    check:
      'A durable start reservation forbids replay; reconcile the terminal operation, output and native journal separately because the reservation alone proves no native execution or delivery.'
  },
  'journal:team:recovery_unavailable': {
    files: ['apps/agent/src/team-bridge/recovery-journal.ts'],
    check: 'Check the local journal schema and secure storage availability.'
  }
});

/**
 * The entry for a fingerprint, falling back by prefix: `a:b:c` → `a:b:*` → `a:*`. A link
 * fingerprint `link:<reason>` falls back to `link:*`. Null when nothing matches.
 */
export function lookupCodeLocations(fingerprint: string): CodeLocationMatch | null {
  const parts = fingerprint.split(':');
  const candidates = [fingerprint];
  for (let length = parts.length - 1; length >= 1; length -= 1) {
    candidates.push(`${parts.slice(0, length).join(':')}:*`);
  }
  for (const key of candidates) {
    const entry = CODE_MAP[key];
    if (entry) return { fingerprint, matched: key, files: [...entry.files], check: entry.check };
  }
  return null;
}
