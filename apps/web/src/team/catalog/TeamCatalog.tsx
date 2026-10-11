import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type {
  CatalogMaterialItem,
  CatalogSearchFilters,
  CatalogSearchRequestInput,
  CatalogSearchResponse,
  CatalogVocabulary,
  MaterialMetadataPatch,
  TeamAnalyticsStorage,
  TeamMaterialProvenanceEntry,
  TeamMaterialRowKind,
  TeamMaterialTagColor,
  TeamProcessStartResult
} from '@video-compressor/shared';
import { normalizeSearchText, TEAM_MATERIAL_ROW_KINDS } from '@video-compressor/shared';
import { useOptionalAgent } from '../../AgentContext';
import type { TeamProcessStartInput } from '../../api/team';
import { teamApi } from '../../api/team';
import { startTeamAgentProcess } from '../../api/client';
import { Button, EmptyState, SegmentedControl } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { startTeamWorkflow, type TeamWorkflowFlow } from '../../analytics/service';
import type { DriveConnectionStatus, TeamMaterialSummary } from '../../api/team';
import { useTeam } from '../TeamContext';
import { CatalogFilters } from './CatalogFilters';
import { CatalogSearchBar } from './CatalogSearchBar';
import { MaterialMetadataEditor } from './MaterialMetadataEditor';
import { MaterialResults } from './MaterialResults';
import { Modal } from '../../components/Modal';
import { FolderPicker, type FolderPickerClient } from './FolderPicker';
import { useToasts } from '../../components/toast';
import { teamErrorMessage, teamErrorMessageFor } from '../errors';
import { effectiveSearchQuery, useCatalogSearch } from './useCatalogSearch';
import {
  clearRecentQueries,
  forgetQuery,
  readRecentQueries,
  rememberQuery,
  type RecentQuery
} from '../palette/recent';

/** How long an answered query sits untouched before it counts as used (search rework, 2026-10). */
const IDLE_COMMIT_MS = 1500;

/** Where the explorer's search looks: the open folder with its subfolders, or the whole space. */
export type CatalogSearchPlace = 'subtree' | 'space';
import { MaterialPreview } from '../preview/MaterialPreview';
import { TeamTextEditor } from './TeamTextEditor';
import { uploadTeamFile } from './material-actions-client';
import type { ThumbnailSession } from '@video-compressor/shared';
import { ProcessMaterialDialog } from '../processing/ProcessMaterialDialog';
import { ActiveOperation } from '../processing/MaterialProcessFlow';
import { carryTranscriptAfterProcess, defaultTailClient } from '../materials/tail';
import { ProvenancePanel } from './ProvenancePanel';

export interface TeamCatalogClient {
  /** Reads the folder tree behind the row menu's destination picker. */
  listMaterials: (teamId: string, parentFolderId: string | null) => Promise<TeamMaterialSummary[]>;
  searchCatalog: (
    teamId: string,
    request: CatalogSearchRequestInput
  ) => Promise<CatalogSearchResponse>;
  getCatalogVocabulary: (teamId: string) => Promise<CatalogVocabulary>;
  updateMaterialMetadata: (
    teamId: string,
    materialId: string,
    patch: MaterialMetadataPatch
  ) => Promise<CatalogMaterialItem>;
  getConnectionStatus?: (teamId: string) => Promise<DriveConnectionStatus>;
  /**
   * The thumbnail session a result's picture needs (024, FR-090).
   *
   * Optional: a catalog rendered without it falls back to the kind glyph,
   * which is what every result showed before.
   */
  mintThumbnailSession?: (teamId: string) => Promise<ThumbnailSession>;
  thumbnailUrl?: (session: ThumbnailSession, materialId: string) => string;
}

