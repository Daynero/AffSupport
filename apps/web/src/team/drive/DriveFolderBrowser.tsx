import type { DriveFolderSummary } from '../../api/team';
import { useI18n } from '../../i18n';
import { Button } from '../../components/ui';

export function DriveFolderBrowser({
  folders,
  nextPageToken,
  onChoose,
  onLoadMore
}: {
  folders: DriveFolderSummary[];
  nextPageToken: string | null;
  onChoose: (folder: DriveFolderSummary) => void;
  onLoadMore: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="team-folder-browser">
      <ul>
        {folders.map(folder => (
          <li key={`${folder.driveKind}:${folder.id}`}>
            <Button type="button" variant="ghost" onClick={() => onChoose(folder)}>
              <span aria-hidden="true">📁</span> {folder.name}
            </Button>
            <small>{folder.driveKind === 'shared_drive' ? 'Shared Drive' : 'My Drive'}</small>
          </li>
        ))}
      </ul>
      {nextPageToken && (
        <Button type="button" variant="secondary" onClick={onLoadMore}>
          {t('teamFolderLoadMore')}
        </Button>
      )}
    </div>
  );
}
