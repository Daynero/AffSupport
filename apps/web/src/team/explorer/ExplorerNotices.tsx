import type { ReactNode, Ref } from 'react';
import type { TeamMaterialRowKind } from '@video-compressor/shared';
import { RotateCcw } from 'lucide-react';
import { Alert, Button } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { KindFilterMenu } from './KindFilterMenu';
import { SortMenu } from './SortMenu';
import type { ExplorerSort } from './sort';

/**
 * What is true about the open folder right now, over the list (070, FR-009, T015): the notice
 * that an interrupted upload wants the same files again — the inventory's `Alert`, whose action
 * is the door it asks for, the same choice of files or a folder.
 *
 * «Лише перегляд» used to stand here too, while storage needs a person. The header's storage
 * chip says the same thing on every section, with the fix behind it, so two amber blocks on one
 * screen said one fact twice (070, US5): the chip is the one place now, and its words carry the
 * effect («Лише перегляд») as well as the cause.
 *
 * The block is measured (`--explorer-list-header-height`) so the list's sticky header sits
 * under it; with nothing to say it is empty and takes no room.
 */
export function ExplorerNotices({
  headerRef,
  retrying,
  canUpload,
  chooseOpen,
  onChooseAgain,
  onCloseRetry,
  children
}: {
  headerRef: Ref<HTMLDivElement>;
  /** An upload group is waiting for its files to be chosen again. */
  retrying: boolean;
  canUpload: boolean;
  /** The upload menu is open (from here or from the toolbar). */
  chooseOpen: boolean;
  onChooseAgain: (anchor: HTMLButtonElement) => void;
  onCloseRetry?: () => void;
  /** The strip on the list, under the notices and sticky with them. */
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div ref={headerRef} className="team-explorer-list-header">
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
      {children}
    </div>
  );
}

/**
 * The strip on the list (070): what arranges it, or — with something checked — what to do with
 * that, in the same place and at the same height, so nothing moves when a box is ticked (T024).
 * The search's results draw theirs into it (`hostRef`).
 */
export function ExplorerListStrip({
  hostRef,
  children
}: {
  hostRef: Ref<HTMLDivElement>;
  children?: ReactNode;
}) {
  return (
    <div ref={hostRef} className="team-explorer-list-controls">
      {children}
    </div>
  );
}

/**
 * What arranges the folder's list, on the list (070, FR-002), as Drive's filter chips do. The
 * grid has no headers, so its order is the menu's; the list's headers sort it, and the menu stays
 * there only for an order no column shows (tag, rank).
 */
export function ExplorerListArrangement({
  kinds,
  onKinds,
  sortMenu,
  sort,
  onSort
}: {
  kinds: TeamMaterialRowKind[];
  onKinds: (kinds: TeamMaterialRowKind[]) => void;
  sortMenu: boolean;
  sort: ExplorerSort;
  onSort: (sort: ExplorerSort) => void;
}) {
  return (
    <>
      <KindFilterMenu kinds={kinds} onChange={onKinds} />
      {/* Re-sorting is one move, not a reshuffle in a single frame (058). */}
      {sortMenu && <SortMenu sort={sort} onChange={onSort} />}
    </>
  );
}
