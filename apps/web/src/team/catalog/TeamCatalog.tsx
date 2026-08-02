import { useEffect, useState } from 'react';
import type {
  CatalogMaterialItem,
  CatalogSearchRequestInput,
  CatalogSearchResponse,
  CatalogVocabulary,
  MaterialMetadataPatch,
  TeamAnalyticsStage,
  TeamAnalyticsStorage,
  TeamMaterialProvenanceEntry,
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
import type { DriveConnectionStatus } from '../../api/team';
import { useTeam } from '../TeamContext';
import { CatalogFilters } from './CatalogFilters';
import { CatalogSearchBar } from './CatalogSearchBar';
import { MaterialMetadataEditor } from './MaterialMetadataEditor';
import { MaterialResults } from './MaterialResults';
import { useCatalogSearch } from './useCatalogSearch';
import { MaterialPreview } from '../preview/MaterialPreview';
import { TeamTextEditor } from './TeamTextEditor';
import { uploadTeamFile } from './MaterialActions';
import { ProcessMaterialDialog } from '../processing/ProcessMaterialDialog';
import { OperationStatus } from '../processing/OperationStatus';
import { useTeamOperation } from '../processing/useTeamOperation';
import { ProvenancePanel } from './ProvenancePanel';

export interface TeamCatalogClient {
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

export function TeamCatalog({ teamId, client }: { teamId: string; client: TeamCatalogClient }) {
  const { t } = useI18n();
  const { can, permissions } = useTeam();
  const agent = useOptionalAgent();
  const catalog = useCatalogSearch({ teamId, client });
  const [storageKind, setStorageKind] = useState<TeamAnalyticsStorage | null>(null);
  const [editing, setEditing] = useState<CatalogMaterialItem | null>(null);
  const [previewing, setPreviewing] = useState<CatalogMaterialItem | null>(null);
  const [textEditor, setTextEditor] = useState<{
    material: CatalogMaterialItem;
    text: string;
    sourceVersion: string;
  } | null>(null);
  const [processing, setProcessing] = useState<CatalogMaterialItem | null>(null);
  const [activeOperation, setActiveOperation] = useState<{
    id: string;
    source: CatalogMaterialItem;
    workflow: TeamWorkflowFlow;
  } | null>(null);
  const [provenance, setProvenance] = useState<{
    material: CatalogMaterialItem;
    entries: TeamMaterialProvenanceEntry[];
  } | null>(null);
  const [versionDraft, setVersionDraft] = useState<{
    material: CatalogMaterialItem;
    text: string;
  } | null>(null);

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
    setTextEditor({ material, text: preview.text, sourceVersion: preview.sourceVersion });
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
    setActiveOperation({ id: result.operationId, source, workflow });
    setProcessing(null);
    void startTeamAgentProcess({
      operationId: result.operationId,
      toolId: input.toolId,
      options: {},
      sourceGrant: result.sourceGrant,
      finalizeGrant: result.finalizeGrant
    }).catch(async () => {
      await teamApi.cancelOperation(teamId, result.operationId).catch(() => undefined);
    });
  };

  return (
    <section className="team-panel team-catalog" aria-labelledby="team-catalog-title">
      <div className="team-panel-heading">
        <h2 id="team-catalog-title">{t('teamCatalogTitle')}</h2>
        {catalog.loading && <small aria-live="polite">{t('teamCatalogRefreshing')}</small>}
      </div>
      <CatalogSearchBar value={catalog.query} onChange={catalog.setQuery} />
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
        onEditMetadata={setEditing}
        onPreview={setPreviewing}
        onEditText={material => void openTextEditor(material)}
        onProcess={setProcessing}
        onShowProvenance={material => {
          void teamApi
            .getMaterialProvenance(teamId, material.id)
            .then(entries => setProvenance({ material, entries }));
        }}
        onChanged={() => void catalog.refetch()}
      />
      {editing && (
        <MaterialMetadataEditor
          material={editing}
          vocabulary={catalog.vocabulary}
          onClose={() => setEditing(null)}
          onSave={async patch => {
            await client.updateMaterialMetadata(teamId, editing.id, patch);
            await catalog.refetch();
          }}
        />
      )}
      {previewing && (
        <MaterialPreview
          teamId={teamId}
          material={previewing}
          onClose={() => setPreviewing(null)}
        />
      )}
      {textEditor && (
        <TeamTextEditor
          material={textEditor.material}
          initialText={textEditor.text}
          expectedDriveVersion={textEditor.sourceVersion}
          onClose={() => setTextEditor(null)}
          onReload={() => {
            const material = textEditor.material;
            setTextEditor(null);
            return openTextEditor(material);
          }}
          onCreateVersion={text => {
            setVersionDraft({ material: textEditor.material, text });
            setTextEditor(null);
          }}
          onSave={async input => {
            await teamApi.editText({
              teamId,
              materialId: textEditor.material.id,
              ...input
            });
            await catalog.refetch();
          }}
        />
      )}
      {processing && (
        <ProcessMaterialDialog
          teamId={teamId}
          material={processing}
          destinationFolderId={null}
          agentCompatible={agent?.teamWorkspaceAvailable === true}
          toolContracts={agent?.toolContracts ?? {}}
          onClose={() => setProcessing(null)}
          onStarted={(result, input) => startLocalProcess(result, input, processing)}
        />
      )}
      {activeOperation && (
        <ActiveOperation
          teamId={teamId}
          operationId={activeOperation.id}
          workflow={activeOperation.workflow}
          agentEnabled={agent?.teamWorkspaceAvailable === true}
          onClose={() => setActiveOperation(null)}
          onRetry={() => {
            setProcessing(activeOperation.source);
            setActiveOperation(null);
          }}
        />
      )}
      {provenance && (
        <div className="team-operation-overlay">
          <Button type="button" variant="ghost" onClick={() => setProvenance(null)}>
            {t('teamFileCancel')}
          </Button>
          <ProvenancePanel
            materialId={provenance.material.id}
            entries={provenance.entries}
            inheritedMetadata={provenance.material}
            onNavigate={materialId => {
              const entry = provenance.entries.find(
                candidate =>
                  candidate.sourceMaterialId === materialId ||
                  candidate.derivativeMaterialId === materialId
              );
              const name =
                entry?.sourceMaterialId === materialId ? entry.sourceName : entry?.derivativeName;
              if (name) catalog.setQuery(name);
              setProvenance(null);
            }}
          />
        </div>
      )}
      {versionDraft && (
        <TextVersionDialog
          teamId={teamId}
          draft={versionDraft}
          onClose={() => setVersionDraft(null)}
          onSaved={async () => {
            setVersionDraft(null);
            await catalog.refetch();
          }}
        />
      )}
    </section>
  );
}

function ActiveOperation({
  teamId,
  operationId,
  workflow,
  agentEnabled,
  onClose,
  onRetry
}: {
  teamId: string;
  operationId: string;
  workflow: TeamWorkflowFlow;
  agentEnabled: boolean;
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
  if (!state.operation) return <p aria-live="polite">…</p>;
  return (
    <div className="team-operation-overlay">
      <OperationStatus
        operation={state.operation}
        localProgress={state.localProgress}
        onCancel={state.cancel}
        onRetry={onRetry}
      />
      {!['pending', 'running'].includes(state.operation.state) && (
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
  onClose,
  onSaved
}: {
  teamId: string;
  draft: { material: CatalogMaterialItem; text: string };
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [destination, setDestination] = useState('');
  const [name, setName] = useState(() => draft.material.name.replace(/\.txt$/iu, '-v2.txt'));
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await uploadTeamFile({
        teamId,
        destinationFolderId: destination,
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
      <label>
        {t('teamFileDestination')}
        <input value={destination} onChange={event => setDestination(event.target.value)} />
      </label>
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
        {t('teamFileCancel')}
      </Button>
    </section>
  );
}
