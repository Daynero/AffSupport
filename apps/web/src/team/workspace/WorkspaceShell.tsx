import {
  createElement,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType
} from 'react';
import { useI18n, type TranslationKey } from '../../i18n';
import { internalLink, navigateTo } from '../../lib/navigation';
import { PaletteHost } from '../palette/PaletteHost';
import { ShortcutSheet } from '../palette/ShortcutSheet';
import { formatShortcut, matches, shortcutOf } from '../palette/shortcuts';
import { ChevronDown, Keyboard, RefreshCw, Search, Settings, Sparkles, Trash2 } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { DropdownMenu } from '../../components/ui/index';
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
import { CatalogUpdaterChip } from '../catalog-updater/CatalogUpdaterChip';
import { CatalogUpdaterDialog } from '../catalog-updater/CatalogUpdaterDialog';
import { useCatalogUpdater } from '../catalog-updater/useCatalogUpdater';
import { useRestitchPreparer } from '../catalog-updater/useRestitchPreparer';
import { MembersSection } from './MembersSection';
import { SpaceSwitcher } from './SpaceSwitcher';
import { RealtimeChip } from './RealtimeChip';
import { BackgroundWorkChip } from './BackgroundWorkChip';
import { LibraryProcessingProvider } from '../library/LibraryProcessingProvider';
import { AgentQueueProvider } from '../processing/AgentQueueProvider';
import { AddToTaskProvider } from '../tasks/AddToTask';
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
import { Tabs } from '../../components/ui/index';

/**
 * A section loaded on demand, drawn at once when its code is already here (024).
 *
 * `lazy` suspends for a tick on its first render even when the module has long been fetched, so
 * a first visit to Tasks painted an empty page between the tab press and the board. The code is
 * fetched in the background after the explorer is up; a section that finds it rendered directly,
 * and one that does not falls back to `lazy` for good (switching mid-life would remount it).
 */
function preloadable<Module, Props extends object>(
  load: () => Promise<Module>,
  pick: (module: Module) => ComponentType<Props>
) {
  let loaded: Module | null = null;
  const fetch = () =>
    load().then(module => {
      loaded = module;
      return module;
    });
  const Lazy = lazy(() => fetch().then(module => ({ default: pick(module) })));
  function Section(props: Props) {
    const [ready] = useState(() => loaded !== null);
    return ready && loaded ? createElement(pick(loaded), props) : createElement(Lazy, props);
  }
  return { Section, fetch };
}

