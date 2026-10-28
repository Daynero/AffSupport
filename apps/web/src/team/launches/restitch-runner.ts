import { launchReply, whileLaunchActive } from './reply';
import { launchApi, teamApi, TeamApiError } from '../../api/team';
import { ensureRestitchImages } from '../restitch/images';
import {
  agentCanRestitchFromSpace,
  agentCanRestitch,
  startTeamAgentProcess
} from '../../api/client';
import {
  prepareCatalogRestitch,
  type CatalogRestitchReceipt
} from '../product-catalog/catalog-orchestration';
import type { CreateProductCatalogClient } from '../product-catalog/CreateProductCatalogDialog';
import { prepareRestitchScreens, type RestitchScreensDeps } from '../restitch/screens';

export interface LaunchRestitchRunnerDeps {
  launches: Pick<
    typeof launchApi,
    | 'restitchPreparation'
    | 'prepareRestitch'
    | 'bindRestitch'
    | 'settleRestitch'
    | 'restitchReuse'
    | 'pauseRestitch'
  >;
  operation: typeof teamApi.getOperation;
  client: Parameters<typeof prepareCatalogRestitch>[0]['client'];
  screens: Pick<RestitchScreensDeps, 'grant' | 'capable'>;
}
const defaultDeps: LaunchRestitchRunnerDeps = {
  launches: launchApi,
  operation: (team, id) => teamApi.getOperation(team, id),
  client: {},
  screens: {
    grant: (team, id, consumer) => teamApi.requestDownload(team, id, consumer),
    capable: agentCanRestitchFromSpace
  }
};
/** Existing catalog orchestration with Launch-owned frozen screens and stable child identity. */
export async function runLaunchRestitch(
  input: {
    signal?: AbortSignal;
    teamId: string;
    generationId: string;
    video: { id: string; name: string };
  },
  deps: LaunchRestitchRunnerDeps = defaultDeps
): Promise<CatalogRestitchReceipt> {
  const { teamId, generationId, video, signal } = input;
  const checkActive = () => {
    if (signal?.aborted) throw new TeamApiError('PROCESS_CANCELED', false);
  };
  // Bound network coordination, never the duration of native media processing.
  const request = <T>(run: () => Promise<T>): Promise<T> => {
    checkActive();
    const work = launchReply(run());
    return signal ? whileLaunchActive(work, signal) : work;
  };
  const reused = await request(() => deps.launches.restitchReuse(teamId, generationId));
  if (reused)
    return {
      operationId: reused.operationId,
      choice: 'saved-launch-revision',
      catalogKey: `launch:${generationId}:catalog`
    };
  let preparation =
    (await request(() => deps.launches.restitchPreparation(teamId, generationId))) ??
    (await request(() => deps.launches.prepareRestitch(teamId, generationId)));
  const catalogKey = `launch:${generationId}:catalog`;
  const settleRecovered = async (operationId: string) => {
    if (await request(() => deps.launches.settleRestitch(teamId, generationId))) return;
    // The start reply may have been lost before the browser bound its receipt.
    // The preparation read can discover that child by its durable process key;
    // settlement needs the explicit, server-validated binding as well.
    try {
      await request(() => deps.launches.bindRestitch(teamId, generationId, operationId));
    } catch (error) {
      // Another observer may already have settled or canceled the parent.
      // Its state remains authoritative; never start a replacement here.
      if (!(error instanceof TeamApiError && error.code === 'WRONG_STATE')) throw error;
    }
    await request(() => deps.launches.settleRestitch(teamId, generationId));
  };
  const drawScreens: NonNullable<CreateProductCatalogClient['prepareRestitchScreens']> = (
    team,
    defaults
  ) =>
    prepareRestitchScreens(team, defaults, {
      ...deps.screens,
      capable: () => request(deps.screens.capable),
      grant: (...args) => request(() => deps.screens.grant(...args)),
      draw: async (_team, options) => {
        if (options?.exclude?.length)
          preparation = await request(() =>
            deps.launches.prepareRestitch(teamId, generationId, options.exclude)
          );
        return preparation.draw;
      }
    });
  return prepareCatalogRestitch({
    teamId,
    video,
    defaults: preparation.defaults,
    durationMode: preparation.defaults.finalDurationMode,
    customSeconds: preparation.defaults.customFinalDurationSeconds,
    catalogKey,
    processKey: preparation.processKey,
    client: {
      ...deps.client,
      ensureRestitchImages: (...args) =>
        request(() => (deps.client.ensureRestitchImages ?? ensureRestitchImages)(...args)),
      ensureRestitchedFolder: (...args) =>
        request(() =>
          (deps.client.ensureRestitchedFolder ?? teamApi.ensureRestitchedFolder)(...args)
        ),
      startProcess: (...args) =>
        request(() => (deps.client.startProcess ?? teamApi.startProcess)(...args)),
      cancelOperation: (...args) =>
        request(() => (deps.client.cancelOperation ?? teamApi.cancelOperation)(...args)),
      runAgentProcess: (...args) => {
        checkActive();
        return (deps.client.runAgentProcess ?? startTeamAgentProcess)(...args);
      },
      prepareRestitchScreens: drawScreens,
      canRestitch: async () => {
        const capability = await request(() =>
          deps.client.canRestitch
            ? deps.client.canRestitch()
            : agentCanRestitch(preparation.defaults.automaticEndFrame === true)
        );
        if (capability !== 'yes') {
          const code = capability === 'unreachable' ? 'AGENT_REQUIRED' : 'AGENT_UPDATE_REQUIRED';
          await request(() => deps.launches.pauseRestitch(teamId, generationId, code));
          throw new TeamApiError(code, true);
        }
        return capability;
      }
    },
    checkpoint: {
      async completed(choice) {
        if (!preparation.operationId) return null;
        const operation = await request(() => deps.operation(teamId, preparation.operationId!));
        if (
          operation.id !== preparation.operationId ||
          operation.teamId !== teamId ||
          operation.sourceMaterialId !== video.id
        )
          throw new TeamApiError('INVALID_RESPONSE', false);
        if (operation.state === 'succeeded' && operation.resultMaterialId) {
          await settleRecovered(operation.id);
          return { operationId: operation.id, choice, catalogKey };
        }
        if (operation.state === 'running' || operation.state === 'pending')
          throw new TeamApiError('LAUNCH_BUSY', true);
        if (operation.state === 'failed' || operation.state === 'canceled') {
          await settleRecovered(operation.id);
          if (operation.errorCode) throw new TeamApiError(operation.errorCode, false);
          throw new TeamApiError('PROCESS_FAILED', false);
        }
        return null;
      },
      // Metadata was already frozen by prepare_launch_restitch. Grants stay in RAM.
      async prepared() {},
      async beforeStart() {
        const current = await request(() =>
          deps.launches.restitchPreparation(teamId, generationId)
        );
        if (!current || current.processKey !== preparation.processKey)
          throw new TeamApiError('LAUNCH_VERSION_CONFLICT', false);
      },
      async started(receipt) {
        await request(() => deps.launches.bindRestitch(teamId, generationId, receipt.operationId));
      },
      async finished() {
        await request(() => deps.launches.settleRestitch(teamId, generationId));
      }
    }
  });
}
