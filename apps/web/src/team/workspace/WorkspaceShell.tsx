import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { trackTeamWorkspaceSession } from '../../analytics/service';
import { useTeam } from '../TeamContext';
import { type TeamMaterialSummary } from '../../api/team';
import { MaterialBrowser, type MaterialBrowserClient } from '../catalog/MaterialBrowser';
import { TeamCatalog, type TeamCatalogClient } from '../catalog/TeamCatalog';
import { TeamLandings, type TeamLandingsClient } from '../landings/TeamLandings';
import { CreativeLibrary } from '../library';
import { MaterialPreview } from '../preview/MaterialPreview';
import { TaskSpace } from '../tasks';
import { SpaceSettings, type SpaceSettingsClient } from './SpaceSettings';

export type WorkspaceShellClient = MaterialBrowserClient &
  TeamCatalogClient &
  TeamLandingsClient &
  SpaceSettingsClient;

type ShellView = 'content' | 'settings' | 'search' | 'landings' | 'library' | 'tasks';

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
  const [taskAsset, setTaskAsset] = useState<{ ids: string[]; name: string } | null>(null);
  const [previewing, setPreviewing] = useState<TeamMaterialSummary | null>(null);
  const sessionTeam = useRef<string | null>(null);

  useEffect(() => {
    setView('content');
    setHasContent(false);
    setTaskAsset(null);
    setPreviewing(null);
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
          <Button
            type="button"
            variant="secondary"
            aria-pressed={view === 'tasks'}
            onClick={() => setView(current => (current === 'tasks' ? 'content' : 'tasks'))}
          >
            {t('teamTasksTitle')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            aria-pressed={view === 'library'}
            onClick={() => setView(current => (current === 'library' ? 'content' : 'library'))}
          >
            {t('creativeLibraryNav')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            aria-pressed={view === 'landings'}
            onClick={() => setView(current => (current === 'landings' ? 'content' : 'landings'))}
          >
            {t('teamLandingsTitle')}
          </Button>
          {hasContent && (
            <Button
              type="button"
              variant="secondary"
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
          <TeamCatalog
            key={`search:${teamId}`}
            teamId={teamId}
            client={client}
            onCreateTask={asset => {
              setTaskAsset({ ids: [asset.id], name: asset.name });
              setView('tasks');
            }}
          />
        ) : view === 'landings' ? (
          <TeamLandings
            key={`landings:${teamId}`}
            teamId={teamId}
            client={client}
            onCreateTask={asset => {
              setTaskAsset({ ids: [asset.id], name: asset.name });
              setView('tasks');
            }}
          />
        ) : view === 'library' ? (
          <CreativeLibrary
            key={`library:${teamId}`}
            teamId={teamId}
            onCreateTask={asset => {
              setTaskAsset({ ids: [asset.id], name: asset.name });
              setView('tasks');
            }}
            onCreateTaskFromSelection={assets => {
              if (assets.length === 0) return;
              setTaskAsset({
                ids: assets.map(asset => asset.id),
                name: t('creativeLibrarySelectionSummary', { count: assets.length })
              });
              setView('tasks');
            }}
          />
        ) : view === 'tasks' ? (
          <TaskSpace
            key={`tasks:${teamId}`}
            teamId={teamId}
            createFromAsset={taskAsset}
            onConsumedCreateFromAsset={() => setTaskAsset(null)}
          />
        ) : (
          <MaterialBrowser
            key={`materials:${teamId}`}
            teamId={teamId}
            client={client}
            onLoaded={onLoaded}
            onCreateTask={asset => {
              setTaskAsset({ ids: [asset.id], name: asset.name });
              setView('tasks');
            }}
            onPreview={setPreviewing}
            syncLabel={activeTeam?.connectionState === 'connected' ? t('teamSyncFresh') : null}
          />
        )}
      </div>
      {previewing && (
        <MaterialPreview
          teamId={teamId}
          material={previewing}
          onClose={() => setPreviewing(null)}
        />
      )}
    </section>
  );
}
