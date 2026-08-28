import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n, type TranslationKey } from '../../i18n';
import { internalLink, navigateTo } from '../../lib/navigation';
import { trackTeamWorkspaceSession } from '../../analytics/service';
import { useTeam } from '../TeamContext';
import { useOptionalAgent } from '../../AgentContext';
import { type TeamMaterialSummary } from '../../api/team';
import type { TeamCatalogClient } from '../catalog/TeamCatalog';
import { MaterialPreview } from '../preview/MaterialPreview';
import { TaskSpace } from '../tasks';
import { StorageChip, type StorageChipClient } from '../storage/StorageChip';
import { useStorageHealth, type StorageHealthClient } from '../storage/useStorageHealth';
import type { SpaceSettingsClient } from './SpaceSettings';
import { SettingsDialog } from './SettingsDialog';
import { MembersSection } from './MembersSection';
import { SpaceSwitcher } from './SpaceSwitcher';
import { RealtimeChip } from './RealtimeChip';
import { BackgroundWorkChip } from './BackgroundWorkChip';
import { LibraryProcessingProvider } from '../library/LibraryProcessingProvider';
import { ProcessLibraryDialog } from '../library/ProcessLibraryDialog';
import { SpaceStatePanel } from './SpaceStatePanel';
import { ExplorerShell, type ExplorerShellClient } from '../explorer/ExplorerShell';
import { BackgroundRenderProvider } from '../explorer/BackgroundRenderProvider';
import { renderTeamLanding } from '../../api/client';
import {
  buildTeamRoute,
  emptyTeamRouteQuery,
  type TeamRouteQuery,
  type TeamSection
} from '../routes';
import type { CatalogSearchFilters } from '@video-compressor/shared';

export type WorkspaceShellClient = TeamCatalogClient &
  SpaceSettingsClient &
  ExplorerShellClient &
  StorageHealthClient &
  StorageChipClient;

/**
 * The content tabs, in the order they appear. Settings and Trash are also
 * sections but are not tabs: they are utilities reached from the header and the
 * Files toolbar, and mixing them into the same row is what made the old header
 * a wall of six identical buttons.
 */
