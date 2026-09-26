import { useId, useState } from 'react';
import { Modal } from '../../components/Modal';
import { useI18n, type TranslationKey } from '../../i18n';
import { useOptionalWorkspaceOperations } from '../explorer/WorkspaceOperationsProvider';
import { useOptionalLibraryProcessing } from '../library/LibraryProcessingProvider';
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
 * cancelled (finding B1, FR-032). Visible only while something is running:
 * a permanent chip would stop being a signal.
 */
export function BackgroundWorkChip({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n();
  const [summaryOpen, setSummaryOpen] = useState(false);
  const summaryId = useId();
  const batch = useOptionalLibraryProcessing();
  const operations = useOptionalWorkspaceOperations();
  const active = operations?.groups.filter(group => group.stage !== 'done') ?? [];
  const batchRunning = batch?.phase === 'running';
  if (!batchRunning && active.length === 0) return null;

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
      {active.length > 0 && (
        <>
          <WorkspaceChip
            tone="busy"
            busy
            label={t('teamWorkspaceGroupsOpen', { count: active.length })}
            onPress={() => setSummaryOpen(true)}
            opensDialog
          >
            {t('teamWorkspaceGroupsChip', { count: active.length })}
          </WorkspaceChip>
          {summaryOpen && (
            <Modal labelledBy={summaryId} size="sm" onClose={() => setSummaryOpen(false)}>
              <h2 id={summaryId}>{t('teamWorkspaceGroupsTitle')}</h2>
              <ul>
                {active.map(group => (
                  <li key={group.id}>
                    {t(STAGE_KEY[group.stage] ?? 'teamOperationRunning')} —{' '}
                    {t('teamWorkspaceItemsProgress', {
                      done: group.items.filter(item => item.state === 'succeeded').length,
                      total: group.items.length
                    })}
                  </li>
                ))}
              </ul>
            </Modal>
          )}
        </>
      )}
    </>
  );
}
