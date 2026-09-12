import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useI18n, type TranslationKey } from '../../i18n';
import { internalLink, navigateTo } from '../../lib/navigation';
import { trackTeamWorkspaceSession } from '../../analytics/service';
import { useTeam } from '../TeamContext';
import { useOptionalAgent } from '../../AgentContext';
import { teamApi, type TeamMaterialSummary } from '../../api/team';
import type { TeamCatalogClient } from '../catalog/TeamCatalog';
import { MaterialPreview } from '../preview/MaterialPreview';
import { LandingFullView } from '../landings/LandingFullView';
import type { CatalogMaterialItem } from '@video-compressor/shared';
import type { TaskAccountScope } from '../tasks/useTasks';
import { StorageChip, type StorageChipClient } from '../storage/StorageChip';
import { useStorageHealth, type StorageHealthClient } from '../storage/useStorageHealth';
import type { SpaceSettingsClient } from './SpaceSettings';
import { SettingsDialog } from './SettingsDialog';
import { MembersSection } from './MembersSection';
import { SpaceSwitcher } from './SpaceSwitcher';
import { RealtimeChip } from './RealtimeChip';
import { BackgroundWorkChip } from './BackgroundWorkChip';
import { LibraryProcessingProvider } from '../library/LibraryProcessingProvider';
import { ProcessLibraryDialog, type LibraryBatchScope } from '../library/ProcessLibraryDialog';
import { SpaceStatePanel } from './SpaceStatePanel';
import type { ExplorerShellClient } from '../explorer/ExplorerShell';
import { BackgroundRenderProvider } from '../explorer/BackgroundRenderProvider';
import { renderTeamLanding } from '../../api/client';
import {
  buildTeamRoute,
  emptyTeamRouteQuery,
  type TeamRouteQuery,
  type TeamSection
} from '../routes';
import type { CatalogSearchFilters } from '@video-compressor/shared';

const TaskSpace = lazy(() =>
  import('../tasks/TaskSpace').then(module => ({ default: module.TaskSpace }))
);
const AccountSpace = lazy(() =>
  import('../accounts/AccountSpace').then(module => ({ default: module.AccountSpace }))
);
const ExplorerShell = lazy(() =>
  import('../explorer/ExplorerShell').then(module => ({ default: module.ExplorerShell }))
);

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
  { section: 'accounts', label: 'teamSectionAccounts' },
  { section: 'members', label: 'teamSectionMembers' }
];

/** How often the listing re-reads itself while the catalogue is being written. */
const INDEXING_REFRESH_MS = 5_000;

/** The Explorer deliberately carries a small material shape; the cached landing
 * viewer only needs the identity and display fields when it fetches its saved render. */