const CONTENT_TABS: { section: TeamSection; label: TranslationKey }[] = [
  { section: 'explorer', label: 'teamSectionExplorer' },
  { section: 'tasks', label: 'teamSectionTasks' },
  { section: 'members', label: 'teamSectionMembers' }
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
  section = 'explorer',
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
  const { activeTeam, teams, revision } = useTeam();
  const agent = useOptionalAgent();
  const connectedToDrive = activeTeam?.connectionState === 'connected';
  /**
   * A catalog that was indexed once stays browsable even when the connection
   * needs a person (011, FR-033). Hiding the explorer behind the state panel
   * would take away the one thing the member came for and make an expired
   * token look like data loss; the chip explains it and offers the fix. The
   * list is exactly the states the chip reports as `attention`, so the two
   * never disagree — `unavailable` reads as disconnected and keeps the panel.
   */
  const browsable =
    activeTeam !== null &&
    ['connected', 'needs_reauth', 'root_missing'].includes(activeTeam.connectionState);
  const connectionNeedsPerson =
    activeTeam !== null && ['needs_reauth', 'root_missing'].includes(activeTeam.connectionState);
  // One storage state for the whole space (011, FR-031): the chip in the header
  // replaces the old sync banner, and an attention state makes the explorer
  // read-only rather than letting writes fail one by one.
  const { health, refresh: refreshHealth } = useStorageHealth({
    teamId,
    client,
    enabled:
      activeTeam !== null &&
      activeTeam.connectionState !== 'none' &&
      activeTeam.connectionState !== 'detached'
  });
  /**
   * Only the reasons that actually stop a write make the space read-only. A
   * scan that failed is not one of them: the catalog is there and the folder
   * still accepts uploads, so taking the buttons away would punish everyone
   * for a background job. The connection state is authoritative the moment it
   * changes; the health read confirms it a beat later.
   */
  const storageAttention =
    connectionNeedsPerson || (health?.kind === 'attention' && health.reason !== 'sync_failed');
  const [browserRevision, setBrowserRevision] = useState(0);
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [taskAsset, setTaskAsset] = useState<{ ids: string[]; name: string } | null>(null);
  const [previewing, setPreviewing] = useState<TeamMaterialSummary | null>(null);
  const sessionTeam = useRef<string | null>(null);

  useEffect(() => {
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

  /** An explorer address that keeps the current folder and view. */
  const explorerRoute = useCallback(
    (patch: Partial<TeamRouteQuery>) =>
      buildTeamRoute({
        spaceId: teamId,
        section: 'explorer',
        query: {
          folderId: query?.folderId ?? null,
          kinds: query?.kinds ?? [],
          view: query?.view ?? null,
          ...patch
        }
      }),
    [query?.folderId, query?.kinds, query?.view, teamId]
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

  const onExplorerFolderChange = useCallback(
    (folderId: string | null) => updateQuery('explorer', { folderId, itemId: null }),
    [updateQuery]
  );

  const onExplorerQuery = useCallback(
    (patch: Partial<TeamRouteQuery>) => updateQuery('explorer', patch),
    [updateQuery]
  );

  const onSearched = useCallback(
    (state: { query: string; filters: CatalogSearchFilters }) =>
      updateQuery('explorer', { q: state.query, filters: state.filters }),
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
    /* The batch belongs to the space, not to the window that started it: this
       provider is mounted for as long as the space is open, and only leaving it
       releases the lease (finding B1). */
    <LibraryProcessingProvider
      teamId={teamId}
      agentCompatible={agent?.teamWorkspaceAvailable === true}
      toolContracts={agent?.toolContracts ?? {}}
      onChanged={() => setBrowserRevision(value => value + 1)}
    >
      {/* Landing renders prepared in the background while the space is open (011):
        one at a time, only on a paired local app that reports the contract, and
        only while this computer is not paused. */}
      <BackgroundRenderProvider
        teamId={teamId}
        client={client}
        agent={{
          paired: agent?.teamWorkspaceAvailable === true && connectedToDrive,
          toolContracts: agent?.toolContracts ?? {},
          render: renderTeamLanding
        }}
        revision={revision}
        onRendered={() => setBrowserRevision(value => value + 1)}
      >
        <section className="team-space-shell" aria-labelledby="team-space-shell-title">
          <header className="team-space-shell-header">
            <div className="team-space-shell-identity">
              <p className="team-workspace-eyebrow">{t('teamWorkspace')}</p>
              <SpaceSwitcher
                activeTeam={activeTeam}
                teams={teams}
                headingId="team-space-shell-title"
              />
            </div>
            <div className="team-space-shell-utilities">
              {activeTeam && (
                <StorageChip
                  teamId={teamId}
                  health={health}
                  client={client}
                  isOwner={activeTeam.role === 'owner'}
                  canManage={activeTeam.role === 'owner' || activeTeam.role === 'admin'}
                  settingsHref={explorerRoute({ settings: true })}
                  onRefresh={refreshHealth}
                />
              )}
              <RealtimeChip />
              <BackgroundWorkChip onOpen={() => setBatchDialogOpen(true)} />
              {/* Trash and settings are views of the explorer now (011): real
              links with their own addresses, so Back closes them and a pasted
              link opens them. */}
              {section === 'explorer' && (
                <a
                  className="team-space-shell-utility-link"
                  href={explorerRoute({ trash: true })}
                  aria-current={query?.trash ? 'page' : undefined}
                  onClick={event => internalLink(event, explorerRoute({ trash: true }))}
                >
                  {t('teamTrashEntry')}
                </a>
              )}
              <a
                className="team-space-shell-utility-link"
                href={explorerRoute({ settings: true })}
                aria-current={query?.settings ? 'page' : undefined}
                onClick={event => internalLink(event, explorerRoute({ settings: true }))}
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

          <div className="team-space-shell-body">
            {section === 'members' ? (
              <MembersSection
                key={`members:${teamId}`}
                teamId={teamId}
                client={client}
                directAddMode={directAddMode}
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
            ) : !browsable && activeTeam ? (
              /* Nothing was ever indexed, so the connection is genuinely the reason
             there are no files (finding I4). */
              <SpaceStatePanel space={activeTeam} canManageDrive={activeTeam.role === 'owner'} />
            ) : (
              <ExplorerShell
                key={`explorer:${teamId}`}
                teamId={teamId}
                client={client}
                revision={revision + browserRevision}
                query={query ?? emptyTeamRouteQuery()}
                onQueryChange={onExplorerQuery}
                onFolderChange={onExplorerFolderChange}
                onSearched={onSearched}
                onPreview={setPreviewing}
                onCreateTask={asset => createTaskFrom({ ids: [asset.id], name: asset.name })}
                onCreateTaskFromSelection={assets => {
                  if (assets.length === 0) return;
                  createTaskFrom({
                    ids: assets.map(asset => asset.id),
                    name: t('creativeLibrarySelectionSummary', { count: assets.length })
                  });
                }}
                onProcessSelection={() => setBatchDialogOpen(true)}
                onChanged={() => setBrowserRevision(value => value + 1)}
                readOnly={storageAttention}
              />
            )}
          </div>

          {query?.settings && (
            <SettingsDialog
              teamId={teamId}
              client={client}
              directAddMode={directAddMode}
              onClose={() => navigateTo(explorerRoute({ settings: false }))}
            />
          )}

          {batchDialogOpen && (
            <ProcessLibraryDialog
              agentCompatible={agent?.teamWorkspaceAvailable === true}
              onClose={() => setBatchDialogOpen(false)}
            />
          )}
          {previewing && (
            <MaterialPreview
              teamId={teamId}
              material={previewing}
              onClose={() => setPreviewing(null)}
            />
          )}
        </section>
      </BackgroundRenderProvider>
    </LibraryProcessingProvider>
  );
}
