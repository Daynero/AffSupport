import type { LaunchGeneration, LaunchStage } from '@video-compressor/shared';
import type { TranslationKey } from '../../i18n';
import type { ProgressStage } from '../../components/ui/StageProgress';

export const launchStageLabels: Partial<Record<LaunchStage, TranslationKey>> = {
  validation: 'launchesStageValidation',
  draft_saved: 'launchesStageDraftSaved',
  accepted: 'launchesStageAccepted',
  preparing: 'launchesStagePreparing',
  restitch_preparing: 'launchesStageRestitchPreparing',
  restitch_processing: 'launchesStageRestitchProcessing',
  restitch_uploading: 'launchesStageRestitchUploading',
  catalog_planning: 'launchesStageCatalogPlanning',
  catalog_creating: 'launchesStageCatalogCreating',
  catalog_sharing: 'launchesStageCatalogSharing',
  catalog_registering: 'launchesStageCatalogRegistering',
  result_committing: 'launchesStageResultCommitting',
  result_committed: 'launchesStageResultCommitted',
  cancel: 'launchesStageCancel',
  cleanup: 'launchesStageCleanup'
};
const groups = [
  {
    id: 'prepare',
    label: 'launchesProgressPreparation',
    stages: ['validation', 'draft_saved', 'accepted', 'preparing']
  },
  {
    id: 'video',
    label: 'launchesProgressVideo',
    stages: ['restitch_preparing', 'restitch_processing', 'restitch_uploading']
  },
  {
    id: 'catalog',
    label: 'launchesProgressCatalog',
    stages: ['catalog_planning', 'catalog_creating', 'catalog_sharing', 'catalog_registering']
  },
  {
    id: 'result',
    label: 'launchesProgressResult',
    stages: ['result_committing', 'result_committed']
  }
] as const;

function succeededStages(generation: LaunchGeneration | null): Set<string> {
  // Attempts belong to individual steps. A retried catalog must not hide a
  // finalized video receipt from an earlier native attempt.
  const latest = new Map<string, NonNullable<LaunchGeneration['steps']>[number]>();
  for (const step of generation?.steps ?? []) {
    const known = latest.get(step.stage);
    if (
      !known ||
      step.attemptNo > known.attemptNo ||
      (step.attemptNo === known.attemptNo && step.state === 'succeeded')
    )
      latest.set(step.stage, step);
  }
  const succeeded = new Set<string>();
  for (const group of groups) {
    const receipts = [...latest.values()].filter(step =>
      (group.stages as readonly string[]).includes(step.stage)
    );
    const attempt = Math.max(0, ...receipts.map(step => step.attemptNo));
    for (const step of receipts)
      if (step.attemptNo === attempt && step.state === 'succeeded') succeeded.add(step.stage);
  }
  return succeeded;
}

/** A retained finalized video puts an accepted retry past initial preparation. */
export function launchProgressDisplayStage(input: {
  generation: LaunchGeneration | null;
  stage: LaunchStage;
  restitch: boolean;
  childSucceeded: boolean;
}): LaunchStage {
  const videoSet = input.generation?.videoGeneration;
  if (videoSet && ['accepted', 'preparing', 'unknown', 'cancel_requested'].includes(videoSet.state))
    return videoSet.activeChildOperationId ? 'restitch_processing' : 'restitch_preparing';
  const succeeded = succeededStages(input.generation);
  // A ready durable video set is a video receipt too: a lost lease that re-runs
  // preflight must not walk a reopened launch back to "Step 1" (1.4.3).
  return input.generation &&
    input.restitch &&
    (groups[0].stages as readonly string[]).includes(input.stage) &&
    (videoSet?.state === 'ready' ||
      input.childSucceeded ||
      succeeded.has('restitch_processing') ||
      succeeded.has('restitch_uploading'))
    ? 'catalog_planning'
    : input.stage;
}

