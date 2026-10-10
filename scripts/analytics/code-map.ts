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
  /** Repo-relative paths under `apps/`, `packages/` or `supabase/`; origin first, then surface. */
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
const AGENT_TRANSLATION = 'apps/agent/src/queue/translation-coordinator.ts';
const AGENT_TRANSLATOR = 'apps/agent/src/translation/translator.ts';
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
    agent: [AGENT_IMAGES, AGENT_QUEUE],
    check: 'Whether the screen image referenced by the job still exists in the image library.'
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
    check: 'Which step of the translation coordinator failed for this language pair.'
  },
  TRANSLATOR_UNAVAILABLE: {
    stage: 'translate',
    agent: [AGENT_TRANSLATOR, AGENT_TRANSLATION],
    check: 'Whether the translation engine is installed and detected on this machine.'
  }
};

const STITCH_WEB = [WEB_ERRORS, WEB_STITCHER];
const PLAN_CHECK = (what: string) =>
  `Which input the stitch planner refused for ${what} and whether the rule is right.`;

export const STITCH_CODES: Readonly<Record<string, CodeSpec>> = {
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
    agent: [AGENT_STITCH_QUEUE, AGENT_STITCH_PLAN],
    check: PLAN_CHECK('its video codec')
  },
  STITCH_PLAN_AUDIO_CODEC: {
    stage: 'input_probe',
    agent: [AGENT_STITCH_QUEUE, AGENT_STITCH_PLAN],
    check: PLAN_CHECK('its audio codec')
  },
  STITCH_PLAN_VARIABLE_FRAME_RATE: {
    stage: 'input_probe',
    agent: [AGENT_STITCH_QUEUE, AGENT_STITCH_PLAN],
    check: PLAN_CHECK('a variable frame rate')
  },
  STITCH_PLAN_CONTAINER: {
    stage: 'input_probe',
    agent: [AGENT_STITCH_QUEUE, AGENT_STITCH_PLAN],
    check: PLAN_CHECK('its container')
  },
  STITCH_PLAN_UNREADABLE: {
    stage: 'input_probe',
    agent: [AGENT_STITCH_QUEUE, AGENT_STITCH_PROBE],
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
      'The upload or new-version transfer between the local app and team storage.'
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
        'apps/agent/src/team-bridge/download.ts',
        'apps/web/src/team/catalog/useMaterialActions.ts',
        'apps/web/src/team/restitch/useRestitchDelivery.ts'
      ],
      'The download of a team material to this machine.'
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
  return map;
}

export const CODE_MAP: Readonly<Record<string, CodeLocation>> = Object.freeze(build());

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