export function TeamCatalog({
  teamId,
  client,
  onCreateTask,
  onReveal,
  initialQuery,
  initialFilters,
  onSearched,
  autoFocusSearch = false,
  scopeFolderId,
  scope = 'folder',
  kinds,
  pathFor,
  tagging,
  onScopeChange,
  onClose
}: {
  teamId: string;
  client: TeamCatalogClient;
  onCreateTask?: (asset: { id: string; name: string }) => void;
  onReveal?: (material: CatalogMaterialItem) => void;
  /** Search state restored from the address. */
  initialQuery?: string;
  initialFilters?: CatalogSearchFilters;
  /** Reports the state behind each executed search so it can be addressed. */
  onSearched?: (state: { query: string; filters: CatalogSearchFilters }) => void;
  /** Focus the search field on mount (the explorer's "Search" button opened it). */
  autoFocusSearch?: boolean;
  /** The current folder for links that restore an existing folder-scoped search. */
  scopeFolderId?: string | null;
  /**
   * `space` searches everywhere; `folder` and `subtree` search the open folder
   * together with every folder under it (search rework, 2026-10).
   */
  scope?: 'folder' | 'space' | 'subtree';
  kinds?: TeamMaterialRowKind[];
  /** Moves the search between the open folder and the whole space (and restores a kind filter). */
  onScopeChange?: (next: { scope: CatalogSearchPlace; kinds?: TeamMaterialRowKind[] }) => void;
  /** Escape on an empty field: the search is put away. */
  onClose?: () => void;
  pathFor?: (material: CatalogMaterialItem) => string | null;
  /** Present only for the space's owner: the tag on a result (011). */
  tagging?: {
    canTag: true;
    onSetTag: (material: CatalogMaterialItem, color: TeamMaterialTagColor | null) => void;
  };
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { can, permissions } = useTeam();
  const agent = useOptionalAgent();
  const kindsKey = (kinds ?? []).join(',');
  /** A folder is open and the search is narrowed to it (with what is under it). */
  const inFolder = scope !== 'space' && Boolean(scopeFolderId);
  const searchScope = useMemo(
    () =>
      scopeFolderId === undefined && !kindsKey
        ? undefined
        : {
            parentFolderId: inFolder ? (scopeFolderId ?? null) : null,
            ...(inFolder ? { recursive: true } : {}),
            ...(kindsKey ? { kinds } : {})
          },
    // kindsKey stands in for the array's identity.
    [inFolder, kinds, kindsKey, scopeFolderId]
  );
  const catalog = useCatalogSearch({
    teamId,
    client,
    initialQuery,
    initialFilters,
    onSearched,
    scope: searchScope
  });
  const [storageKind, setStorageKind] = useState<TeamAnalyticsStorage | null>(null);
  /* The searches used lately, shared with the palette (search rework, 2026-10). */
  const [history, setHistory] = useState<RecentQuery[]>(() => readRecentQueries(teamId));
  useEffect(() => setHistory(readRecentQueries(teamId)), [teamId]);
  const typedQuery = effectiveSearchQuery(catalog.query).trim();
  const commitRef = useRef<() => void>(() => undefined);
  commitRef.current = () => {
    if (typedQuery === '') return;
    setHistory(
      rememberQuery(teamId, {
        query: catalog.layoutSwap?.shown ?? catalog.query,
        scope: inFolder ? 'folder' : 'space',
        kinds
      })
    );
  };
  const commitQuery = useCallback(() => commitRef.current(), []);
  // A query that found something and was left alone has been read: it is worth keeping.
  const answered = !catalog.loading && (catalog.result?.items.length ?? 0) > 0;
  useEffect(() => {
    if (!answered || typedQuery === '') return;
    const timer = window.setTimeout(commitQuery, IDLE_COMMIT_MS);
    return () => window.clearTimeout(timer);
  }, [answered, typedQuery, catalog.result, commitQuery]);

  /* The keyboard's row in the results while the caret stays in the field. */
  const [activeIndex, setActiveIndex] = useState(-1);
  useEffect(() => setActiveIndex(-1), [catalog.result]);
  /** Enter pressed before the answer to the query in the field arrived. */
  const openWhenAnswered = useRef(false);
  /* The results on screen answer an earlier query: the field changed and the pause before
     asking has not run out yet. Enter then waits for the answer rather than opening a row of
     the old one. */
  const stale =
    normalizeSearchText(catalog.layoutSwap?.original ?? catalog.answeredQuery) !==
    normalizeSearchText(effectiveSearchQuery(catalog.query));
  /**
   * The one overlay this surface is showing, if any.
   *
   * Seven independent booleans used to hold this, so "two dialogs at once" was
   * not just possible but easy — and the page behind them stayed scrollable and
   * clickable (finding C1). A discriminated union makes the stacked state
   * unrepresentable: opening one closes the last.
   */
  const [overlay, setOverlay] = useState<CatalogOverlay>(null);
  const closeOverlay = () => setOverlay(null);

  useEffect(() => {
    let active = true;
    if (!client.getConnectionStatus) return;
    void client
      .getConnectionStatus(teamId)
      .then(status => {
        if (active) setStorageKind(status.driveKind);
      })
      .catch(() => {
        if (active) setStorageKind(null);
      });
    return () => {
      active = false;
    };
  }, [client, teamId]);

  const openTextEditor = async (material: CatalogMaterialItem) => {
    const preview = await teamApi.previewMaterial(teamId, material.id, 'transcript');
    if (
      preview.kind !== 'transcript' ||
      preview.ingestState !== 'full' ||
      preview.text === null ||
      !preview.sourceVersion
    ) {
      return;
    }
    setOverlay({
      kind: 'text',
      material,
      text: preview.text,
      sourceVersion: preview.sourceVersion
    });
  };

  const startLocalProcess = (
    result: TeamProcessStartResult,
    input: TeamProcessStartInput,
    source: CatalogMaterialItem
  ) => {
    const workflow = startTeamWorkflow({
      category: source.category ?? 'other',
      cacheState: 'unknown',
      attemptNumber: 1,
      stage: 'downloading'
    });
    setOverlay({ kind: 'operation', id: result.operationId, source, workflow });
    void startTeamAgentProcess({
      operationId: result.operationId,
      toolId: input.toolId,
      options: {},
      sourceGrant: result.sourceGrant,
      finalizeGrant: result.finalizeGrant
    })
      // 012 (T010): a compressed or embedded copy takes the source's transcript along.
      .then(outcome =>
        outcome.state === 'succeeded'
          ? carryTranscriptAfterProcess({
              teamId,
              toolId: input.toolId,
              source: { id: source.id, name: source.name, category: source.category },
              result: { materialId: outcome.materialId, name: input.outputName },
              versionOf: input.versionOfMaterialId,
              destinationFolderId: input.destinationFolderId,
              client: defaultTailClient
            })
          : null
      )
      .catch(async (cause: unknown) => {
        const code = cause instanceof Error ? cause.message : 'PROCESS_FAILED';
        // The server-side operation is released either way, but the person is
        // told it failed — not that it was canceled, which is what the release
        // used to be mistaken for (finding S6).
        setOverlay(current =>
          current?.kind === 'operation' && current.id === result.operationId
            ? { ...current, failureCode: code }
            : current
        );
        push({ tone: 'error', text: teamErrorMessage(code, t) });
        await teamApi.cancelOperation(teamId, result.operationId).catch(() => undefined);
      });
  };

  /** A file opens over the results, so Escape comes back to them; a folder is gone to. */
  const openResult = (material: CatalogMaterialItem) => {
    commitQuery();
    if (material.kind === 'folder' && onReveal) onReveal(material);
    else setOverlay({ kind: 'preview', material });
  };

  useEffect(() => {
    if (!openWhenAnswered.current || catalog.loading || stale) return;
    openWhenAnswered.current = false;
    const first = catalog.result?.items[0];
    if (first) openResult(first);
    // Runs when an answer lands; openResult is rebuilt every render.
  }, [catalog.loading, catalog.result, stale]);

  const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const items = catalog.result?.items ?? [];
    if (event.key === 'ArrowDown') {
      if (items.length === 0) return;
      event.preventDefault();
      setActiveIndex(current => Math.min(items.length - 1, current + 1));
    } else if (event.key === 'ArrowUp') {
      if (activeIndex < 0) return;
      event.preventDefault();
      setActiveIndex(current => current - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if ((catalog.loading || stale) && activeIndex < 0) {
        commitQuery();
        openWhenAnswered.current = typedQuery !== '';
        return;
      }
      const target = items[activeIndex >= 0 ? activeIndex : 0];
      if (target && (typedQuery !== '' || activeIndex >= 0)) openResult(target);
    } else if (event.key === 'Escape') {
      // First the words, then the search itself.
      if (catalog.query !== '') {
        event.preventDefault();
        event.stopPropagation();
        catalog.setQuery('');
        setActiveIndex(-1);
      } else if (onClose) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }
  };

  const validKinds = (values: readonly string[] | undefined): TeamMaterialRowKind[] =>
    (values ?? []).filter((value): value is TeamMaterialRowKind =>
      (TEAM_MATERIAL_ROW_KINDS as readonly string[]).includes(value)
    );

  const applyHistory = (entry: RecentQuery) => {
    catalog.setQuery(entry.query);
    setHistory(rememberQuery(teamId, entry));
    if (!onScopeChange) return;
    const place: CatalogSearchPlace =
      entry.scope === 'folder' && scopeFolderId ? 'subtree' : 'space';
    const wantedKinds = validKinds(entry.kinds);
    if (place !== (inFolder ? 'subtree' : 'space') || wantedKinds.join(',') !== kindsKey) {
      onScopeChange({ scope: place, kinds: wantedKinds });
    }
  };

  const hasFacets = Object.values(catalog.filters).some(values => values.length > 0);
  const emptyActions = [
    inFolder && onScopeChange ? (
      <Button
        key="everywhere"
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => onScopeChange({ scope: 'space' })}
      >
        {t('searchEverywhere')}
      </Button>
    ) : null,
    hasFacets ? (
      <Button key="facets" type="button" variant="ghost" size="sm" onClick={catalog.resetFacets}>
        {t('searchResetFilters')}
      </Button>
    ) : null
  ].filter(Boolean);
  const empty = (
    <EmptyState
      title={
        typedQuery !== '' ? t('searchNothingFor', { query: typedQuery }) : t('teamCatalogEmpty')
      }
      action={
        emptyActions.length > 0 ? (
          <div className="team-catalog-empty-actions">{emptyActions}</div>
        ) : undefined
      }
    />
  );

  return (
    <section className="team-catalog" aria-labelledby="team-catalog-title">
      {/* The explorer is the page; this is its search, not a second product
          called "Каталог" opening inside it. The name stays for a screen
          reader, which needs the region to have one. */}
      <div className="team-panel-heading">
        <h2 id="team-catalog-title" className="sr-only">
          {t('teamCatalogTitle')}
        </h2>
        {catalog.loading && <small aria-live="polite">{t('teamCatalogRefreshing')}</small>}
      </div>
      <CatalogSearchBar
        value={catalog.query}
        onChange={catalog.setQuery}
        autoFocus={autoFocusSearch}
        onFieldKeyDown={onFieldKeyDown}
        history={history}
        onApplyHistory={applyHistory}
        onForgetHistory={entry => setHistory(forgetQuery(teamId, entry.query))}
        onClearHistory={() => {
          clearRecentQueries(teamId);
          setHistory([]);
        }}
      />
      {/* Only with a folder open: at the root the folder is the space. */}
      {scopeFolderId && onScopeChange && (
        <SegmentedControl
          size="sm"
          className="team-catalog-scope"
          label={t('searchScopeLabel')}
          value={inFolder ? 'subtree' : 'space'}
          options={[
            { value: 'subtree', label: t('searchScopeFolder'), title: t('searchScopeFolderHint') },
            { value: 'space', label: t('searchScopeSpace') }
          ]}
          onChange={place => onScopeChange({ scope: place })}
        />
      )}
      <CatalogFilters
        filters={catalog.filters}
        vocabulary={catalog.vocabulary}
        facets={catalog.result?.facets}
        hasContent={(catalog.result?.total ?? 0) > 0}
        onSet={catalog.setFacet}
        onRemove={catalog.removeFilter}
        onClear={catalog.clearFilters}
      />
      {catalog.layoutSwap && (
        <p className="team-catalog-layout-swap" role="status">
          <span>{t('searchLayoutShown', { query: catalog.layoutSwap.shown })}</span>
          <Button
            type="button"
            variant="link"
            size="xs"
            onClick={() => catalog.searchAsTyped(catalog.layoutSwap!.original)}
          >
            {t('searchLayoutAsTyped', { query: catalog.layoutSwap.original })}
          </Button>
        </p>
      )}
      <MaterialResults
        query={typedQuery === '' ? '' : catalog.answeredQuery}
        activeIndex={activeIndex}
        empty={empty}
        thumbnails={
          client.mintThumbnailSession && client.thumbnailUrl
            ? {
                mintThumbnailSession: client.mintThumbnailSession,
                thumbnailUrl: client.thumbnailUrl
              }
            : undefined
        }
        tagging={tagging}
        result={catalog.result}
        loading={catalog.loading}
        error={catalog.error}
        canManageMetadata={can('manage_metadata')}
        permissions={permissions!}
        storageKind={storageKind}
        onEditMetadata={material => setOverlay({ kind: 'metadata', material })}
        onPreview={material => {
          commitQuery();
          setOverlay({ kind: 'preview', material });
        }}
        onEditText={material => void openTextEditor(material)}
        onProcess={material => setOverlay({ kind: 'process', material })}
        onShowProvenance={material => {
          void teamApi
            .getMaterialProvenance(teamId, material.id)
            .then(entries => setOverlay({ kind: 'provenance', material, entries }))
            // A failed read used to open nothing at all: the button looked
            // broken rather than the request looking failed (finding S2).
            .catch((cause: unknown) => {
              push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
            });
        }}
        onCreateTask={onCreateTask}
        onReveal={
          onReveal
            ? material => {
                commitQuery();
                onReveal(material);
              }
            : undefined
        }
        onChanged={() => void catalog.refetch()}
        browseClient={client}
        page={catalog.page}
        onPageChange={catalog.setPage}
        pathFor={pathFor}
      />
      {overlay?.kind === 'metadata' && (
        <MaterialMetadataEditor
          material={overlay.material}
          vocabulary={catalog.vocabulary}
          onClose={closeOverlay}
          onSave={async patch => {
            await client.updateMaterialMetadata(teamId, overlay.material.id, patch);
            await catalog.refetch();
          }}
        />
      )}
      {overlay?.kind === 'preview' && (
        <MaterialPreview teamId={teamId} material={overlay.material} onClose={closeOverlay} />
      )}
      {overlay?.kind === 'text' && (
        <TeamTextEditor
          material={overlay.material}
          initialText={overlay.text}
          expectedDriveVersion={overlay.sourceVersion}
          onClose={closeOverlay}
          onReload={() => {
            const material = overlay.material;
            closeOverlay();
            return openTextEditor(material);
          }}
          onCreateVersion={text =>
            setOverlay({ kind: 'textVersion', material: overlay.material, text })
          }
          onSave={async input => {
            await teamApi.editText({ teamId, materialId: overlay.material.id, ...input });
            await catalog.refetch();
          }}
        />
      )}
      {overlay?.kind === 'process' && (
        <ProcessMaterialDialog
          teamId={teamId}
          material={overlay.material}
          destinationFolderId={overlay.material.parentFolderId ?? null}
          browseClient={client}
          agentAvailability={agent?.teamWorkspaceAvailability ?? 'disconnected'}
          toolContracts={agent?.toolContracts ?? {}}
          onClose={closeOverlay}
          onStarted={(result, input) => startLocalProcess(result, input, overlay.material)}
        />
      )}
      {overlay?.kind === 'operation' && (
        <ActiveOperation
          teamId={teamId}
          operationId={overlay.id}
          workflow={overlay.workflow}
          localFailureCode={overlay.failureCode ?? null}
          agentEnabled={agent?.teamWorkspaceAvailable === true}
          onClose={closeOverlay}
          onRetry={() => setOverlay({ kind: 'process', material: overlay.source })}
        />
      )}
      {overlay?.kind === 'provenance' && (
        <ProvenanceDialog
          entries={overlay.entries}
          material={overlay.material}
          onClose={closeOverlay}
          onNavigate={materialId => {
            const entry = overlay.entries.find(
              candidate =>
                candidate.sourceMaterialId === materialId ||
                candidate.derivativeMaterialId === materialId
            );
            const name =
              entry?.sourceMaterialId === materialId ? entry.sourceName : entry?.derivativeName;
            if (name) catalog.setQuery(name);
            closeOverlay();
          }}
        />
      )}
      {overlay?.kind === 'textVersion' && (
        <TextVersionDialog
          teamId={teamId}
          draft={overlay}
          browseClient={client}
          onClose={closeOverlay}
          onSaved={async () => {
            closeOverlay();
            await catalog.refetch();
          }}
        />
      )}
    </section>
  );
}

