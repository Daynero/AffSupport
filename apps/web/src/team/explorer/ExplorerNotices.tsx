import type { Ref } from 'react';
import { Eye, RotateCcw } from 'lucide-react';
import { Alert, Button } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';

/**
 * What is true about the open folder right now, over the list (070, FR-009, T015): «Лише
 * перегляд» while storage needs a person, and the notice that an interrupted upload wants
 * the same files again. «Лише перегляд» was a paragraph in an empty header row, and the retry
 * notice a bare `role="status"` with a Close beside it; both are the inventory's `Alert` now,
 * and the retry's action is the door it asks for — the same choice of files or a folder.
 *
 * The block is measured (`--explorer-list-header-height`) so the list's sticky header sits
 * under it; with nothing to say it is empty and takes no room.
 */
export function ExplorerNotices({
  headerRef,
  readOnly,
  retrying,
  canUpload,
  chooseOpen,
  onChooseAgain,
  onCloseRetry
}: {
  headerRef: Ref<HTMLDivElement>;
  readOnly: boolean;
  /** An upload group is waiting for its files to be chosen again. */
  retrying: boolean;
  canUpload: boolean;
  /** The upload menu is open (from here or from the toolbar). */
  chooseOpen: boolean;
  onChooseAgain: (anchor: HTMLButtonElement) => void;
  onCloseRetry?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div ref={headerRef} className="team-explorer-list-header">
      {readOnly && (
        <Alert
          color="warning"
          icon={<Eye size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
          title={t('teamExplorerReadOnlyTitle')}
        >
          {t('teamStorageReadOnly')}
        </Alert>
      )}
      {retrying && (
        <Alert
          color="info"
          icon={<RotateCcw size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
          title={t('teamExplorerRetryTitle')}
          action={
            <div className="team-explorer-alert-actions">
              {canUpload && (
                <Button
                  size="sm"
                  variant="outline"
                  aria-haspopup="menu"
                  aria-expanded={chooseOpen}
                  onClick={event => onChooseAgain(event.currentTarget)}
                >
                  {t('teamExplorerRetryChoose')}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={onCloseRetry}>
                {t('teamOperationClose')}
              </Button>
            </div>
          }
        >
          {t('teamWorkspaceReselect')}
        </Alert>
      )}
    </div>
  );
}