/** Completion comes from receipts, never from a timer or a segment's position. */
export function launchProgressStages(
  input: {
    generation: LaunchGeneration | null;
    stage: LaunchStage;
    method: 'catalog' | 'other';
    restitch: boolean;
    childSucceeded: boolean;
    attention: boolean;
    fraction?: number;
  },
  t: (key: TranslationKey) => string
): ProgressStage[] {
  const { generation, stage } = input;
  const succeeded = succeededStages(generation);
  const complete = {
    prepare: generation !== null,
    video: generation?.videoGeneration
      ? generation.videoGeneration.state === 'ready'
      : input.childSucceeded ||
        // This durable checkpoint is written only after the finalized child receipt.
        succeeded.has('restitch_processing') ||
        succeeded.has('restitch_uploading') ||
        // The coordinator verifies the native receipt before these checkpoints.
        [
          'catalog_creating',
          'catalog_sharing',
          'catalog_registering',
          'result_committing',
          'result_committed'
        ].includes(stage),
    catalog:
      succeeded.has('catalog_registering') ||
      ['result_committing', 'result_committed'].includes(stage),
    result: generation?.state === 'succeeded'
  };
  // Catalog planning also performs preflight before the optional video child.
  // That receipt must not put the strip past video work that has not happened.
  const groupStage =
    stage === 'catalog_planning' && input.restitch && !complete.video
      ? 'preparing'
      : launchProgressDisplayStage(input);
  return groups
    .filter(
      group =>
        (input.method === 'catalog' || !['catalog', 'video'].includes(group.id)) &&
        (group.id !== 'video' || input.restitch)
    )
    .map(group => {
      const videoSet = group.id === 'video' ? generation?.videoGeneration : null;
      const current = videoSet
        ? ['accepted', 'preparing', 'cancel_requested', 'unknown'].includes(videoSet.state)
        : (group.stages as readonly string[]).includes(groupStage);
      const done = videoSet
        ? videoSet.state === 'ready'
        : generation?.state === 'succeeded' ||
          (group.id === 'video' &&
            (input.childSucceeded ||
              succeeded.has('restitch_processing') ||
              succeeded.has('restitch_uploading'))) ||
          (group.id === 'catalog' && succeeded.has('catalog_registering')) ||
          (!current && complete[group.id]);
      const confirmedFraction =
        group.stages.filter(step => succeeded.has(step)).length / group.stages.length;
      const measuredFraction = videoSet
        ? videoSet.registeredCount / videoSet.requestedCount
        : group.id === 'video'
          ? input.fraction
          : input.fraction === undefined || groupStage !== stage
            ? undefined
            : Math.min(1, confirmedFraction + input.fraction / group.stages.length);
      return {
        id: group.id,
        label: t(group.label),
        state: done
          ? 'complete'
          : current
            ? input.attention || videoSet?.state === 'unknown'
              ? 'attention'
              : 'active'
            : 'pending',
        ...(current && (measuredFraction !== undefined || confirmedFraction > 0)
          ? { fraction: measuredFraction ?? confirmedFraction }
          : {})
      };
    });
}

