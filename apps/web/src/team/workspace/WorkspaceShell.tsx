import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui';
import { useI18n, type TranslationKey } from '../../i18n';
import { internalLink, navigateTo } from '../../lib/navigation';
import { trackTeamWorkspaceSession } from '../../analytics/service';
import { useTeam } from '../TeamContext';
import { type TeamMaterialSummary } from '../../api/team';
import { MaterialBrowser, type MaterialBrowserClient } from '../catalog/MaterialBrowser';
import { TeamCatalog, type TeamCatalogClient } from '../catalog/TeamCatalog';
import { TeamLandings, type TeamLandingsClient } from '../landings/TeamLandings';
import { CreativeLibrary } from '../library';
import { MaterialPreview } from '../preview/MaterialPreview';
import { TaskSpace } from '../tasks';
import { SyncProgress } from '../SyncProgress';
import { useCatalogFreshness } from '../useCatalogFreshness';
import { SpaceSettings, type SpaceSettingsClient } from './SpaceSettings';
import { SpaceSwitcher } from './SpaceSwitcher';
import { RealtimeChip } from './RealtimeChip';
import { SpaceStatePanel } from './SpaceStatePanel';
import { TrashView } from '../catalog/TrashView';
import { buildTeamRoute, type TeamRouteQuery, type TeamSection } from '../routes';
import { useToasts } from '../../components/toast';
import { teamErrorMessageFor } from '../errors';
import type { CatalogSearchFilters } from '@video-compressor/shared';

export type WorkspaceShellClient = MaterialBrowserClient &
  TeamCatalogClient &
  TeamLandingsClient &
  SpaceSettingsClient;

/**
 * The content tabs, in the order they appear. Settings and Trash are also
 * sections but are not tabs: they are utilities reached from the header and the
 * Files toolbar, and mixing them into the same row is what made the old header
 * a wall of six identical buttons.
 */
