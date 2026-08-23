import { useMemo, useState, type FormEvent } from 'react';
import {
  LANGUAGE_CODES,
  type LibraryAssetSummary,
  type LibraryPlacement,
  type LibraryPlacementMutationRequest,
  type LibraryStage
} from '@video-compressor/shared';
import { useOptionalAgent } from '../../AgentContext';
import { teamApi, type LibraryPlacementMutationResult } from '../../api/team';
import { Button } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useI18n } from '../../i18n';
import { useToasts } from '../../components/toast';
import { teamErrorMessageFor } from '../errors';
import { useTeam } from '../TeamContext';
import { BulkUploadDialog, type CreativeLibraryUploadClient } from './BulkUploadDialog';
import { LibraryAssetCard } from './LibraryAssetCard';
import { ProcessLibraryDialog } from './ProcessLibraryDialog';
import { useCreativeLibrary, type CreativeLibraryListClient } from './useCreativeLibrary';
import { MaterialPreview } from '../preview/MaterialPreview';

export type CreativeLibraryClient = CreativeLibraryListClient &
  CreativeLibraryUploadClient & {
    moveLibraryMaterials(
      input: LibraryPlacementMutationRequest
    ): Promise<LibraryPlacementMutationResult>;
  };

function optimisticAsset(input: {
  teamId: string;
  materialId: string;
  file: File;
  stage: LibraryStage;
  offer: string;
  language: string;
}): LibraryAssetSummary {
  const extension = input.file.name.includes('.')
    ? (input.file.name.split('.').at(-1)?.toLocaleLowerCase('en-US') ?? null)
    : null;
  const category = input.file.type.startsWith('video/')
    ? 'video'
    : input.file.type.startsWith('image/')
      ? 'image'
      : input.file.type.includes('html') || extension === 'zip'
        ? 'landing'
        : 'other';
  return {
    id: input.materialId,
    teamId: input.teamId,
    name: input.file.name,
    category,
    mimeType: input.file.type || 'application/octet-stream',
    fileExtension: extension,
    sizeBytes: input.file.size,
    lifecycle: 'active',
    sourceVersion: null,
    stage: input.stage,
    offer: input.offer,
    language: input.language,
    type: category[0].toUpperCase() + category.slice(1),
    placementState: 'ready',
    languageDecisionSource: input.language === 'unknown' ? 'unknown' : 'manual',
    thumbnailState: category === 'video' || category === 'image' ? 'pending' : 'unknown',
    thumbnailTimeMs: category === 'video' ? 1_000 : null,
    createdAt: new Date().toISOString()
  };
}