export interface LaunchProgressMemory {
  scope: string;
  version?: string;
  parentAttempt?: number;
  child?: string | null;
  videoSetId?: string;
  attempts: Map<string, number>;
  completed: Set<string>;
  fractions: Map<string, number>;
  active: string | null;
  stage?: LaunchStage;
  snapshot: ProgressStage[];
}
export function newLaunchProgressMemory(scope = ''): LaunchProgressMemory {
  return {
    scope,
    version: undefined,
    parentAttempt: undefined,
    child: undefined,
    stage: undefined,
    attempts: new Map(),
    completed: new Set(),
    fractions: new Map(),
    active: null,
    snapshot: []
  };
}
/** Retain proved work across partial reads; only a replacement attempt may undo it. */
export function rememberLaunchProgress(
  memory: LaunchProgressMemory,
  input: {
    scope: string;
    generation: LaunchGeneration | null;
    stage: LaunchStage;
    stages: ProgressStage[];
    attention: boolean;
  }
): ProgressStage[] {
  const { generation, stages } = input;
  if (!generation) return stages;
  if (memory.scope !== input.scope) Object.assign(memory, newLaunchProgressMemory(input.scope));
  const canonical = (value: unknown): value is string =>
    typeof value === 'string' && /^[1-9]\d*$/u.test(value);
  if (
    canonical(generation.stateVersion) &&
    canonical(memory.version) &&
    BigInt(generation.stateVersion) < BigInt(memory.version)
  )
    return memory.snapshot.map(entry => ({
      ...entry,
      state:
        entry.state === 'active' || entry.state === 'attention'
          ? input.attention
            ? 'attention'
            : 'active'
          : entry.state
    }));
  if (canonical(generation.stateVersion)) memory.version = generation.stateVersion;
  const videoSet = generation.videoGeneration;
  if (videoSet && memory.videoSetId !== videoSet.setId) {
    memory.videoSetId = videoSet.setId;
    memory.completed.delete('video');
    memory.fractions.delete('video');
  }
  memory.stage ??= input.stage;
  const resetFrom = (index: number) => {
    for (const group of groups.slice(index)) {
      memory.completed.delete(group.id);
      memory.fractions.delete(group.id);
    }
    memory.active = groups[index]?.id ?? null;
    memory.stage = input.stage;
  };
  if (generation.attemptNo !== undefined) {
    if (memory.parentAttempt !== undefined && generation.attemptNo > memory.parentAttempt)
      resetFrom(2);
    memory.parentAttempt = Math.max(memory.parentAttempt ?? 0, generation.attemptNo);
  }
  for (const [index, group] of groups.entries()) {
    const attempt = Math.max(
      0,
      ...(generation.steps ?? [])
        .filter(step => (group.stages as readonly string[]).includes(step.stage))
        .map(step => step.attemptNo)
    );
    const previous = memory.attempts.get(group.id) ?? 0;
    if (
      index > 0 &&
      attempt > previous &&
      attempt > 1 &&
      (generation.steps ?? []).some(
        step =>
          (group.stages as readonly string[]).includes(step.stage) &&
          step.attemptNo === attempt &&
          step.state !== 'succeeded'
      )
    )
      resetFrom(index);
    memory.attempts.set(group.id, Math.max(previous, attempt));
  }
  const child = generation.restitchOperationId;
  if (
    memory.child &&
    child !== undefined &&
    child !== memory.child &&
    (child !== null || input.stage === 'restitch_preparing')
  )
    resetFrom(1);
  if (child !== undefined) memory.child = child;
  for (const entry of stages) {
    if (entry.state === 'complete') memory.completed.add(entry.id);
    if (entry.fraction !== undefined)
      memory.fractions.set(entry.id, Math.max(memory.fractions.get(entry.id) ?? 0, entry.fraction));
    if (
      (entry.state === 'active' || entry.state === 'attention') &&
      !memory.completed.has(entry.id)
    ) {
      const index = groups.findIndex(group => group.id === entry.id);
      const known = groups.findIndex(group => group.id === memory.active);
      const phase = groups[index]?.stages as readonly string[] | undefined;
      const advancesWithinPhase =
        !memory.stage ||
        (phase?.indexOf(input.stage) ?? -1) >= (phase?.indexOf(memory.stage) ?? -1);
      if (index > known || (index === known && advancesWithinPhase)) {
        memory.active = entry.id;
        memory.stage = input.stage;
      }
    }
  }
  if (videoSet) {
    // N preparation can continue after catalog registration, or restart under a
    // new set. Its current lane cannot be held behind a later parent checkpoint.
    memory.active =
      stages.find(entry => entry.state === 'active' || entry.state === 'attention')?.id ?? null;
    memory.stage = input.stage;
  } else if (generation.state === 'succeeded') memory.stage = 'result_committed';
  memory.snapshot = stages.map(entry => ({
    ...entry,
    state: memory.completed.has(entry.id)
      ? 'complete'
      : memory.active === entry.id
        ? input.attention
          ? 'attention'
          : 'active'
        : 'pending',
    fraction: memory.completed.has(entry.id) ? 1 : memory.fractions.get(entry.id)
  }));
  return memory.snapshot.map(entry => ({ ...entry }));
}