function landingViewerMaterial(material: TeamMaterialSummary): CatalogMaterialItem {
  return {
    id: material.id,
    teamId: material.teamId,
    parentFolderId: material.parentFolderId ?? null,
    name: material.name,
    kind: 'file',
    category: 'landing',
    mimeType: material.mimeType ?? null,
    fileExtension: material.fileExtension ?? null,
    classificationVersion: 0,
    classificationSource: 'inspected_landing',
    sizeBytes: material.sizeBytes ?? null,
    modifiedAt: material.modifiedAt ?? null,
    geo: null,
    language: null,
    offer: null,
    tags: [],
    transcriptIngestState: 'not_applicable',
    transcriptTruncated: false,
    previewState: material.previewState ?? 'ready',
    lineage: { hasSource: false, hasDerivatives: false, isVersion: false }
  };
}

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

  /*
   * Keep the explorer in step with a scan that is still running.
   *
   * The chip counts upwards while the catalogue fills, but the folder listing is read once
   * and then only when something the person did changes it — so a space being indexed for the
   * first time said "76 files so far" above a listing that said "this folder is empty". The
   * rows existed; nothing had asked for them again.
   *
   * Only while indexing, and only then: the catalogue is being written to by somebody else,
   * which is the one situation where re-reading on a timer is the honest thing to do rather
   * than a poll for its own sake.
   */
  useEffect(() => {
    if (health?.kind !== 'indexing') return;
    const timer = window.setInterval(() => {
      setBrowserRevision(current => current + 1);
      void refreshHealth();
    }, INDEXING_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [health?.kind, refreshHealth]);
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  /** Which materials the batch is about; empty is the whole space. */
  const [batchSources, setBatchSources] = useState<string[]>([]);
  /* The same set said in words, for the window's title. The explorer knows
     whether a set came from a folder or from picking files; the shell only
     passes that description along. */
  const [batchScope, setBatchScope] = useState<LibraryBatchScope>({ kind: 'space' });
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

  // The last place the explorer was — folder, kinds, view — so the "Провідник"
  // tab returns there instead of the root, and the shell can stay mounted.
  const [explorerQuery, setExplorerQuery] = useState<TeamRouteQuery>(
    () => query ?? emptyTeamRouteQuery()
  );
  useEffect(() => {
    if (section === 'explorer' && query) setExplorerQuery(query);
  }, [section, query]);

  // The same memory for the task list: its account scope and open task live in
  // the address, so leaving the section used to drop the filter somebody had
  // just set. Remembered here, the tab link rebuilds it on the way back.
  const [tasksQuery, setTasksQuery] = useState<TeamRouteQuery>(
    () => query ?? emptyTeamRouteQuery()
  );
  useEffect(() => {
    if (section === 'tasks' && query) setTasksQuery(query);
  }, [section, query]);

  /**
   * Which sections have been opened at least once.
   *
   * A section stays mounted after its first visit — hidden, not unmounted — so
   * a filter, a search, a scroll position and a half-finished edit are all
   * still there when somebody comes back. Mounting only on first visit is the
   * other half of that deal: a space that is opened and never leaves the
   * explorer must not pay for loading three sections nobody asked for.
   */
  const [visited, setVisited] = useState<ReadonlySet<TeamSection>>(() => new Set([section]));
  useEffect(() => {
    setVisited(previous => (previous.has(section) ? previous : new Set(previous).add(section)));
  }, [section]);
  // Switching spaces needs no reset here: TeamSpace keys this shell on the
  // team, so another space arrives as a new shell with an empty memory.

  const sectionRoute = useCallback(
    (target: TeamSection) =>
      buildTeamRoute({
        spaceId: teamId,
        section: target,
        query:
          target === 'explorer'
            ? {
                folderId: explorerQuery.folderId ?? null,
                kinds: explorerQuery.kinds ?? [],
                view: explorerQuery.view ?? null
              }
            : target === 'tasks'
              ? {
                  taskId: tasksQuery.taskId ?? null,
                  agentId: tasksQuery.agentId ?? null,
                  accountId: tasksQuery.accountId ?? null
                }
              : undefined
      }),
    [explorerQuery, tasksQuery, teamId]
  );

  /** Back to a clean explorer: root, nothing selected, no search or filter. */
  const resetExplorer = useCallback(() => {
    navigateTo(buildTeamRoute({ spaceId: teamId, section: 'explorer' }), true, false);
    setBrowserRevision(value => value + 1);
  }, [teamId]);

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
      // Sections stay mounted while hidden, so a stray report from one of them
      // must not move the address out from under the section being looked at.
      // Every caller reports its own state, so "only the visible one writes"
      // costs nothing and removes the whole class of surprise navigation.
      if (target !== section) return;
      navigateTo(
        buildTeamRoute({ spaceId: teamId, section: target, query: { ...query, ...patch } }),
        true,
        false
      );
    },
    [query, section, teamId]
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

  // The account scope of the task list (017) lives in the address too.
  // While tasks is the visible section the address is the truth; while it is
  // hidden the address describes somewhere else, so the remembered query is.
  const taskQuery = section === 'tasks' ? query : tasksQuery;
  const taskScope: TaskAccountScope = taskQuery?.agentId
    ? { kind: 'agent', agentRowId: taskQuery.agentId }
    : taskQuery?.accountId
      ? { kind: 'account', accountId: taskQuery.accountId }
      : { kind: 'all' };
  const onTaskScopeChange = useCallback(
    (scope: TaskAccountScope) =>
      updateQuery('tasks', {
        agentId: scope.kind === 'agent' ? scope.agentRowId : null,
        accountId: scope.kind === 'account' ? scope.accountId : null
      }),
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
      sourceMaterialIds={batchSources}
      scope={batchScope}
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
              <BackgroundWorkChip
                /* The chip only appears while a batch is running, so opening it
                   must show *that* batch. Resetting the scope here retitled a
                   folder run "the whole space" and widened what a second press
                   of Start would touch. */
                onOpen={() => setBatchDialogOpen(true)}
              />
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

          <Suspense fallback={<div className="team-space-shell-body" aria-busy="true" />}>
            <div className="team-space-shell-body">
              {/* Every section behaves the way the explorer already did: mounted
            on its first visit and hidden afterwards, never unmounted. A filter
            in Tasks, a scroll position in Accounts, a half-typed invitation in
            Members — all of it is still there on the way back, because none of
            it was thrown away. */}
              {visited.has('members') && (
                <div hidden={section !== 'members'}>
                  <MembersSection
                    key={`members:${teamId}`}
                    teamId={teamId}
                    client={client}
                    directAddMode={directAddMode}
                  />
                </div>
              )}
              {visited.has('tasks') && (
                <div hidden={section !== 'tasks'}>
                  <TaskSpace
                    key={`tasks:${teamId}`}
                    teamId={teamId}
                    createFromAsset={taskAsset}
                    onConsumedCreateFromAsset={() => setTaskAsset(null)}
                    openTaskId={taskQuery?.taskId ?? null}
                    onOpenTaskChange={onOpenTaskChange}
                    scope={taskScope}
                    onScopeChange={onTaskScopeChange}
                  />
                </div>
              )}
              {visited.has('accounts') && (
                <div hidden={section !== 'accounts'}>
                  <AccountSpace key={`accounts:${teamId}`} teamId={teamId} />
                </div>
              )}
              {/* Nothing was ever indexed, so the connection is genuinely the
            reason there are no files (finding I4). */}
              {section === 'explorer' && !browsable && activeTeam && (
                <SpaceStatePanel space={activeTeam} canManageDrive={activeTeam.role === 'owner'} />
              )}
              {/* The explorer stays mounted across a trip to Tasks or Members —
            hidden, not unmounted — so the open folder and the selection are
            still there on return (a section change used to reset both). It
            reads its own remembered query while another section is showing. */}
              <div hidden={section !== 'explorer' || (!browsable && Boolean(activeTeam))}>
                <ExplorerShell
                  key={`explorer:${teamId}`}
                  teamId={teamId}
                  client={client}
                  revision={revision + browserRevision}
                  query={section === 'explorer' && query ? query : explorerQuery}
                  onQueryChange={onExplorerQuery}
                  onFolderChange={onExplorerFolderChange}
                  onSearched={onSearched}
                  onReset={resetExplorer}
                  onPreview={setPreviewing}
                  onCreateTask={asset => createTaskFrom({ ids: [asset.id], name: asset.name })}
                  onCreateTaskFromSelection={assets => {
                    if (assets.length === 0) return;
                    createTaskFrom({
                      ids: assets.map(asset => asset.id),
                      name: t('creativeLibrarySelectionSummary', { count: assets.length })
                    });
                  }}
                  /* The file in hand, not the whole space: the dialog opens on
                   the material that was chosen. */
                  onProcessSelection={(materialIds, scope) => {
                    setBatchSources(materialIds);
                    setBatchScope(scope ?? { kind: 'selection', count: materialIds.length });
                    setBatchDialogOpen(true);
                  }}
                  onProcessLibrary={() => {
                    setBatchSources([]);
                    setBatchScope({ kind: 'space' });
                    setBatchDialogOpen(true);
                  }}
                  onChanged={() => setBrowserRevision(value => value + 1)}
                  readOnly={storageAttention}
                />
              </div>
            </div>
          </Suspense>

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
              scope={batchScope}
              onClose={() => setBatchDialogOpen(false)}
            />
          )}
          {previewing &&
            (previewing.category === 'landing' && previewing.landingRender?.state === 'ready' ? (
              <LandingFullView
                teamId={teamId}
                material={landingViewerMaterial(previewing)}
                artifact={{ preset: 'default' }}
                artifactClient={teamApi}
                onClose={() => setPreviewing(null)}
              />
            ) : (
              <MaterialPreview
                teamId={teamId}
                material={previewing}
                onClose={() => setPreviewing(null)}
              />
            ))}
        </section>
      </BackgroundRenderProvider>
    </LibraryProcessingProvider>
  );
}