export function CreativeLibrary({
  teamId,
  initialStage = 'library',
  client,
  onCreateTask,
  onCreateTaskFromSelection
}: {
  teamId: string;
  initialStage?: LibraryStage;
  client?: CreativeLibraryClient;
  onCreateTask?: (asset: LibraryAssetSummary) => void;
  onCreateTaskFromSelection?: (assets: LibraryAssetSummary[]) => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { can, revision } = useTeam();
  const agent = useOptionalAgent();
  const [stage, setStage] = useState<LibraryStage>(initialStage);
  const [uploading, setUploading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState(false);
  const [placementError, setPlacementError] = useState(false);
  const [processingSource, setProcessingSource] = useState<string | null | undefined>(undefined);
  const [previewing, setPreviewing] = useState<LibraryAssetSummary | null>(null);
  const [placementDraft, setPlacementDraft] = useState<{
    asset: LibraryAssetSummary;
    offer: string;
    language: string;
    type: string;
  } | null>(null);
  const resolvedClient = client ?? teamApi;
  const library = useCreativeLibrary({ teamId, stage, revision, client: resolvedClient });

  const selectedCount = useMemo(
    () => library.items.reduce((count, asset) => count + Number(selected.has(asset.id)), 0),
    [library.items, selected]
  );
  const selectedAssets = useMemo(
    () => library.items.filter(asset => selected.has(asset.id)),
    [library.items, selected]
  );
  const allSelected = library.items.length > 0 && selectedCount === library.items.length;

  const changeStage = (next: LibraryStage) => {
    setStage(next);
    setSelected(new Set());
  };

  const selectAll = () => setSelected(new Set(library.items.map(asset => asset.id)));

  const moveSelected = async () => {
    const materialIds = library.items
      .filter(asset => selected.has(asset.id))
      .map(asset => asset.id);
    if (materialIds.length === 0) return;
    setMoving(true);
    setPlacementError(false);
    try {
      const result = await resolvedClient.moveLibraryMaterials({
        teamId,
        materialIds,
        targetStage: stage === 'finds' ? 'library' : 'finds',
        idempotencyKey: crypto.randomUUID()
      });
      library.remove(result.succeeded.map(item => item.materialId));
      setSelected(new Set(result.failed.map(item => item.materialId)));
      setPlacementError(result.failed.length > 0);
      if (result.failed.length === 0) {
        push({ tone: 'success', text: t('teamToastMoved') });
      } else {
        // A partial failure must not read as success, and "some failed" is not
        // actionable without saying which ones (finding S3).
        const names = result.failed
          .map(
            item =>
              library.items.find(asset => asset.id === item.materialId)?.name ?? item.materialId
          )
          .join(', ');
        push({ tone: 'error', text: t('teamToastBulkMovePartial', { names }) });
      }
    } catch (cause) {
      setPlacementError(true);
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setMoving(false);
    }
  };

  const savePlacement = async (event: FormEvent) => {
    event.preventDefault();
    if (!placementDraft) return;
    const placement: LibraryPlacement = {
      stage: placementDraft.asset.stage,
      offer: placementDraft.offer.trim(),
      language: placementDraft.language,
      type: placementDraft.type.trim()
    };
    setMoving(true);
    setPlacementError(false);
    try {
      const result = await resolvedClient.moveLibraryMaterials({
        teamId,
        materialIds: [placementDraft.asset.id],
        targetStage: placement.stage,
        placement,
        idempotencyKey: crypto.randomUUID()
      });
      if (result.failed.length > 0) {
        setPlacementError(true);
        push({
          tone: 'error',
          text: t('teamToastBulkMovePartial', { names: placementDraft.asset.name })
        });
      } else {
        setPlacementDraft(null);
        await library.refetch();
        push({ tone: 'success', text: t('teamToastMoved') });
      }
    } catch (cause) {
      setPlacementError(true);
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setMoving(false);
    }
  };

  return (
    <section className="team-panel creative-library" aria-labelledby="creative-library-title">
      <div className="creative-library-toolbar">
        <div className="team-panel-heading creative-library-heading">
          <div>
            <p className="team-workspace-eyebrow">{t('creativeLibraryEyebrow')}</p>
            <h2 id="creative-library-title">
              {stage === 'library' ? t('creativeLibraryTitle') : t('creativeLibraryFinds')}
            </h2>
            <p className="creative-library-heading-hint">
              {stage === 'library'
                ? t('creativeLibraryLibraryHint')
                : t('creativeLibraryFindsHint')}
            </p>
          </div>
          <div className="creative-library-heading-actions">
            <Button
              type="button"
              variant={stage === 'finds' ? 'primary' : 'secondary'}
              aria-pressed={stage === 'finds'}
              onClick={() => changeStage('finds')}
            >
              {t('creativeLibraryFinds')}
            </Button>
            <Button
              type="button"
              variant={stage === 'library' ? 'primary' : 'secondary'}
              aria-pressed={stage === 'library'}
              onClick={() => changeStage('library')}
            >
              {t('creativeLibraryTitle')}
            </Button>
            {can('upload') && (
              <Button type="button" variant="primary" onClick={() => setUploading(true)}>
                {t('creativeLibraryBulkAction')}
              </Button>
            )}
            {can('process') && (
              <Button type="button" variant="secondary" onClick={() => setProcessingSource(null)}>
                {t('creativeLibraryProcessAction')}
              </Button>
            )}
          </div>
        </div>

        {can('edit') && library.items.length > 0 && (
          <div className="creative-library-selection" aria-live="polite">
            <div className="creative-library-selection-lead">
              <Button type="button" variant="secondary" disabled={allSelected} onClick={selectAll}>
                {t('creativeLibrarySelectAll')}
              </Button>
              {selectedCount > 0 && (
                <span className="creative-library-selection-count">
                  {t('creativeLibrarySelected', { count: selectedCount })}
                </span>
              )}
            </div>
            {selectedCount > 0 && (
              <div>
                {onCreateTaskFromSelection && (
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => onCreateTaskFromSelection(selectedAssets)}
                  >
                    {t('creativeLibraryCreateTaskFromSelected', { count: selectedCount })}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  loading={moving}
                  onClick={() => void moveSelected()}
                >
                  {stage === 'finds'
                    ? t('creativeLibraryMoveToLibrary')
                    : t('creativeLibraryMoveToFinds')}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setSelected(new Set())}>
                  {t('creativeLibraryClearSelection')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
      {placementError && (
        <p className="team-inline-error">{t('creativeLibraryPlacementPartial')}</p>
      )}

      {library.loading && library.items.length === 0 && (
        <p aria-live="polite">{t('creativeLibraryLoading')}</p>
      )}
      {library.error && (
        <div className="team-inline-error">
          <p>{t('creativeLibraryLoadFailed')}</p>
          <Button type="button" variant="ghost" onClick={() => void library.refetch()}>
            {t('creativeLibraryRetry')}
          </Button>
        </div>
      )}
      {!library.loading && !library.error && library.items.length === 0 && (
        <div className="creative-library-empty">
          <p>
            {stage === 'library'
              ? t('creativeLibraryEmptyLibrary')
              : t('creativeLibraryEmptyFinds')}
          </p>
          {can('upload') && (
            <Button type="button" variant="primary" onClick={() => setUploading(true)}>
              {t('creativeLibraryBulkAction')}
            </Button>
          )}
        </div>
      )}

      <div className="creative-library-grid">
        {library.items.map(asset => (
          <LibraryAssetCard
            key={asset.id}
            asset={asset}
            selectable={can('edit')}
            selected={selected.has(asset.id)}
            onSelect={checked =>
              setSelected(current => {
                const next = new Set(current);
                if (checked) next.add(asset.id);
                else next.delete(asset.id);
                return next;
              })
            }
            onPreview={setPreviewing}
            onCreateTask={onCreateTask}
            onEditPlacement={
              can('manage_metadata')
                ? asset =>
                    setPlacementDraft({
                      asset,
                      offer: asset.offer,
                      language: asset.language,
                      type: asset.type
                    })
                : undefined
            }
            onTranscribe={asset => setProcessingSource(asset.id)}
          />
        ))}
      </div>

      {library.hasMore && (
        <Button
          type="button"
          variant="secondary"
          loading={library.loadingMore}
          onClick={() => void library.loadMore()}
        >
          {t('creativeLibraryLoadMore')}
        </Button>
      )}

      {uploading && (
        <BulkUploadDialog
          teamId={teamId}
          initialStage={stage}
          client={resolvedClient}
          onClose={() => setUploading(false)}
          onItemReady={input => library.insertOptimistic(optimisticAsset({ teamId, ...input }))}
          onFinished={() => void library.refetch()}
        />
      )}
      {processingSource !== undefined && (
        <ProcessLibraryDialog
          sourceMaterialId={processingSource ?? undefined}
          agentCompatible={agent?.teamWorkspaceAvailable === true}
          onClose={() => setProcessingSource(undefined)}
        />
      )}
      {previewing && (
        <MaterialPreview
          teamId={teamId}
          material={previewing}
          onClose={() => setPreviewing(null)}
        />
      )}
      {placementDraft && (
        <Modal
          labelledBy="creative-library-placement-title"
          onClose={() => setPlacementDraft(null)}
          closeLabel={t('teamCancel')}
          initialFocus="#creative-library-placement-offer"
          size="md"
        >
          <form className="team-dialog-form" onSubmit={event => void savePlacement(event)}>
            <h2 id="creative-library-placement-title">{t('creativeLibraryEditPlacement')}</h2>
            <label>
              <span>{t('creativeLibraryOffer')}</span>
              <input
                id="creative-library-placement-offer"
                value={placementDraft.offer}
                maxLength={120}
                required
                onChange={event =>
                  setPlacementDraft(current =>
                    current ? { ...current, offer: event.target.value } : current
                  )
                }
              />
            </label>
            <label>
              <span>{t('creativeLibraryLanguage')}</span>
              <select
                value={placementDraft.language}
                onChange={event =>
                  setPlacementDraft(current =>
                    current ? { ...current, language: event.target.value } : current
                  )
                }
              >
                <option value="unknown">Unknown</option>
                {LANGUAGE_CODES.map(code => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t('creativeLibraryType')}</span>
              <input
                value={placementDraft.type}
                maxLength={64}
                required
                onChange={event =>
                  setPlacementDraft(current =>
                    current ? { ...current, type: event.target.value } : current
                  )
                }
              />
            </label>
            <p>{t('creativeLibraryPlacementMovesSidecars')}</p>
            <div className="team-dialog-actions">
              <Button type="button" variant="ghost" onClick={() => setPlacementDraft(null)}>
                {t('teamCancel')}
              </Button>
              <Button type="submit" variant="primary" loading={moving}>
                {t('teamTaskSave')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
