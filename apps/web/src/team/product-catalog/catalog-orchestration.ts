import {
  RESTITCH_CONTRACT_VERSION,
  type FinalImageDurationMode,
  type RestitchScreen,
  type TeamRestitchDefaults
} from '@video-compressor/shared';
import { agentCanRestitch, startTeamAgentProcess } from '../../api/client';
import { teamApi } from '../../api/team';
import { ensureRestitchImages } from '../restitch/images';
import { prepareRestitchScreens } from '../restitch/screens';
import type { CreateProductCatalogClient } from './CreateProductCatalogDialog';

export interface CatalogRestitchReceipt {
  operationId: string;
  choice: string;
  catalogKey: string;
}
/** Boundary for Launch persistence adapters, never browser storage or grant tokens. */
export interface CatalogRestitchCheckpointAdapter {
  completed(choice: string): Promise<CatalogRestitchReceipt | null>;
  prepared(input: {
    choice: string;
    screens: { kind: 'legacy' } | { kind: 'ready'; screens: Omit<RestitchScreen, 'transfer'>[] };
    defaults: TeamRestitchDefaults;
  }): Promise<void>;
  beforeStart(input: { choice: string; idempotencyKey: string; catalogKey: string }): Promise<void>;
  started(input: CatalogRestitchReceipt): Promise<void>;
  finished(input: CatalogRestitchReceipt): Promise<void>;
}
export async function prepareCatalogRestitch(input: {
  teamId: string;
  video: { id: string; name: string };
  defaults: TeamRestitchDefaults;
  durationMode: FinalImageDurationMode;
  customSeconds: number | null;
  /** Explicit UI bounds, frozen to one exact duration before handing the job to the agent. */
  durationRangeSeconds?: readonly [number, number];
  random?: () => number;
  catalogKey: string;
  processKey?: string;
  previous?: CatalogRestitchReceipt | null;
  checkpoint?: CatalogRestitchCheckpointAdapter;
  /** Publish only the child ID, before the long local request starts. */
  onOperationStarted?: (operationId: string) => void;
  client: Pick<
    CreateProductCatalogClient,
    | 'canRestitch'
    | 'prepareRestitchScreens'
    | 'ensureRestitchImages'
    | 'ensureRestitchedFolder'
    | 'startProcess'
    | 'runAgentProcess'
    | 'cancelOperation'
  >;
}): Promise<CatalogRestitchReceipt> {
  const { teamId, video, durationMode, customSeconds, durationRangeSeconds, client } = input;
  const defaults = structuredClone(input.defaults);
  const choice = JSON.stringify({
    durationMode,
    customSeconds,
    defaults,
    ...(durationRangeSeconds ? { durationRangeSeconds } : {})
  });
  if (
    durationRangeSeconds &&
    (durationMode !== 'random-centered' ||
      !Array.isArray(durationRangeSeconds) ||
      durationRangeSeconds.length !== 2 ||
      !durationRangeSeconds.every(
        n => Number.isInteger(n) && n >= 60 && n <= 3600 && n % 60 === 0
      ) ||
      durationRangeSeconds[0] > durationRangeSeconds[1])
  )
    throw new Error('RESTITCH_DEFAULTS_INVALID');
  const previous = input.checkpoint ? await input.checkpoint.completed(choice) : input.previous;
  if (previous?.choice === choice) return previous;
  if (
    (durationMode === 'custom' || (durationMode === 'random-centered' && !durationRangeSeconds)) &&
    (!Number.isInteger(customSeconds) ||
      customSeconds === null ||
      customSeconds < 1 ||
      customSeconds > 3600)
  )
    throw new Error('RESTITCH_DEFAULTS_INVALID');
  if ((await (client.canRestitch ?? agentCanRestitch)()) !== 'yes')
    throw new Error('AGENT_UPDATE_REQUIRED');
  const drawn = await (client.prepareRestitchScreens ?? prepareRestitchScreens)(teamId, defaults);
  if (drawn.kind === 'too-old') throw new Error('AGENT_UPDATE_REQUIRED');
  await input.checkpoint?.prepared({
    choice,
    defaults,
    screens:
      drawn.kind === 'legacy'
        ? { kind: 'legacy' }
        : {
            kind: 'ready',
            screens: drawn.screens.map(screen => ({
              slot: screen.slot,
              materialId: screen.materialId,
              checksum: screen.checksum,
              mimeType: screen.mimeType,
              fileName: screen.fileName,
              sizeBytes: screen.sizeBytes
            }))
          }
  });
  if (drawn.kind === 'legacy')
    await (client.ensureRestitchImages ?? ensureRestitchImages)(teamId, defaults);
  const destination = await (client.ensureRestitchedFolder ?? teamApi.ensureRestitchedFolder)(
    teamId
  );
  const processKey = input.processKey ?? crypto.randomUUID();
  await input.checkpoint?.beforeStart({
    choice,
    idempotencyKey: processKey,
    catalogKey: input.catalogKey
  });
  const stem = video.name.replace(/\.[^.]+$/u, '') || video.name;
  // The existing agent contract accepts exact seconds. Sampling here preserves independent
  // bounds without silently reducing the user's range to the old ten-minute window.
  const effectiveMode = durationRangeSeconds ? 'custom' : durationMode;
  const effectiveSeconds = durationRangeSeconds
    ? durationRangeSeconds[0] +
      Math.floor(
        Math.min(0.999999999, Math.max(0, (input.random ?? Math.random)())) *
          (durationRangeSeconds[1] - durationRangeSeconds[0] + 1)
      )
    : customSeconds;
  const started = await (client.startProcess ?? teamApi.startProcess)({
    teamId,
    materialId: video.id,
    toolId: 'restitch',
    optionsSummary: { finalDurationMode: effectiveMode },
    destinationFolderId: destination.materialId,
    outputName: `${stem} restitched.mp4`,
    conflictMode: 'keep_both',
    idempotencyKey: processKey,
    agentContractVersion: 1,
    toolContractVersion: RESTITCH_CONTRACT_VERSION
  });
  const receipt = { operationId: started.operationId, choice, catalogKey: input.catalogKey };
  try {
    input.onOperationStarted?.(started.operationId);
    await input.checkpoint?.started(receipt);
    const finished = await (client.runAgentProcess ?? startTeamAgentProcess)({
      operationId: started.operationId,
      toolId: 'restitch',
      options: {
        defaults: {
          ...defaults,
          operation: 'restitch',
          finalDurationMode: effectiveMode,
          customFinalDurationSeconds:
            effectiveMode === 'custom' || effectiveMode === 'random-centered'
              ? (effectiveSeconds ?? defaults.customFinalDurationSeconds)
              : defaults.customFinalDurationSeconds
        },
        prepared: null,
        ...(drawn.kind === 'ready' ? { screens: drawn.screens, teamId } : {})
      },
      sourceGrant: started.sourceGrant,
      finalizeGrant: started.finalizeGrant
    });
    if (finished.state !== 'succeeded' || !finished.materialId) throw new Error('PROCESS_FAILED');
    await input.checkpoint?.finished(receipt);
    return receipt;
  } catch (error) {
    // A Launch checkpoint/transport refusal does not prove the local child failed.
    // Preserve it for authoritative observation; only a proved terminal reply may cancel it.
    if (input.checkpoint && !(error instanceof Error && error.message === 'PROCESS_FAILED'))
      throw error;
    await (client.cancelOperation ?? teamApi.cancelOperation)(teamId, started.operationId).catch(
      () => undefined
    );
    throw error;
  }
}
