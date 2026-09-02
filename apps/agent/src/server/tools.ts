import type { FastifyInstance } from 'fastify';
import {
  COMPRESSION_LIFECYCLE,
  LANDING_JOB_LIFECYCLE,
  LANDING_PREVIEW_ITEM_LIFECYCLE,
  MEDIA_ACTION_LIFECYCLE,
  STITCH_LIFECYCLE,
  TRANSCRIPTION_LIFECYCLE,
  type AnyLifecycle,
  type LandingEvent,
  type ImageEmbeddingSettings,
  type LandingPreviewEvent,
  type StitcherEvent,
  type TranscriptionEvent
} from '@video-compressor/shared';
import { registerCompressorRoutes, type CompressorContext } from '../compressor/routes.js';
import type { LandingOptimizer } from '../landing/optimizer.js';
import type { LandingPreviewCatalog } from '../landing-preview/catalog.js';
import { registerLandingPreviewRoutes } from '../landing-preview/routes.js';
import { registerMediaActionRoutes } from '../media-actions/routes.js';
import type { MediaActionQueue } from '../media-actions/queue.js';
import type { TranscriptionQueue } from '../queue/transcription-queue.js';
import type { TeamOperationEvent } from '../team-bridge/events.js';
import type { TeamDownloadBridge } from '../team-bridge/download.js';
import type { TeamLandingRenderBridge } from '../team-bridge/landing-gallery.js';
import type { CreativeLibraryProcessBridge } from '../team-bridge/library.js';
import type { TeamPreviewBridge } from '../team-bridge/preview.js';
import type { TeamProcessBridge } from '../team-bridge/process.js';
import type { RestitchPrepareBridge } from '../team-bridge/restitch-prepare.js';
import type { TeamPosterBridge } from '../team-bridge/poster.js';
import type { StitchQueue } from '../stitcher/queue.js';
import { registerStitcherRoutes } from '../stitcher/routes.js';
import { registerTeamBridgeRoutes } from '../team-bridge/routes.js';
import { registerLandingRoutes } from '../landing/routes.js';
import { registerTranscriptionRoutes } from '../transcription/routes.js';
import type { PowerGovernor } from '../power/governor.js';
import type { EventChannel } from './sse.js';

/** Server-wide facilities every tool module may rely on. */
export interface ToolContext {
  allowedOrigins: ReadonlySet<string>;
  /** False while a pending update drains work; tools must refuse new tasks. */
  acceptingNewTasks: () => boolean;
  /**
   * The shared CPU budget. Tools read it for thread counts and timeout scaling,
   * and spawn heavy children through `spawnManaged` so the ceiling covers every
   * tool at once rather than each separately.
   */
  power: PowerGovernor;
}

/**
 * One product tool (compressor, landing optimizer, transcriber, …). Adding a
 * tool means implementing this interface and appending it to the array in
 * `createToolModules` — routes, the /health busy flag, and the shutdown chain
 * all follow from the module list.
 */
export interface ToolModule {
  id: string;
  /**
   * The lifecycle this tool's runs follow, or `null` for a module that owns no runs.
   *
   * Declaring it here is what makes the table and the enforcement the same object. Before
   * this, each queue decided legality from its own `if` chains and the interface decided it
   * again from status literals, and the audit found several places where the two had
   * drifted. `null` is only for the team bridge, which relays operations rather than owning
   * a queue of its own.
   */
  lifecycle: AnyLifecycle | null;
  register(app: FastifyInstance, ctx: ToolContext): void;
  busy(): boolean;
  /**
   * Stop one run. Resolves false when there is no such run, or it has already finished.
   *
   * Required rather than optional, so "this tool cannot be stopped" is a compile error
   * rather than something a user discovers. Every tool that can start work can stop it —
   * that is FR-005, and making it structural is the only way it stays true for the tool
   * somebody adds next year.
   */
  cancel(id: string): Promise<boolean>;
  /** Stop everything this tool is running, and report how many runs that was (FR-007). */
  cancelAll(): Promise<number>;
  shutdown(): Promise<void>;
}

export interface ToolModulesDeps {
  compressor: CompressorContext;
  mediaActions: MediaActionQueue;
  landing: { optimizer: LandingOptimizer; events: EventChannel<LandingEvent> };
  landingPreview: {
    catalog: LandingPreviewCatalog;
    events: EventChannel<LandingPreviewEvent>;
  };
  transcription: { queue: TranscriptionQueue; events: EventChannel<TranscriptionEvent> };
  stitcher: {
    queue: StitchQueue;
    events: EventChannel<StitcherEvent>;
    tools: () => { ffmpeg: boolean; ffprobe: boolean };
    /** The compressor's live screen settings — the stitcher keeps no second copy. */
    embedding: () => ImageEmbeddingSettings;
  };
  teamWorkspace: {
    preview: TeamPreviewBridge;
    process: TeamProcessBridge;
    poster: TeamPosterBridge;
    download: TeamDownloadBridge;
    landings: TeamLandingRenderBridge;
    library: CreativeLibraryProcessBridge;
    restitch: RestitchPrepareBridge;
    events: EventChannel<TeamOperationEvent>;
  };
}

/**
 * Assembles the tool modules in their canonical order. Shutdown iterates this
 * array as-is, preserving the historical chain: estimator → compressor queue →
 * media actions → landing optimizer → transcription queue.
 */
