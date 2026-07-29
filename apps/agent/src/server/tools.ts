import type { FastifyInstance } from 'fastify';
import type { LandingEvent, TranscriptionEvent } from '@video-compressor/shared';
import { registerCompressorRoutes, type CompressorContext } from '../compressor/routes.js';
import type { LandingOptimizer } from '../landing/optimizer.js';
import { registerMediaActionRoutes } from '../media-actions/routes.js';
import type { MediaActionQueue } from '../media-actions/queue.js';
import type { TranscriptionQueue } from '../queue/transcription-queue.js';
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
  transcription: { queue: TranscriptionQueue; events: EventChannel<TranscriptionEvent> };
}

/**
 * Assembles the tool modules in their canonical order. Shutdown iterates this
 * array as-is, preserving the historical chain: estimator → compressor queue →
 * media actions → landing optimizer → transcription queue.
 */
export function createToolModules(deps: ToolModulesDeps): ToolModule[] {
  const { compressor, mediaActions, landing, transcription } = deps;
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
      id: 'transcription',
      register: (app, ctx) =>
        registerTranscriptionRoutes(app, {
          queue: transcription.queue,
          events: transcription.events,
          acceptingNewTasks: ctx.acceptingNewTasks
        }),
      busy: () => transcription.queue.workActive(),
      shutdown: () => transcription.queue.shutdown()
    }
  ];
}