/** Every overlay this surface can show — exactly one at a time. */
type CatalogOverlay =
  | null
  | { kind: 'metadata'; material: CatalogMaterialItem }
  | { kind: 'preview'; material: CatalogMaterialItem }
  | { kind: 'text'; material: CatalogMaterialItem; text: string; sourceVersion: string }
  | { kind: 'process'; material: CatalogMaterialItem }
  | {
      kind: 'operation';
      id: string;
      source: CatalogMaterialItem;
      workflow: TeamWorkflowFlow;
      /** Set when the local run failed before the server could record why. */
      failureCode?: string;
    }
  | { kind: 'provenance'; material: CatalogMaterialItem; entries: TeamMaterialProvenanceEntry[] }
  | { kind: 'textVersion'; material: CatalogMaterialItem; text: string };

/** The provenance panel, on the one dialog primitive like everything else. */
function ProvenanceDialog({
  material,
  entries,
  onClose,
  onNavigate
}: {
  material: CatalogMaterialItem;
  entries: TeamMaterialProvenanceEntry[];
  onClose: () => void;
  onNavigate: (materialId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Modal labelledBy="team-provenance-title" size="md" onClose={onClose}>
      <ProvenancePanel
        materialId={material.id}
        entries={entries}
        inheritedMetadata={material}
        onNavigate={onNavigate}
      />
      <div className="team-dialog-actions">
        <Button type="button" variant="ghost" onClick={onClose}>
          {t('teamClose')}
        </Button>
      </div>
    </Modal>
  );
}

function TextVersionDialog({
  teamId,
  draft,
  browseClient,
  onClose,
  onSaved
}: {
  teamId: string;
  draft: { material: CatalogMaterialItem; text: string };
  browseClient: FolderPickerClient;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [destination, setDestination] = useState<{ id: string; name: string } | null>(null);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [name, setName] = useState(() => draft.material.name.replace(/\.txt$/iu, '-v2.txt'));
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await uploadTeamFile({
        teamId,
        destinationFolderId: destination?.id ?? '',
        file: new File([draft.text], name, { type: 'text/plain' }),
        conflictMode: 'cancel',
        replaceMaterialId: null,
        versionOfMaterialId: draft.material.id
      });
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'PROCESS_FAILED');
    }
  };
  return (
    <section className="team-operation-overlay">
      <h3>{t('teamTextEditorSeparateVersion')}</h3>
      <div className="team-process-destination">
        <span className="team-field-label">{t('teamFileDestination')}</span>
        <Button type="button" variant="secondary" onClick={() => setPickingFolder(true)}>
          {destination?.name ?? t('teamFolderPickerChoose')}
        </Button>
      </div>
      {pickingFolder && (
        <FolderPicker
          teamId={teamId}
          client={browseClient}
          title={t('teamTextEditorSeparateVersion')}
          onClose={() => setPickingFolder(false)}
          onSelect={folder => {
            setDestination(folder);
            setPickingFolder(false);
          }}
        />
      )}
      <label>
        {t('teamFileNewName')}
        <input value={name} onChange={event => setName(event.target.value)} />
      </label>
      {error && (
        <p className="team-inline-error" role="alert">
          {error}
        </p>
      )}
      <Button
        type="button"
        variant="primary"
        disabled={!destination || !name}
        onClick={() => void save()}
      >
        {t('teamTextEditorSave')}
      </Button>
      <Button type="button" variant="ghost" onClick={onClose}>
        {t('teamCancel')}
      </Button>
    </section>
  );
}