const CONTENT_TABS: { section: TeamSection; label: TranslationKey }[] = [
  { section: 'files', label: 'teamSectionFiles' },
  { section: 'tasks', label: 'teamSectionTasks' },
  { section: 'creatives', label: 'teamSectionCreatives' },
  { section: 'landings', label: 'teamSectionLandings' }
];

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
  section = 'files',
  query
}: {
  teamId: string;
  client: WorkspaceShellClient;
  directAddMode?: 'disabled' | 'testing';
  /** Which section the address names; the shell renders exactly this one. */
  section?: TeamSection;
  /** View state carried by the address (search, filters, open task, folder). */
  query?: TeamRouteQuery;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { activeTeam, teams, permissions, revision } = useTeam();
  const connectedToDrive = activeTeam?.connectionState === 'connected';
  // Space-wide sync status: visible above every tab so a member who just entered
  // (or who just connected the folder) can see the scan is alive without having
  // to open the tab whose filtered view still reads empty.
  const { freshness, hasContent } = useCatalogFreshness({
    teamId,
    client,
    enabled: connectedToDrive
  });
  // Arriving on an address that carries a search opens the search view; the
  // toggle then owns it for the rest of the visit.
  const [searchOpen, setSearchOpen] = useState(() => Boolean(query?.q));
  const [browserRevision, setBrowserRevision] = useState(0);
  const [taskAsset, setTaskAsset] = useState<{ ids: string[]; name: string } | null>(null);
  const [previewing, setPreviewing] = useState<TeamMaterialSummary | null>(null);
  const sessionTeam = useRef<string | null>(null);

  useEffect(() => {
    setSearchOpen(false);
    setTaskAsset(null);
    setPreviewing(null);
  }, [teamId]);

  useEffect(() => {
    if (sessionTeam.current === teamId) return;
    sessionTeam.current = teamId;
    trackTeamWorkspaceSession();
  }, [teamId]);

  const sectionRoute = useCallback(
    (target: TeamSection) => buildTeamRoute({ spaceId: teamId, section: target }),
    [teamId]
  );

  /**
   * Write a piece of view state into the address.
   *
   * `replace` throughout: moving through folders, refining a search or opening
   * a task are adjustments to where you already are, and pushing each one would
   * make Back a slow rewind of your own typing instead of a way out of the
   * section (SC-003).
   */
  const updateQuery = useCallback(
    (target: TeamSection, patch: Partial<TeamRouteQuery>) => {
      navigateTo(
        buildTeamRoute({ spaceId: teamId, section: target, query: { ...query, ...patch } }),
        true
      );
    },
    [query, teamId]
  );

  const onFolderChange = useCallback(
    (folderId: string | null) => updateQuery('files', { folderId }),
    [updateQuery]
  );

  const onSearched = useCallback(
    (state: { query: string; filters: CatalogSearchFilters }) =>
      updateQuery('files', { q: state.query, filters: state.filters }),
    [updateQuery]
  );

  const onOpenTaskChange = useCallback(
    (taskId: string | null) => updateQuery('tasks', { taskId }),
    [updateQuery]
  );

  /**
   * Sending an asset to the task editor is a section change, so it goes through
   * the address like every other one. The shell stays mounted across it, which
   * is what lets the staged asset survive the navigation.
   */
  const createTaskFrom = useCallback(
    (asset: { ids: string[]; name: string }) => {
      setTaskAsset(asset);
      navigateTo(sectionRoute('tasks'));
    },
    [sectionRoute]
  );

  return (
    <section className="team-space-shell" aria-labelledby="team-space-shell-title">
      <header className="team-space-shell-header">
        <div className="team-space-shell-identity">
          <p className="team-workspace-eyebrow">{t('teamWorkspace')}</p>
          <SpaceSwitcher activeTeam={activeTeam} teams={teams} headingId="team-space-shell-title" />
        </div>
        <div className="team-space-shell-utilities">
          <RealtimeChip />
          {hasContent && section === 'files' && (
            <Button
              type="button"
              variant="secondary"
              aria-pressed={searchOpen}
              onClick={() => setSearchOpen(open => !open)}
            >
              {searchOpen ? t('teamSpaceSearchClose') : t('teamSpaceSearchToggle')}
            </Button>
          )}
          {/* Trash is a utility, not a fifth content tab: it is reached from
              where files are, and has its own address for a direct link. */}
          {(section === 'files' || section === 'trash') && (
            <a
              className="team-space-shell-utility-link"
              href={sectionRoute('trash')}
              aria-current={section === 'trash' ? 'page' : undefined}
              onClick={event => internalLink(event, sectionRoute('trash'))}
            >
              {t('teamTrashEntry')}
            </a>
          )}
          <a
            className="team-space-shell-utility-link"
            href={sectionRoute('settings')}
            aria-current={section === 'settings' ? 'page' : undefined}
            onClick={event => internalLink(event, sectionRoute('settings'))}
          >
            {t('teamSpaceSettings')}
          </a>
        </div>
      </header>

      {/* Real links, not toggles: middle-click, copy-link and Back all work, and
          the active one is announced rather than merely coloured. */}
      <nav className="team-space-tabs" aria-label={t('teamSectionsNavLabel')}>
        {CONTENT_TABS.map(tab => {
          const href = sectionRoute(tab.section);
          const active = section === tab.section;
          return (
            <a
              key={tab.section}
              className={`team-space-tab${active ? ' is-active' : ''}`}
              href={href}
              aria-current={active ? 'page' : undefined}
              onClick={event => internalLink(event, href)}
            >
              {t(tab.label)}
            </a>
          );
        })}
      </nav>

      {connectedToDrive && freshness && (
        <SyncProgress
          variant="banner"
          freshness={freshness}
          onRetry={async () => {
            try {
              await client.resyncDrive?.(teamId);
              push({ tone: 'success', text: t('teamToastResyncQueued') });
            } catch (cause) {
              push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
            }
          }}
        />
      )}

      <div className="team-space-shell-body">
        {section === 'trash' ? (
          <TrashView key={`trash:${teamId}`} teamId={teamId} />
        ) : section === 'settings' ? (
          <SpaceSettings
            key={`settings:${teamId}`}
            teamId={teamId}
            client={client}
            directAddMode={directAddMode}
            onBack={() => navigateTo(sectionRoute('files'))}
          />
        ) : section === 'landings' ? (
          <TeamLandings
            key={`landings:${teamId}`}
            teamId={teamId}
            client={client}
            onCreateTask={asset => createTaskFrom({ ids: [asset.id], name: asset.name })}
          />
        ) : section === 'creatives' ? (
          <CreativeLibrary
            key={`library:${teamId}`}
            teamId={teamId}
            onCreateTask={asset => createTaskFrom({ ids: [asset.id], name: asset.name })}
            onCreateTaskFromSelection={assets => {
              if (assets.length === 0) return;
              createTaskFrom({
                ids: assets.map(asset => asset.id),
                name: t('creativeLibrarySelectionSummary', { count: assets.length })
              });
            }}
          />
        ) : section === 'tasks' ? (
          <TaskSpace
            key={`tasks:${teamId}`}
            teamId={teamId}
            createFromAsset={taskAsset}
            onConsumedCreateFromAsset={() => setTaskAsset(null)}
            openTaskId={query?.taskId ?? null}
            onOpenTaskChange={onOpenTaskChange}
          />
        ) : !connectedToDrive && activeTeam ? (
          /* The connection is the reason there are no files, so say that
             instead of showing an empty tree (finding I4). */
          <SpaceStatePanel space={activeTeam} canManageDrive={activeTeam.role === 'owner'} />
        ) : searchOpen ? (
          <TeamCatalog
            key={`search:${teamId}`}
            teamId={teamId}
            client={client}
            onCreateTask={asset => createTaskFrom({ ids: [asset.id], name: asset.name })}
            initialQuery={query?.q}
            initialFilters={query?.filters}
            onSearched={onSearched}
          />
        ) : (
          <MaterialBrowser
            key={`materials:${teamId}`}
            teamId={teamId}
            client={client}
            folderId={query?.folderId ?? null}
            onFolderChange={onFolderChange}
            permissions={permissions}
            onChanged={() => setBrowserRevision(value => value + 1)}
            // A teammate's change arrives as a realtime revision bump; adding a
            // local counter means a row action refreshes the tree too, without
            // waiting for the round trip through the channel.
            revision={revision + browserRevision}
            onCreateTask={asset => createTaskFrom({ ids: [asset.id], name: asset.name })}
            onPreview={setPreviewing}
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
