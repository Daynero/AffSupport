import type { CatalogVideoForegroundExecutor } from '../../../packages/shared/dist/team/catalog-video-foreground.js';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import {
  launchCreativesOf,
  type LaunchConfig
} from '../../../packages/shared/dist/team/launches.js';
import {
  parseTeamRestitchDefaults,
  type TeamRestitchDefaults
} from '../../../packages/shared/dist/team/restitch.js';
import { createCatalogVideoAssignment } from '../../../packages/shared/dist/team/catalog-video-set.js';
import {
  catalogPlanSegments,
  catalogSegmentRowIds,
  createCatalogInitialVideoPlanV2,
  type CatalogCreativeKind
} from './catalog-video-generation.ts';
import { catalogVideoSettingsDigest } from './catalog-video-set-admission.ts';
/** Trusted generation admission only. Settings, executor authority, clock and
 * all random identifiers are captured before the atomic SQL acceptance. */
export async function prepareLaunchCatalogVideoAdmission(
  service: ServiceRpcClient,
  input: {
    teamId: string;
    actorId: string;
    launchId?: string;
    config: LaunchConfig;
    expectedExecutorId?: string;
    foregroundExecutor?: CatalogVideoForegroundExecutor;
    /** 057 T104: an R2 space's Launch, never re-stitched there: no Drive video context to read. */
    spaceStorage?: boolean;
  }
) {
  const { teamId, actorId, config } = input;
  if (config.method !== 'catalog' || config.catalog.catalogVideoProtocolVersion !== 1)
    throw new TeamFunctionError('INVALID_INPUT');
  // 062: the creatives in order; an older config reads as its one video.
  const creatives = launchCreativesOf(config);
  const kind: CatalogCreativeKind = config.creativeKind ?? 'video';
  const several = creatives.length > 1;
  if (creatives.length < 1 || (kind === 'image' && config.catalog.restitchEnabled))
    throw new TeamFunctionError('INVALID_INPUT');
  if (input.spaceStorage && config.catalog.restitchEnabled)
    throw new TeamFunctionError('STORAGE_BACKEND_MISMATCH', { retryable: false });
  // The context names the executor and the re-stitch defaults, which only re-stitching reads.
  const context = input.spaceStorage
    ? { data: { executorId: null, defaults: null }, error: null }
    : await service.rpc('service_initial_catalog_video_context', {
        p_team: teamId,
        p_actor: actorId,
        p_source: config.materialId,
        p_executor: input.expectedExecutorId ?? null,
        p_require_executor: false
      });
  if (context.error || !isRecord(context.data))
    throw new TeamFunctionError('TEAM_TRANSPORT_UNAVAILABLE');
  // The foreground controller drives one set per enrollment (R6): several videos go to
  // the background executor, and an offered foreground enrollment is retired below.
  const executorId =
    config.catalog.restitchEnabled && input.foregroundExecutor && !several
      ? input.foregroundExecutor.enrollmentId
      : config.catalog.restitchEnabled && typeof context.data.executorId === 'string'
        ? context.data.executorId
        : null;
  const read = await service.rpc('service_catalog_publication_clock', {});
  if (read.error || typeof read.data !== 'number' || !Number.isSafeInteger(read.data))
    throw new TeamFunctionError('INVALID_RESPONSE');
  const duration = {
    finalDurationMode: config.catalog.finalDurationMode,
    customFinalDurationSeconds: config.catalog.customFinalDurationSeconds ?? 2700,
    ...(config.catalog.finalDurationMode === 'random-centered' &&
    config.catalog.finalDurationRangeSeconds
      ? { finalDurationRangeSeconds: config.catalog.finalDurationRangeSeconds }
      : {})
  };
  let preferences = {
    catalogVideoProtocolVersion: 1 as const,
    restitchEnabled: config.catalog.restitchEnabled,
    videoVariationCount: config.catalog.videoVariationCount ?? 1,
    videoPublication: config.catalog.videoPublication ?? { mode: 'immediate' as const },
    ...(config.catalog.restitchEnabled
      ? { restitchDuration: duration, expectedExecutorId: executorId! }
      : {}),
    // The accepted request payload is these preferences over the base fields, frozen in SQL
    // and replayed verbatim by the catalog step: an option left out here never reaches it.
    ...(config.catalog.copyVideoToR2 === true ? { copyVideoToR2: true as const } : {}),
    // 062: the catalog step reads which creative owns which rows from the frozen payload.
    ...(config.creatives
      ? {
          creativeKind: kind,
          creatives: creatives.map(creative => ({
            materialId: creative.materialId,
            alias: creative.alias,
            copies: creative.copies
          }))
        }
      : {})
  };
  let plan = await createCatalogInitialVideoPlanV2(
    preferences,
    kind,
    creatives,
    config.catalog.productCount,
    read.data
  );
  let settings: TeamRestitchDefaults | null = null;
  if (config.catalog.restitchEnabled) {
    const saved = parseTeamRestitchDefaults(context.data.defaults ?? {});
    if (!saved.ok) throw new TeamFunctionError('RESTITCH_INVALID');
    settings = {
      ...(saved.value.configured
        ? saved.value
        : {
            ...saved.value,
            configured: true,
            operation: 'restitch',
            sourceMode: 'drive',
            startEnabled: false,
            endEnabled: true,
            automaticEndFrame: true
          }),
      ...duration
    };
  }
  const settingsDigest = settings ? await catalogVideoSettingsDigest(settings) : null;
  let acceptedExecutor = executorId;
  // A ready set of an earlier Launch is reused only for a single video (R5).
  if (settings && input.launchId && !several) {
    const reuse = await service.rpc('service_find_launch_catalog_video_reuse', {
      p_team: teamId,
      p_launch: input.launchId,
      p_actor: actorId,
      p_config: config,
      p_digest: settingsDigest
    });
    if (reuse.error) throw new TeamFunctionError('TEAM_TRANSPORT_UNAVAILABLE');
    if (isRecord(reuse.data)) {
      if (
        !isRecord(reuse.data.plan) ||
        !Array.isArray(reuse.data.plan.recipeRowIds) ||
        !Array.isArray(reuse.data.plan.childRequestIds) ||
        typeof reuse.data.executorId !== 'string' ||
        typeof reuse.data.plan.setId !== 'string' ||
        typeof reuse.data.plan.assignmentSeed !== 'string' ||
        !isRecord(reuse.data.settings) ||
        reuse.data.settingsDigest !== settingsDigest
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      const frozen = reuse.data.plan;
      acceptedExecutor = reuse.data.executorId;
      preferences = { ...preferences, expectedExecutorId: acceptedExecutor };
      plan = {
        ...plan,
        preferences,
        setId: frozen.setId as string,
        assignmentSeed: frozen.assignmentSeed as string,
        recipeRowIds: frozen.recipeRowIds as string[],
        childRequestIds: frozen.childRequestIds as string[],
        segments: plan.segments?.map(segment => ({
          ...segment,
          setId: frozen.setId as string,
          assignmentSeed: frozen.assignmentSeed as string,
          childRequestIds: frozen.childRequestIds as string[]
        }))
      };
      settings = reuse.data.settings as unknown as TeamRestitchDefaults;
    }
  }
  if (input.foregroundExecutor) {
    if (!several && plan.setId && acceptedExecutor === input.foregroundExecutor.enrollmentId) {
      const { expectedExecutorId: _backgroundExecutor, ...foregroundPreferences } = preferences;
      void _backgroundExecutor;
      preferences = {
        ...foregroundPreferences,
        foregroundExecutor: input.foregroundExecutor
      } as typeof preferences;
      plan = { ...plan, preferences };
    } else {
      const retired = await service.rpc('service_retire_unused_catalog_video_foreground', {
        p_enrollment: input.foregroundExecutor.enrollmentId,
        p_team: teamId,
        p_actor: actorId
      });
      if (retired.error) throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
    }
  }
  if (config.catalog.restitchEnabled && !acceptedExecutor)
    throw new TeamFunctionError('AGENT_REQUIRED', { retryable: false });
  const segments = catalogPlanSegments(plan) ?? [];
  // One assignment per restitched video, over its own rows and with its own seed. A single
  // video keeps the plan's rows and seed, exactly as before 062.
  const segmentAssignments = segments.map(segment =>
    segment.setId
      ? createCatalogVideoAssignment({
          recipeRevision: 1,
          recipeRowIds: several ? catalogSegmentRowIds(plan, segment) : plan.recipeRowIds,
          variantCount: several ? segment.variantCount : preferences.videoVariationCount,
          seed: several ? segment.assignmentSeed : plan.assignmentSeed
        }).assignments
      : []
  );
  return {
    plan,
    executorId: acceptedExecutor,
    settings,
    settingsDigest,
    // Rows are disjoint between segments, so the concatenation names each row once.
    assignments: segmentAssignments.flat(),
    ...(several ? { segmentAssignments } : {})
  };
}
