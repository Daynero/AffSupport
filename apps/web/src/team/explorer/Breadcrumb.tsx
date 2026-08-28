import { useI18n } from '../../i18n';
import { useExplorer } from './ExplorerProvider';

/** The full path from the root, every segment a link (FR-008). */
export function Breadcrumb() {
  const { t } = useI18n();
  const { currentFolderId, pathTo, openFolder } = useExplorer();
  const path = pathTo(currentFolderId);
  return (
    <nav className="team-explorer-breadcrumb" aria-label={t('teamExplorerBreadcrumbLabel')}>
      <ol>
        <li>
          {path.length === 0 ? (
            <span aria-current="location">{t('teamExplorerRootLabel')}</span>
          ) : (
            <button type="button" onClick={() => openFolder(null)}>
              {t('teamExplorerRootLabel')}
            </button>
          )}
        </li>
        {path.map((node, index) => (
          <li key={node.id}>
            <span className="team-explorer-breadcrumb-separator" aria-hidden="true">
              /
            </span>
            {index === path.length - 1 ? (
              <span aria-current="location">{node.name}</span>
            ) : (
              <button type="button" onClick={() => openFolder(node.driveFileId)}>
                {node.name}
              </button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
