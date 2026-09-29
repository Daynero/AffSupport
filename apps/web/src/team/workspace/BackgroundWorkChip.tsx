import { useId, useState } from 'react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';
import {
  useOptionalWorkspaceOperations,
  type WorkspaceOperationGroup
} from '../explorer/WorkspaceOperationsProvider';
import { useOptionalLibraryProcessing } from '../library/LibraryProcessingProvider';
import { teamErrorMessage } from '../errors';
import { WorkspaceChip } from './WorkspaceChip';

const STAGE_KEY: Record<string, TranslationKey> = {
  preparing: 'teamWorkspaceStagePreparing',
  creating_folders: 'teamWorkspaceStageFolders',
  transferring: 'teamWorkspaceStageTransfer',
  moving: 'teamWorkspaceStageMoving',
  updating_catalog: 'teamWorkspaceStageCatalog'
};

/**
 * Says that the space is busy, from anywhere in the space.
 *
 * Batch progress used to exist only inside the dialog that started it, so
 * closing the window left the run invisible as well as — until this feature —
 * cancelled (finding B1, FR-032). Local results stay discoverable while their
 * journal metadata is retained, including after the initiating view closes.
 */
export function BackgroundWorkChip({
  onOpen,
  onRetryGroup
}: {
  onOpen: () => void;
  onRetryGroup?: (group: WorkspaceOperationGroup) => void;
}) {
  const { language, t } = useI18n();
  const [summaryOpen, setSummaryOpen] = useState(false);
  const summaryId = useId();
  const batch = useOptionalLibraryProcessing();
  const operations = useOptionalWorkspaceOperations();
  const active = operations?.groups.filter(group => group.stage !== 'done') ?? [];
  const reviewable =
    operations?.groups
      .filter(
        group =>
          group.stage === 'done' &&
          (group.state === 'failed' ||
            group.state === 'partial' ||
            group.state === 'interrupted_input_required')
      )
      .slice(0, 20) ?? [];
  const visibleGroups = [...active, ...reviewable];
  const batchRunning = batch?.phase === 'running';
  if (!batchRunning && visibleGroups.length === 0 && !operations?.sessionOnly) return null;

  const settled = batch ? batch.done + batch.skipped + batch.failed : 0;
  const total = batch ? Math.max(batch.total, settled + (batch.activeKind ? 1 : 0), 1) : 1;
  return (
    <>
      {batchRunning && batch && (
        <WorkspaceChip
          tone="busy"
          busy
          className="team-background-chip"
          label={t('teamBatchChipOpen', { done: batch.done, total })}
          onPress={onOpen}
        >
          {t('teamBatchChip', { done: batch.done, total })}
        </WorkspaceChip>
      )}
      {visibleGroups.length > 0 && (
        <>
          <WorkspaceChip
            tone={active.length > 0 ? 'busy' : reviewable.length > 0 ? 'warn' : 'quiet'}
            busy={active.length > 0}
            label={t(active.length > 0 ? 'teamWorkspaceActiveChip' : 'teamWorkspaceAttentionChip', {
              count: active.length > 0 ? active.length : reviewable.length
            })}
            onPress={() => setSummaryOpen(true)}
            opensDialog
          >
            {t(active.length > 0 ? 'teamWorkspaceActiveChip' : 'teamWorkspaceAttentionChip', {
              count: active.length > 0 ? active.length : reviewable.length
            })}
          </WorkspaceChip>
          {summaryOpen && (
            <Modal labelledBy={summaryId} size="sm" onClose={() => setSummaryOpen(false)}>
              <h2 id={summaryId}>{t('teamWorkspaceGroupsTitle')}</h2>
              <ul>
                {visibleGroups.map(group => {
                  const names = group.items.map(item => item.relativePath);
                  const preview = names.slice(0, 2).join(', ');
                  return (
                    <li key={group.id}>
                      <strong>{preview || t('teamWorkspaceGroupsTitle')}</strong>
                      {names.length > 2 &&
                        ` ${t('teamWorkspaceMoreItems', { count: names.length - 2 })}`}
                      {group.createdAt && (
                        <small>
                          {' '}
                          ·{' '}
                          {new Intl.DateTimeFormat(language, {
                            dateStyle: 'short',
                            timeStyle: 'short'
                          }).format(group.createdAt)}
                        </small>
                      )}
                      <br />
                      {t(
                        group.state === 'interrupted_input_required'
                          ? 'teamWorkspaceReselect'
                          : group.state === 'partial'
                            ? 'teamWorkspacePartial'
                            : group.state === 'succeeded'
                              ? 'teamOperationSucceeded'
                              : group.state === 'failed'
                                ? 'teamOperationFailed'
                                : group.state === 'canceled'
                                  ? 'teamWorkspaceCanceled'
                                  : (STAGE_KEY[group.stage] ?? 'teamOperationRunning')
                      )}{' '}
                      —{' '}
                      {t('teamWorkspaceItemsProgress', {
                        done: group.items.filter(item => item.state === 'succeeded').length,
                        total: group.items.length
                      })}
                      {group.items.some(
                        item => item.state === 'failed' || item.state === 'skipped'
                      ) && (
                        <ul>
                          {group.items
                            .filter(item => item.state === 'failed' || item.state === 'skipped')
                            .map(item => (
                              <li key={item.clientItemKey}>
                                {item.relativePath} —{' '}
                                {item.errorCode === 'PARENT_FAILED'
                                  ? t('teamWorkspaceParentFailed')
                                  : item.errorCode
                                    ? teamErrorMessage(item.errorCode, t)
                                    : t('teamOperationFailed')}
                              </li>
                            ))}
                        </ul>
                      )}
                      {group.stage !== 'done' && group.state !== 'interrupted_input_required' && (
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => operations?.cancelGroup(group.id)}
                        >
                          {t('teamOperationCancel')}
                        </Button>
                      )}
                      {onRetryGroup &&
                        group.state !== 'succeeded' &&
                        (group.stage === 'done' ||
                          group.state === 'interrupted_input_required') && (
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => {
                              setSummaryOpen(false);
                              onRetryGroup(group);
                            }}
                          >
                            {t('teamOperationRetry')}
                          </Button>
                        )}
                    </li>
                  );
                })}
              </ul>
            </Modal>
          )}
        </>
      )}
      {operations?.sessionOnly && (
        <WorkspaceChip tone="warn" label={t('teamWorkspaceSessionOnly')}>
          {t('teamWorkspaceSessionOnly')}
        </WorkspaceChip>
      )}
    </>
  );
}
