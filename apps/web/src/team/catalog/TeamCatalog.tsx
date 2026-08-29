import { useEffect, useMemo, useState } from 'react';
import type {
  CatalogMaterialItem,
  CatalogSearchFilters,
  CatalogSearchRequestInput,
  CatalogSearchResponse,
  CatalogVocabulary,
  MaterialMetadataPatch,
  TeamAnalyticsStage,
  TeamAnalyticsStorage,
  TeamMaterialProvenanceEntry,
  TeamMaterialRowKind,
  TeamProcessStartResult
} from '@video-compressor/shared';
import { useOptionalAgent } from '../../AgentContext';
import type { TeamProcessStartInput } from '../../api/team';
import { teamApi } from '../../api/team';
import { startTeamAgentProcess } from '../../api/client';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import {
  completeTeamWorkflow,
  startTeamWorkflow,
  type TeamWorkflowFlow
} from '../../analytics/service';
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
import { useCatalogSearch } from './useCatalogSearch';
import { MaterialPreview } from '../preview/MaterialPreview';
import { TeamTextEditor } from './TeamTextEditor';
import { uploadTeamFile } from './material-actions-client';
import { ProcessMaterialDialog } from '../processing/ProcessMaterialDialog';
import { OperationStatus } from '../processing/OperationStatus';
import { useTeamOperation } from '../processing/useTeamOperation';
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
}

export function TeamCatalog({
  teamId,
  client,
  onCreateTask,
  initialQuery,
  initialFilters,
  onSearched,
  autoFocusSearch = false,
  scopeFolderId,
  scope = 'folder',
  onScopeChange,
  kinds,
  pathFor
}: {
  teamId: string;
  client: TeamCatalogClient;
  onCreateTask?: (asset: { id: string; name: string }) => void;
  /** Search state restored from the address. */
  initialQuery?: string;
  initialFilters?: CatalogSearchFilters;
  /** Reports the state behind each executed search so it can be addressed. */
  onSearched?: (state: { query: string; filters: CatalogSearchFilters }) => void;
  /** Focus the search field on mount (the explorer's "Search" button opened it). */
  autoFocusSearch?: boolean;
  /**
   * 011: the explorer's search. When a folder is given, a scope toggle lets the
   * person widen from it to the whole space; kinds narrow either way.
   */
  scopeFolderId?: string | null;
  scope?: 'folder' | 'space';
  onScopeChange?: (scope: 'folder' | 'space') => void;
  kinds?: TeamMaterialRowKind[];
  pathFor?: (material: CatalogMaterialItem) => string | null;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { can, permissions } = useTeam();
  const agent = useOptionalAgent();
  const kindsKey = (kinds ?? []).join(',');
  const searchScope = useMemo(
    () =>
      scopeFolderId === undefined && !kindsKey
        ? undefined
        : {
            parentFolderId: scope === 'space' ? null : (scopeFolderId ?? null),
            ...(kindsKey ? { kinds } : {})
          },
    // kindsKey stands in for the array's identity.
    [kinds, kindsKey, scope, scopeFolderId]
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
    }).catch(async (cause: unknown) => {
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

  return (
    <section className="team-panel team-catalog" aria-labelledby="team-catalog-title">
      <div className="team-panel-heading">
        <h2 id="team-catalog-title">{t('teamCatalogTitle')}</h2>
        {catalog.loading && <small aria-live="polite">{t('teamCatalogRefreshing')}</small>}
      </div>
      <CatalogSearchBar
        value={catalog.query}
        onChange={catalog.setQuery}
        autoFocus={autoFocusSearch}
      />
      {scopeFolderId !== undefined && onScopeChange && (
        <div className="team-explorer-scope" role="group" aria-label={t('teamExplorerScopeLabel')}>
          <button
            type="button"
            aria-pressed={scope === 'folder'}
            onClick={() => onScopeChange('folder')}
          >
            {t('teamExplorerScopeFolder')}
          </button>
          <button
            type="button"
            aria-pressed={scope === 'space'}
            onClick={() => onScopeChange('space')}
          >
            {t('teamExplorerScopeSpace')}
          </button>
        </div>
      )}
      <CatalogFilters
        filters={catalog.filters}
        vocabulary={catalog.vocabulary}
        hasContent={(catalog.result?.total ?? 0) > 0}
        onSet={catalog.setFacet}
        onRemove={catalog.removeFilter}
        onClear={catalog.clearFilters}
      />
      <MaterialResults
        result={catalog.result}
        loading={catalog.loading}
        error={catalog.error}
        canManageMetadata={can('manage_metadata')}
        permissions={permissions!}
        storageKind={storageKind}
        onEditMetadata={material => setOverlay({ kind: 'metadata', material })}
        onPreview={material => setOverlay({ kind: 'preview', material })}
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
          agentCompatible={agent?.teamWorkspaceAvailable === true}
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

function ActiveOperation({
  teamId,
  operationId,
  workflow,
  agentEnabled,
  localFailureCode = null,
  onClose,
  onRetry
}: {
  teamId: string;
  operationId: string;
  workflow: TeamWorkflowFlow;
  agentEnabled: boolean;
  localFailureCode?: string | null;
  onClose: () => void;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const state = useTeamOperation({ teamId, operationId, agentEnabled });
  useEffect(() => {
    const operation = state.operation;
    if (!operation || !['succeeded', 'failed', 'canceled'].includes(operation.state)) return;
    completeTeamWorkflow(workflow, {
      outcome:
        operation.state === 'succeeded'
          ? 'success'
          : operation.state === 'canceled'
            ? 'cancelled'
            : 'failure',
      retryable: operation.retryable,
      stage: operationStage(operation.stage)
    });
  }, [state.operation, workflow]);
  if (!state.operation) return <p aria-live="polite">{t('teamOperationLoading')}</p>;
  return (
    <div className="team-operation-overlay">
      <OperationStatus
        operation={state.operation}
        localProgress={state.localProgress}
        localFailureCode={localFailureCode}
        onCancel={state.cancel}
        onRetry={onRetry}
      />
      {(localFailureCode !== null || !['pending', 'running'].includes(state.operation.state)) && (
        <Button type="button" variant="ghost" onClick={onClose}>
          {t('teamOperationClose')}
        </Button>
      )}
    </div>
  );
}

function operationStage(stage: string | null): TeamAnalyticsStage {
  return ['finding', 'previewing', 'downloading', 'processing', 'uploading', 'finalizing'].includes(
    stage ?? ''
  )
    ? (stage as TeamAnalyticsStage)
    : 'processing';
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
      {error && <p className="team-inline-error">{error}</p>}
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
