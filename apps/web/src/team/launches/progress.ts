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
  const attempt = Math.max(0, ...(generation?.steps?.map(step => step.attemptNo) ?? []));
  const succeeded = new Set(
    generation?.steps
      ?.filter(step => step.attemptNo === attempt && step.state === 'succeeded')
      .map(step => step.stage)
  );
  const complete = {
    prepare: generation !== null,
    video:
      input.childSucceeded ||
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
    stage === 'catalog_planning' && input.restitch && !complete.video ? 'preparing' : stage;
  return groups
    .filter(
      group =>
        (input.method === 'catalog' || !['catalog', 'video'].includes(group.id)) &&
        (group.id !== 'video' || input.restitch)
    )
    .map(group => {
      const current = (group.stages as readonly string[]).includes(groupStage);
      const done =
        generation?.state === 'succeeded' ||
        (group.id === 'video' && input.childSucceeded) ||
        (!current && complete[group.id]);
      const confirmedFraction =
        group.stages.filter(step => succeeded.has(step)).length / group.stages.length;
      const measuredFraction =
        group.id === 'video'
          ? input.fraction
          : input.fraction === undefined
            ? undefined
            : Math.min(1, confirmedFraction + input.fraction / group.stages.length);
      return {
        id: group.id,
        label: t(group.label),
        state: done ? 'complete' : current ? (input.attention ? 'attention' : 'active') : 'pending',
        ...(current && (measuredFraction !== undefined || confirmedFraction > 0)
          ? { fraction: measuredFraction ?? confirmedFraction }
          : {})
      };
    });
}
