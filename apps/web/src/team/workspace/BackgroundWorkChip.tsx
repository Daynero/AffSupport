import { useI18n } from '../../i18n';
import { useOptionalWorkspaceOperations } from '../explorer/WorkspaceOperationsProvider';
import { useOptionalLibraryProcessing } from '../library/LibraryProcessingProvider';
import { WorkspaceChip } from './WorkspaceChip';

/** Opens the current processing batch after its dialog has been closed. */
export function BackgroundWorkChip({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n();
  const batch = useOptionalLibraryProcessing();
  const operations = useOptionalWorkspaceOperations();
  const batchRunning = batch?.phase === 'running';
  if (!batchRunning && !operations?.sessionOnly) return null;

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
      {operations?.sessionOnly && (
        <WorkspaceChip tone="warn" label={t('teamWorkspaceSessionOnly')}>
          {t('teamWorkspaceSessionOnly')}
        </WorkspaceChip>
      )}
    </>
  );
}
