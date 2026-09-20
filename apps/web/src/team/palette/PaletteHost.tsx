import { useState } from 'react';
import { navigateTo } from '../../lib/navigation';
import { useI18n } from '../../i18n';
import { buildTeamRoute } from '../routes';
import { WorkspacePalette } from './WorkspacePalette';
import { usePaletteResults } from './usePaletteResults';
import { formatShortcut } from './shortcuts';

/**
 * The palette, wired to the workspace's own addresses (024, US6).
 *
 * Every result does the same thing: it changes the address. That is what makes
 * the palette a way of *getting somewhere* rather than a second copy of every
 * screen — a file opens in its folder with the file selected, a task opens its
 * editor, an account opens the tab narrowed to it, exactly as a link would.
 *
 * Kept apart from `WorkspacePalette` so the surface can be rendered by a test,
 * or one day by the lobby, without dragging routing in with it.
 */
export function PaletteHost({
  teamId,
  onClose,
  onShortcuts
}: {
  teamId: string;
  onClose: () => void;
  /** The way from here to the list of everything the keyboard can do. */
  onShortcuts: () => void;
}) {
  const { t, language } = useI18n();
  const [query, setQuery] = useState('');

  const { results, loading } = usePaletteResults(query, {
    teamId,
    language,
    openMaterial: material =>
      navigateTo(
        buildTeamRoute({
          spaceId: teamId,
          section: 'explorer',
          query: { folderId: material.parentFolderId, itemId: material.id }
        })
      ),
    openFolder: driveFileId =>
      navigateTo(
        buildTeamRoute({ spaceId: teamId, section: 'explorer', query: { folderId: driveFileId } })
      ),
    openTask: taskId =>
      navigateTo(buildTeamRoute({ spaceId: teamId, section: 'tasks', query: { taskId } })),
    openAccount: accountId =>
      navigateTo(buildTeamRoute({ spaceId: teamId, section: 'accounts', query: { accountId } }))
  });

  return (
    <WorkspacePalette
      query={query}
      onQueryChange={setQuery}
      results={results}
      loading={loading}
      onClose={onClose}
      footer={
        <button type="button" className="workspace-palette-footer" onClick={onShortcuts}>
          {t('shortcutSheetTitle')}
          <kbd>{formatShortcut('mod+/')}</kbd>
        </button>
      }
    />
  );
}