export function createToolModules(deps: ToolModulesDeps): ToolModule[] {
  const { compressor, mediaActions, landing, landingPreview, transcription, teamWorkspace } = deps;
  const { stitcher } = deps;
  return [
    {
      id: 'compressor',
      lifecycle: COMPRESSION_LIFECYCLE,
      register: app => registerCompressorRoutes(app, compressor),
      busy: () => compressor.queue.workActive(),
      cancel: id => compressor.queue.cancel(id),
      cancelAll: () => compressor.queue.cancelAll(),
      shutdown: async () => {
        await compressor.estimator.shutdown();
        await compressor.queue.shutdown();
      }
    },
    {
      id: 'media-actions',
      lifecycle: MEDIA_ACTION_LIFECYCLE,
      register: (app, ctx) =>
        registerMediaActionRoutes(app, {
          mediaActions,
          acceptingNewTasks: ctx.acceptingNewTasks,
          compressorState: () => compressor.queue.state()
        }),
      busy: () => mediaActions.workActive(),
      cancel: id => mediaActions.cancel(id),
      cancelAll: () => mediaActions.cancelAll(),
      shutdown: () => mediaActions.shutdown()
    },
    {
      id: 'landing',
      lifecycle: LANDING_JOB_LIFECYCLE,
      register: (app, ctx) =>
        registerLandingRoutes(app, {
          optimizer: landing.optimizer,
          events: landing.events,
          acceptingNewTasks: ctx.acceptingNewTasks
        }),
      busy: () => landing.optimizer.state().running,
      cancel: id => landing.optimizer.cancel(id),
      cancelAll: () => landing.optimizer.cancelAll(),
      shutdown: () => landing.optimizer.shutdown()
    },
    {
      id: 'landing-preview',
      lifecycle: LANDING_PREVIEW_ITEM_LIFECYCLE,
      register: (app, ctx) =>
        registerLandingPreviewRoutes(app, {
          catalog: landingPreview.catalog,
          events: landingPreview.events,
          acceptingNewTasks: ctx.acceptingNewTasks
        }),
      busy: () => landingPreview.catalog.busy(),
      // A preview run is a single render of the whole catalog, so stopping one item and
      // stopping the run are the same act. Reporting the count keeps `cancelAll` honest
      // about whether anything was actually stopped.
      cancel: async () => landingPreview.catalog.cancel(),
      cancelAll: async () => (landingPreview.catalog.cancel() ? 1 : 0),
      shutdown: () => landingPreview.catalog.shutdown()
    },
    {
      id: 'transcription',
      lifecycle: TRANSCRIPTION_LIFECYCLE,
      register: (app, ctx) =>
        registerTranscriptionRoutes(app, {
          queue: transcription.queue,
          events: transcription.events,
          acceptingNewTasks: ctx.acceptingNewTasks
        }),
      busy: () => transcription.queue.workActive(),
      cancel: async id => transcription.queue.cancel(id),
      cancelAll: async () => transcription.queue.cancelAll(),
      shutdown: () => transcription.queue.shutdown()
    },
    {
      id: 'stitcher',
      lifecycle: STITCH_LIFECYCLE,
      register: (app, ctx) =>
        registerStitcherRoutes(app, {
          queue: stitcher.queue,
          events: stitcher.events,
          tools: stitcher.tools,
          embedding: stitcher.embedding,
          acceptingNewTasks: ctx.acceptingNewTasks
        }),
      busy: () => stitcher.queue.workActive(),
      cancel: id => stitcher.queue.cancel(id),
      cancelAll: () => stitcher.queue.cancelAll(),
      shutdown: () => stitcher.queue.shutdown()
    },
    {
      id: 'team-workspace',
      // No queue of its own: the bridge relays operations to the tools above, and each of
      // those enforces its own lifecycle. A lifecycle here would be a second, redundant
      // declaration of the same runs.
      lifecycle: null,
      register: (app, ctx) =>
        registerTeamBridgeRoutes(app, {
          preview: teamWorkspace.preview,
          process: teamWorkspace.process,
          poster: teamWorkspace.poster,
          download: teamWorkspace.download,
          landings: teamWorkspace.landings,
          library: teamWorkspace.library,
          restitch: teamWorkspace.restitch,
          events: teamWorkspace.events,
          acceptingNewTasks: ctx.acceptingNewTasks
        }),
      busy: () =>
        teamWorkspace.preview.busy() ||
        teamWorkspace.process.busy() ||
        teamWorkspace.poster.busy() ||
        teamWorkspace.download.busy() ||
        teamWorkspace.landings.busy() ||
        teamWorkspace.library.busy() ||
        teamWorkspace.restitch.busy(),
      // Cancellation belongs to whichever tool is doing the work; the bridge holds nothing
      // to stop. Reported as "no such run" rather than pretended away.
      cancel: async () => false,
      cancelAll: async () => 0,
      shutdown: async () => {
        await teamWorkspace.restitch.shutdown();
        await teamWorkspace.poster.shutdown();
        await teamWorkspace.library.shutdown();
        await teamWorkspace.landings.shutdown();
        await teamWorkspace.download.shutdown();
        await teamWorkspace.process.shutdown();
        await teamWorkspace.preview.shutdown();
      }
    }
  ];
}
