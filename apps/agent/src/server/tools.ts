import type { FastifyInstance } from 'fastify';
import type {
  LandingEvent,
  LandingPreviewEvent,
  TranscriptionEvent
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
import { registerTeamBridgeRoutes } from '../team-bridge/routes.js';
import { registerLandingRoutes } from '../landing/routes.js';
import { registerTranscriptionRoutes } from '../transcription/routes.js';
import type { EventChannel } from './sse.js';

/** Server-wide facilities every tool module may rely on. */
export interface ToolContext {
  allowedOrigins: ReadonlySet<string>;
  /** False while a pending update drains work; tools must refuse new tasks. */
  acceptingNewTasks: () => boolean;
}

/**
 * One product tool (compressor, landing optimizer, transcriber, …). Adding a
 * tool means implementing this interface and appending it to the array in
 * `createToolModules` — routes, the /health busy flag, and the shutdown chain
 * all follow from the module list.
 */
export interface ToolModule {
  id: string;
  register(app: FastifyInstance, ctx: ToolContext): void;
  busy(): boolean;
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
  teamWorkspace: {
    preview: TeamPreviewBridge;
    process: TeamProcessBridge;
    download: TeamDownloadBridge;
    landings: TeamLandingRenderBridge;
    library: CreativeLibraryProcessBridge;
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
  return [
    {
      id: 'compressor',
      register: app => registerCompressorRoutes(app, compressor),
      busy: () => compressor.queue.workActive(),
      shutdown: async () => {
        await compressor.estimator.shutdown();
        await compressor.queue.shutdown();
      }
    },
    {
      id: 'media-actions',
      register: (app, ctx) =>
        registerMediaActionRoutes(app, { mediaActions, acceptingNewTasks: ctx.acceptingNewTasks }),
      busy: () => mediaActions.workActive(),
      shutdown: () => mediaActions.shutdown()
    },
    {
      id: 'landing',
      register: (app, ctx) =>
        registerLandingRoutes(app, {
          optimizer: landing.optimizer,
          events: landing.events,
          acceptingNewTasks: ctx.acceptingNewTasks
        }),
      busy: () => landing.optimizer.state().running,
      shutdown: () => landing.optimizer.shutdown()
    },
    {
      id: 'landing-preview',
      register: (app, ctx) =>
        registerLandingPreviewRoutes(app, {
          catalog: landingPreview.catalog,
          events: landingPreview.events,
          acceptingNewTasks: ctx.acceptingNewTasks
        }),
      busy: () => landingPreview.catalog.busy(),
      shutdown: () => landingPreview.catalog.shutdown()
    },
    {
      id: 'transcription',
      register: (app, ctx) =>
        registerTranscriptionRoutes(app, {
          queue: transcription.queue,
          events: transcription.events,
          acceptingNewTasks: ctx.acceptingNewTasks
        }),
      busy: () => transcription.queue.workActive(),
      shutdown: () => transcription.queue.shutdown()
    },
    {
      id: 'team-workspace',
      register: (app, ctx) =>
        registerTeamBridgeRoutes(app, {
          preview: teamWorkspace.preview,
          process: teamWorkspace.process,
          download: teamWorkspace.download,
          landings: teamWorkspace.landings,
          library: teamWorkspace.library,
          events: teamWorkspace.events,
          acceptingNewTasks: ctx.acceptingNewTasks
        }),
      busy: () =>
        teamWorkspace.preview.busy() ||
        teamWorkspace.process.busy() ||
        teamWorkspace.download.busy() ||
        teamWorkspace.landings.busy() ||
        teamWorkspace.library.busy(),
      shutdown: async () => {
        await teamWorkspace.library.shutdown();
        await teamWorkspace.landings.shutdown();
        await teamWorkspace.download.shutdown();
        await teamWorkspace.process.shutdown();
        await teamWorkspace.preview.shutdown();
      }
    }
  ];
}
