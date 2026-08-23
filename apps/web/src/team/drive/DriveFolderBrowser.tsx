import type { DriveFolderSummary } from '../../api/team';
import { useI18n } from '../../i18n';
import { Button } from '../../components/ui';

/**
 * Browses the connected account's folder tree.
 *
 * Opening a folder and choosing a folder are deliberately two different
 * actions. They used to be the same one, which made every folder below the
 * first level unreachable: a team whose materials live in `My Drive / Work /
 * Creatives` could only ever connect `Work`. So a row now navigates, a separate
 * control commits that row as the space root, and the trail can commit the
 * folder currently open — which is otherwise impossible to select once you have
 * stepped inside it.
 *
 * `onOpen` is optional so that a caller which only ever lists one level (and
 * has no navigation state to keep) renders the original flat picker unchanged.
 */
export function DriveFolderBrowser({
  folders,
  nextPageToken,
  trail,
  onOpen,
  onChoose,
  onLoadMore
}: {
  folders: DriveFolderSummary[];
  nextPageToken: string | null;
  trail?: DriveFolderSummary[];
  onOpen?: (folder: DriveFolderSummary | null) => void;
  onChoose: (folder: DriveFolderSummary) => void;
  onLoadMore: () => void;
}) {
  const { t } = useI18n();
  const path = trail ?? [];
  const current = path.length > 0 ? path[path.length - 1] : null;

  return (
    <div className="team-folder-browser">
      {onOpen && (
        <nav className="team-folder-trail" aria-label={t('teamDriveChooseFolder')}>
          <Button
            type="button"
            variant="ghost"
            className="team-folder-crumb"
            disabled={path.length === 0}
            onClick={() => onOpen(null)}
          >
            {t('teamFolderRoot')}
          </Button>
          {path.map((crumb, index) => (
            <span key={`${crumb.driveKind}:${crumb.id}`} className="team-folder-crumb-group">
              <span aria-hidden="true" className="team-folder-crumb-separator">
                /
              </span>
              <Button
                type="button"
                variant="ghost"
                className="team-folder-crumb"
                disabled={index === path.length - 1}
                onClick={() => onOpen(crumb)}
              >
                {crumb.name}
              </Button>
            </span>
          ))}
        </nav>
      )}
      {onOpen && current && (
        <Button
          type="button"
          variant="primary"
          className="team-folder-select-current"
          onClick={() => onChoose(current)}
        >
          {t('teamFolderSelectCurrent')}
        </Button>
      )}
      <ul>
        {folders.map(folder => (
          <li key={`${folder.driveKind}:${folder.id}`}>
            {onOpen ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  className="team-folder-open"
                  aria-label={`${folder.name} — ${t('teamFolderOpen')}`}
                  onClick={() => onOpen(folder)}
                >
                  <span aria-hidden="true">📁</span> {folder.name}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="team-folder-select"
                  aria-label={`${folder.name} — ${t('teamFolderSelect')}`}
                  onClick={() => onChoose(folder)}
                >
                  {t('teamFolderSelect')}
                </Button>
              </>
            ) : (
              <Button type="button" variant="ghost" onClick={() => onChoose(folder)}>
                <span aria-hidden="true">📁</span> {folder.name}
              </Button>
            )}
            <small>{folder.driveKind === 'shared_drive' ? 'Shared Drive' : 'My Drive'}</small>
          </li>
        ))}
      </ul>
      {onOpen && folders.length === 0 && (
        <p className="team-folder-empty">{t('teamFolderEmpty')}</p>
      )}
      {nextPageToken && (
        <Button type="button" variant="secondary" onClick={onLoadMore}>
          {t('teamFolderLoadMore')}
        </Button>
      )}
    </div>
  );
}