const taskSection = preloadable(
  () => import('../tasks/TaskSpace'),
  module => module.TaskSpace
);
const accountSection = preloadable(
  () => import('../accounts/AccountSpace'),
  module => module.AccountSpace
);
const TaskSpace = taskSection.Section;
const AccountSpace = accountSection.Section;
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
  const { activeTeam, teams, revision, can } = useTeam();
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
  const [batchSelectionOpen, setBatchSelectionOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [spaceMenuOpen, setSpaceMenuOpen] = useState(false);
  const spaceMenuTrigger = useRef<HTMLButtonElement>(null);
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
  const [remembered, setVisited] = useState<ReadonlySet<TeamSection>>(() => new Set([section]));
  useEffect(() => {
    setVisited(previous => (previous.has(section) ? previous : new Set(previous).add(section)));
  }, [section]);
  /*
   * The section being opened counts as visited in the very render that opens it (024). Read
   * from state alone, the first frame after a tab press had the old section hidden and the new
   * one not yet mounted — an empty page, with the honeycomb behind it flashing through.
   */
  const visited = remembered.has(section) ? remembered : new Set(remembered).add(section);
  // The other sections' code, fetched once the explorer is up, so a first visit does not wait on
  // a chunk with nothing on screen.
  useEffect(() => {
    const idle = window.setTimeout(() => {
      void taskSection.fetch();
      void accountSection.fetch();
    }, 1500);
    return () => window.clearTimeout(idle);
  }, []);
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

  // The updater's state for the chip beside the settings link (023); the dialog reads its own.
  const catalogUpdater = useCatalogUpdater(teamId);
  // With re-stitching on, this tab lends the connected Soty app to the updater's spare copies (023).
  const restitchPreparer = useRestitchPreparer({
    teamId,
    enabled:
      catalogUpdater.state?.state === 'running' &&
      catalogUpdater.state.restitch &&
      can('process') &&
      agent?.teamWorkspaceAvailable === true
  });

  /** An explorer address that keeps the current folder and view. */
  /*
   * The two keystrokes the whole workspace answers (024, FR-099). Read from
   * the shortcut registry rather than spelled here, so the sheet that lists
   * them and the handler that serves them cannot disagree.
   */
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (matches(event, 'mod+k')) {
        event.preventDefault();
        navigateTo(explorerRouteRef.current({ palette: true }), true);
        return;
      }
      if (matches(event, 'mod+/')) {
        event.preventDefault();
        setShortcutsOpen(current => !current);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  /**
   * An address for one of the space's own surfaces, over wherever you are.
   *
   * It used to force `section: 'explorer'`, so opening the settings, the
   * updater or the trash from Tasks threw you into Files — and closing one
   * left you there, looking at a folder you had not asked for (024, FR-045).
   * The section is whatever is open; the surface rides on top of it.
   */
  const explorerRoute = useCallback(
    (patch: Partial<TeamRouteQuery>) =>
      buildTeamRoute({
        spaceId: teamId,
        section,
        query: {
          folderId: query?.folderId ?? null,
          kinds: query?.kinds ?? [],
          view: query?.view ?? null,
          taskId: query?.taskId ?? null,
          agentId: query?.agentId ?? null,
          accountId: query?.accountId ?? null,
          ...patch
        }
      }),
    [
      query?.accountId,
      query?.agentId,
      query?.folderId,
      query?.kinds,
      query?.taskId,
      query?.view,
      section,
      teamId
    ]
  );
  /** The trash, opened over a section other than Files, stands in for it. */
  const trashOver = Boolean(query?.trash) && section !== 'explorer';

  /*
   * The tab says where you are (024). The workspace never set a title, so the
   * tab kept whatever the last page wrote — "Soty — Tools" from the home page,
   * read as the name of a folder that happened to be called Tools.
   */
  const spaceName = activeTeam?.name ?? null;
  useEffect(() => {
    if (!spaceName) return;
    const where = query?.trash
      ? t('teamTrashEntry')
      : t(CONTENT_TABS.find(tab => tab.section === section)?.label ?? 'teamSectionExplorer');
    document.title = `${where} · ${spaceName} — Soty`;
  }, [query?.trash, section, spaceName, t]);

  /**
   * The address you are on, with one surface opened or closed over it (024,
   * FR-050).
   *
   * Unlike `explorerRoute`, which builds a fresh explorer address, this keeps
   * the whole query — the search, the selected file — because these surfaces
   * are about what you are looking at, and closing one must leave it as it was.
   * Pushed, so Back closes the surface rather than leaving the space.
   */
  const hereRoute = useCallback(
    (patch: Partial<TeamRouteQuery>) =>
      buildTeamRoute({ spaceId: teamId, section, query: { ...query, ...patch } }),
    [query, section, teamId]
  );

  /*
   * The preview is in the address too (024, FR-050): `item` names the file and
   * `open` says it is being looked at, so a reload or a pasted link reopens it.
   * The explorer restores it — it is the one that can find the row — and
   * reports it through `onPreview` like any other open, which is why an open
   * the address already describes does not push a second copy of itself.
   */
  const openPreview = useCallback(
    (material: TeamMaterialSummary) => {
      setPreviewing(material);
      if (query?.open && query.itemId === material.id) return;
      navigateTo(hereRoute({ itemId: material.id, open: true }));
    },
    [hereRoute, query?.itemId, query?.open]
  );
  // Replaced, not pushed: Back after closing goes to where the file was opened
  // from, not to the preview that was just closed.
  const closePreview = useCallback(() => {
    setPreviewing(null);
    navigateTo(hereRoute({ open: false }), true);
  }, [hereRoute]);
  // Back out of an open preview closes it.
  useEffect(() => {
    if (!query?.open) setPreviewing(null);
  }, [query?.open]);

  /* The document-level handler is bound once; the route builder is not, so it
     is read through a ref rather than making the listener churn on every
     folder change. */
  const explorerRouteRef = useRef(explorerRoute);
  explorerRouteRef.current = explorerRoute;

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
      //
      // The trash is the explorer, and it is the visible one wherever it is
      // open (024, FR-046) — over Tasks too. Its reports are written under the
      // section it was opened over, so closing it lands back there; a folder
      // chosen from its tree is a trip to Files, because that is where
      // folders are.
      const visible = trashOver ? 'explorer' : section;
      if (target !== visible) return;
      const toFiles = trashOver && patch.trash !== false && 'folderId' in patch;
      navigateTo(
        buildTeamRoute({
          spaceId: teamId,
          section: toFiles ? 'explorer' : section,
          query: { ...query, ...patch, ...(toFiles ? { trash: false } : {}) }
        }),
        !toFiles,
        false
      );
    },
    [query, section, teamId, trashOver]
  );

  const onExplorerFolderChange = useCallback(
    (folderId: string | null) =>
      // Moving to another folder is working in Files now; the way back to the
      // task that sent you here goes with it (024, FR-080).
      updateQuery('explorer', { folderId, itemId: null, back: null }),
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
        {/* The local app's queue is the space's (024, FR-077): a task can start a
            transcript as well as Files can, and the run outlives either. */}
        <AddToTaskProvider teamId={teamId}>
          <AgentQueueProvider
            teamId={teamId}
            onChanged={() => setBrowserRevision(value => value + 1)}
          >
            <section className="team-space-shell" aria-labelledby="team-space-shell-title">
              {/* The space's chrome on its own ground (024, US14): the name, the
                sections and the utilities sat straight on the hexagon field,
                and a lit cell swallowed whatever crossed it. */}
              <div className="team-space-shell-chrome">
                <header className="team-space-shell-header">
                  <div className="team-space-shell-identity">
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
                        open={Boolean(query?.storage)}
                        onOpenChange={next => navigateTo(hereRoute({ storage: next }), !next)}
                      />
                    )}
                    <RealtimeChip />
                    <BackgroundWorkChip
                      /* The chip only appears while a batch is running, so opening it
                   must show *that* batch. Resetting the scope here retitled a
                   folder run "the whole space" and widened what a second press
                   of Start would touch. */
                      onOpen={() => navigateTo(hereRoute({ process: true }))}
                    />
                    <CatalogUpdaterChip
                      state={catalogUpdater.state}
                      offsetMs={catalogUpdater.offsetMs}
                      href={explorerRoute({ updater: true })}
                      onNavigate={event => internalLink(event, explorerRoute({ updater: true }))}
                    />
                    {/* One way in, said on screen (024, FR-094): the palette had
                    only a chord, which is a feature for whoever read the code. */}
                    <button
                      type="button"
                      className="team-space-shell-utility-link team-space-shell-find"
                      aria-label={`${t('teamSpaceFind')} (${formatShortcut(shortcutOf('palette')!.keys)})`}
                      onClick={() => navigateTo(explorerRoute({ palette: true }), true)}
                    >
                      <Search size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                      {t('teamSpaceFind')}
                      <kbd>{formatShortcut(shortcutOf('palette')!.keys)}</kbd>
                    </button>
                    {/* The space's own surfaces, in one menu (024, FR-094). Three
                    links and a chip were the header's loudest row, and each of
                    them is visited rarely. Trash, the updater and the settings
                    still have addresses, so Back closes them and a pasted link
                    opens them (011); they ride over whatever section is open
                    (FR-045). */}
                    <button
                      ref={spaceMenuTrigger}
                      type="button"
                      className="team-space-shell-utility-link"
                      aria-haspopup="menu"
                      aria-expanded={spaceMenuOpen}
                      onClick={() => setSpaceMenuOpen(true)}
                    >
                      {t('teamSpaceMenu')}
                      <ChevronDown size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                    </button>
                    <DropdownMenu
                      open={spaceMenuOpen}
                      onClose={() => setSpaceMenuOpen(false)}
                      anchor={spaceMenuTrigger}
                      label={t('teamSpaceMenu')}
                      items={[
                        {
                          id: 'settings',
                          label: t('teamSpaceSettings'),
                          icon: (
                            <Settings
                              size={ICON_SIZE}
                              strokeWidth={ICON_STROKE}
                              aria-hidden="true"
                            />
                          ),
                          onSelect: () => navigateTo(explorerRoute({ settings: true }))
                        },
                        {
                          id: 'updater',
                          label: t('catalogUpdaterEntry'),
                          icon: (
                            <RefreshCw
                              size={ICON_SIZE}
                              strokeWidth={ICON_STROKE}
                              aria-hidden="true"
                            />
                          ),
                          onSelect: () => navigateTo(explorerRoute({ updater: true }))
                        },
                        /* The whole space at once, in the space's menu (024): at the root it
                           was a bare "Process everything" beside "Add files" — rare, heavy,
                           and it looked like the next step. A folder's own "Process" menu
                           and a selection's "Process N" stay where the files are. */
                        ...(can('process') && browsable
                          ? [
                              {
                                id: 'process-space',
                                label: t('teamProcessWholeSpace'),
                                icon: (
                                  <Sparkles
                                    size={ICON_SIZE}
                                    strokeWidth={ICON_STROKE}
                                    aria-hidden="true"
                                  />
                                ),
                                onSelect: () => {
                                  setBatchSources([]);
                                  setBatchScope({ kind: 'space' });
                                  navigateTo(hereRoute({ process: true }));
                                }
                              }
                            ]
                          : []),
                        {
                          id: 'trash',
                          label: t('teamTrashEntry'),
                          icon: (
                            <Trash2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                          ),
                          onSelect: () => navigateTo(explorerRoute({ trash: true }))
                        },
                        'separator',
                        {
                          id: 'shortcuts',
                          label: t('shortcutSheet'),
                          icon: (
                            <Keyboard
                              size={ICON_SIZE}
                              strokeWidth={ICON_STROKE}
                              aria-hidden="true"
                            />
                          ),
                          trailing: formatShortcut(shortcutOf('shortcuts')!.keys),
                          onSelect: () => setShortcutsOpen(true)
                        }
                      ]}
                    />
                  </div>
                </header>

                {/* Real links, not toggles: middle-click, copy-link and Back all work,
          and the active one is announced rather than merely coloured. The strip
          is the inventory's (021, T082), which grew the address variant for
          exactly this. */}
                <Tabs
                  className="team-space-tabs"
                  label={t('teamSectionsNavLabel')}
                  value={section}
                  /* No page crossfade between sections (the owner, 024): the header and
                     the tabs stay where they are, and fading the whole page out and
                     back in let the honeycomb behind it flash through on every switch. */
                  onChange={next => navigateTo(sectionRoute(next), false, false)}
                  onNavigate={(event, tab) => internalLink(event, sectionRoute(tab.id), false)}
                  items={CONTENT_TABS.map(tab => ({
                    id: tab.section,
                    label: t(tab.label),
                    href: sectionRoute(tab.section)
                  }))}
                />
              </div>

              <Suspense fallback={<div className="team-space-shell-body" aria-busy="true" />}>
                <div className="team-space-shell-body">
                  {/* Every section behaves the way the explorer already did: mounted
            on its first visit and hidden afterwards, never unmounted. A filter
            in Tasks, a scroll position in Accounts, a half-typed invitation in
            Members — all of it is still there on the way back, because none of
            it was thrown away. */}
                  {visited.has('members') && (
                    <div hidden={section !== 'members' || trashOver}>
                      <MembersSection
                        key={`members:${teamId}`}
                        teamId={teamId}
                        client={client}
                        directAddMode={directAddMode}
                      />
                    </div>
                  )}
                  {visited.has('tasks') && (
                    <div hidden={section !== 'tasks' || trashOver}>
                      <Suspense fallback={null}>
                        <TaskSpace
                          key={`tasks:${teamId}`}
                          teamId={teamId}
                          createFromAsset={taskAsset}
                          onConsumedCreateFromAsset={() => setTaskAsset(null)}
                          /* The editor is a dialog, portalled to the page: while Tasks is
                      hidden it would float over whatever section is showing — "Show
                      in folder" opened Files under a task that stayed on top of it.
                      The open task is remembered either way, and comes back with
                      the tab or the way-back chip. */
                          openTaskId={section === 'tasks' ? (taskQuery?.taskId ?? null) : null}
                          onOpenTaskChange={onOpenTaskChange}
                          scope={taskScope}
                          onScopeChange={onTaskScopeChange}
                        />
                      </Suspense>
                    </div>
                  )}
                  {visited.has('accounts') && (
                    <div hidden={section !== 'accounts' || trashOver}>
                      <Suspense fallback={null}>
                        <AccountSpace key={`accounts:${teamId}`} teamId={teamId} />
                      </Suspense>
                    </div>
                  )}
                  {/* Nothing was ever indexed, so the connection is genuinely the
            reason there are no files (finding I4). */}
                  {section === 'explorer' && !browsable && activeTeam && (
                    <SpaceStatePanel
                      space={activeTeam}
                      canManageDrive={activeTeam.role === 'owner'}
                    />
                  )}
                  {/* The explorer stays mounted across a trip to Tasks or Members —
            hidden, not unmounted — so the open folder and the selection are
            still there on return (a section change used to reset both). It
            reads its own remembered query while another section is showing. */}
                  {/* The trash is the explorer wearing a different list, so it is
            shown wherever it is asked for — including from Tasks or Accounts,
            which is where a file you deleted from a task actually went. */}
                  <div
                    hidden={
                      (section !== 'explorer' && !query?.trash) ||
                      (!browsable && Boolean(activeTeam))
                    }
                  >
                    <ExplorerShell
                      key={`explorer:${teamId}`}
                      teamId={teamId}
                      client={client}
                      revision={revision + browserRevision}
                      query={
                        (section === 'explorer' || query?.trash) && query ? query : explorerQuery
                      }
                      onQueryChange={onExplorerQuery}
                      onFolderChange={onExplorerFolderChange}
                      onSearched={onSearched}
                      onReset={resetExplorer}
                      trashReturnLabel={
                        trashOver
                          ? t(CONTENT_TABS.find(tab => tab.section === section)!.label)
                          : undefined
                      }
                      onPreview={openPreview}
                      onCreateTask={asset =>
                        createTaskFrom({ ids: [asset.id], name: taskTitleFor([asset], t) })
                      }
                      onCreateTaskFromSelection={assets => {
                        if (assets.length === 0) return;
                        createTaskFrom({
                          ids: assets.map(asset => asset.id),
                          name: taskTitleFor(assets, t)
                        });
                      }}
                      /* The file in hand, not the whole space: the dialog opens on
                   the material that was chosen. */
                      onProcessSelection={(materialIds, scope) => {
                        setBatchSources(materialIds);
                        setBatchScope(scope ?? { kind: 'selection', count: materialIds.length });
                        setBatchSelectionOpen(true);
                      }}
                      onProcessLibrary={() => {
                        setBatchSources([]);
                        setBatchScope({ kind: 'space' });
                        navigateTo(hereRoute({ process: true }));
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
                  initialTab={query.settingsTab}
                  onClose={() => navigateTo(explorerRoute({ settings: false, settingsTab: null }))}
                />
              )}

              {/*
               * One way in, to anything (024, US6). In the address like the
               * settings and the updater, so Back closes it — a surface the
               * history does not know about is a surface Back throws you out of.
               */}
              {query?.palette && (
                <PaletteHost
                  teamId={teamId}
                  onClose={() => navigateTo(explorerRoute({ palette: false }), true)}
                  onShortcuts={() => {
                    navigateTo(explorerRoute({ palette: false }), true);
                    setShortcutsOpen(true);
                  }}
                />
              )}
              {shortcutsOpen && <ShortcutSheet onClose={() => setShortcutsOpen(false)} />}

              {query?.updater && (
                <CatalogUpdaterDialog
                  teamId={teamId}
                  preparing={restitchPreparer.preparing}
                  onClose={() => navigateTo(explorerRoute({ updater: false }))}
                  onChanged={catalogUpdater.reload}
                  onReveal={row =>
                    navigateTo(
                      buildTeamRoute({
                        spaceId: teamId,
                        section: 'explorer',
                        query: { folderId: row.folderDriveId, itemId: row.catalogId }
                      })
                    )
                  }
                />
              )}

              {/* The whole space is in the address; a batch over picked files is
              not, because the pick is not (024, FR-050). */}
              {(batchSelectionOpen || query?.process) && (
                <ProcessLibraryDialog
                  agentCompatible={agent?.teamWorkspaceAvailable === true}
                  scope={batchScope}
                  onClose={() => {
                    if (batchSelectionOpen) setBatchSelectionOpen(false);
                    else navigateTo(hereRoute({ process: false }), true);
                  }}
                />
              )}
              {previewing &&
                (previewing.category === 'landing' &&
                previewing.landingRender?.state === 'ready' ? (
                  <LandingFullView
                    teamId={teamId}
                    material={landingViewerMaterial(previewing)}
                    artifact={{ preset: 'default' }}
                    artifactClient={teamApi}
                    onClose={closePreview}
                  />
                ) : (
                  <MaterialPreview teamId={teamId} material={previewing} onClose={closePreview} />
                ))}
            </section>
          </AgentQueueProvider>
        </AddToTaskProvider>
      </BackgroundRenderProvider>
    </LibraryProcessingProvider>
  );
}

/**
 * A task made from files is named after them: "Db3_2", or "Db3_2 та ще 2".
 * It was "Завдання: Файлів: 1" — the word the board already says on every
 * card, and a count instead of the thing a person would look for.
 */
function taskTitleFor(
  assets: ReadonlyArray<{ name: string }>,
  t: ReturnType<typeof useI18n>['t']
): string {
  const first = assets[0]?.name ?? '';
  const dot = first.lastIndexOf('.');
  const name = dot > 0 ? first.slice(0, dot) : first;
  return assets.length > 1 ? t('teamTaskFromFilesTitle', { name, count: assets.length - 1 }) : name;
}
