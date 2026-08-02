import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { trackTeamWorkspaceSession } from '../../analytics/service';
import { useTeam } from '../TeamContext';
import { MaterialBrowser, type MaterialBrowserClient } from '../catalog/MaterialBrowser';
import { TeamCatalog, type TeamCatalogClient } from '../catalog/TeamCatalog';
import { SpaceSettings, type SpaceSettingsClient } from './SpaceSettings';

export type WorkspaceShellClient = MaterialBrowserClient & TeamCatalogClient & SpaceSettingsClient;

type ShellView = 'content' | 'settings' | 'search';

/**
 * Content-first workspace for a single entered space. The connected folder's
 * contents are the central, default element. Management (members, invitations,
 * drive, audit) lives behind one "Space settings" entry, and search + filters
 * are revealed on demand — the search affordance only appears once the space
 * has content, so an empty space shows neither filters nor side panels.
 */
export function WorkspaceShell({
  teamId,
  client,
  directAddMode = 'disabled',
  onChangeSpace
}: {
  teamId: string;
  client: WorkspaceShellClient;
  directAddMode?: 'disabled' | 'testing';
  onChangeSpace: () => void;
}) {
  const { t } = useI18n();
  const { activeTeam } = useTeam();
  const [view, setView] = useState<ShellView>('content');
  const [hasContent, setHasContent] = useState(false);
  const sessionTeam = useRef<string | null>(null);

  useEffect(() => {
    setView('content');
    setHasContent(false);
  }, [teamId]);

  useEffect(() => {
    if (sessionTeam.current === teamId) return;
    sessionTeam.current = teamId;
    trackTeamWorkspaceSession();
  }, [teamId]);

  const onLoaded = useCallback((count: number) => {
    if (count > 0) setHasContent(true);
  }, []);

  return (
    <section className="team-space-shell" aria-labelledby="team-space-shell-title">
      <header className="team-space-shell-header">
        <div>
          <p className="team-workspace-eyebrow">{t('teamWorkspace')}</p>
          <h1 id="team-space-shell-title">{activeTeam?.name ?? ''}</h1>
        </div>
        <div className="team-space-shell-actions">
          {hasContent && (
            <Button
              type="button"
              variant="ghost"
              aria-pressed={view === 'search'}
              onClick={() => setView(current => (current === 'search' ? 'content' : 'search'))}
            >
              {view === 'search' ? t('teamSpaceSearchClose') : t('teamSpaceSearchToggle')}
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            aria-pressed={view === 'settings'}
            onClick={() => setView(current => (current === 'settings' ? 'content' : 'settings'))}
          >
            {t('teamSpaceSettings')}
          </Button>
          <Button type="button" variant="secondary" onClick={onChangeSpace}>
            {t('teamSpaceChange')}
          </Button>
        </div>
      </header>

      <div className="team-space-shell-body">
        {view === 'settings' ? (
          <SpaceSettings
            key={`settings:${teamId}`}
            teamId={teamId}
            client={client}
            directAddMode={directAddMode}
            onBack={() => setView('content')}
          />
        ) : view === 'search' ? (
          <TeamCatalog key={`search:${teamId}`} teamId={teamId} client={client} />
        ) : (
          <MaterialBrowser
            key={`materials:${teamId}`}
            teamId={teamId}
            client={client}
            onLoaded={onLoaded}
            syncLabel={activeTeam?.connectionState === 'connected' ? t('teamSyncFresh') : null}
          />
        )}
      </div>
    </section>
  );
}
