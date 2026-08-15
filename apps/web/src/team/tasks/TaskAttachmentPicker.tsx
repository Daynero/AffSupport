import { useState, type DragEvent } from 'react';
import type {
  CatalogMaterialItem,
  CatalogSearchRequestInput,
  CatalogSearchResponse,
  CatalogVocabulary
} from '@video-compressor/shared';
import { teamApi, type TeamTaskAttachmentMutationResult } from '../../api/team';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { CatalogSearchBar } from '../catalog/CatalogSearchBar';
import { useCatalogSearch } from '../catalog/useCatalogSearch';
import { decodeTaskMaterialDrag, TASK_MATERIAL_DRAG_TYPE } from './task-drag';
export { decodeTaskMaterialDrag, TASK_MATERIAL_DRAG_TYPE } from './task-drag';

export interface TaskAttachmentPickerClient {
  searchCatalog(teamId: string, request: CatalogSearchRequestInput): Promise<CatalogSearchResponse>;
  getCatalogVocabulary(teamId: string): Promise<CatalogVocabulary>;
  attachTaskMaterials(input: {
    teamId: string;
    taskId: string;
    materialIds: string[];
  }): Promise<TeamTaskAttachmentMutationResult>;
}

const defaultClient: TaskAttachmentPickerClient = teamApi;

export async function attachTaskMaterialsInChunks(input: {
  client: Pick<TaskAttachmentPickerClient, 'attachTaskMaterials'>;
  teamId: string;
  taskId: string;
  materialIds: readonly string[];
}): Promise<TeamTaskAttachmentMutationResult> {
  const unique = [...new Set(input.materialIds)];
  const result: TeamTaskAttachmentMutationResult = {
    attached: [],
    alreadyAttached: [],
    rejected: []
  };
  for (let offset = 0; offset < unique.length; offset += 100) {
    const chunk = unique.slice(offset, offset + 100);
    if (chunk.length === 0) continue;
    const next = await input.client.attachTaskMaterials({
      teamId: input.teamId,
      taskId: input.taskId,
      materialIds: chunk
    });
    result.attached.push(...next.attached);
    result.alreadyAttached.push(...next.alreadyAttached);
    result.rejected.push(...next.rejected);
  }
  return result;
}

export function TaskAttachmentPicker({
  teamId,
  taskId,
  client = defaultClient,
  onAttached
}: {
  teamId: string;
  taskId: string;
  client?: TaskAttachmentPickerClient;
  onAttached: () => void;
}) {
  const { t } = useI18n();
  const catalog = useCatalogSearch({ teamId, client, debounceMs: 120 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [attaching, setAttaching] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const attach = async (materialIds: readonly string[]) => {
    if (materialIds.length === 0) return;
    setAttaching(true);
    setMessage(null);
    try {
      const result = await attachTaskMaterialsInChunks({ client, teamId, taskId, materialIds });
      setSelected(new Set());
      setMessage(
        result.rejected.length > 0
          ? t('teamTaskAttachPartial', {
              attached: result.attached.length + result.alreadyAttached.length,
              rejected: result.rejected.length
            })
          : t('teamTaskAttachComplete', {
              count: result.attached.length + result.alreadyAttached.length
            })
      );
      onAttached();
    } catch {
      setMessage(t('teamTaskAttachFailed'));
    } finally {
      setAttaching(false);
    }
  };

  const dropped = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const ids = decodeTaskMaterialDrag(event.dataTransfer.getData(TASK_MATERIAL_DRAG_TYPE));
    if (ids.length > 0) void attach(ids);
  };

  const toggle = (material: CatalogMaterialItem) => {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(material.id)) next.delete(material.id);
      else next.add(material.id);
      return next;
    });
  };

  return (
    <section className="team-task-attachment-picker" aria-labelledby="team-task-attach-title">
      <div className="team-task-picker-heading">
        <div>
          <h3 id="team-task-attach-title">{t('teamTaskAttachMedia')}</h3>
          <p>{t('teamTaskAttachMediaHint')}</p>
        </div>
        <Button type="button" variant="secondary" onClick={() => setExpanded(current => !current)}>
          {expanded ? t('teamTaskAttachClose') : t('teamTaskAttachBrowse')}
        </Button>
      </div>
      {expanded && (
        <div className="team-task-picker-content">
          <div
            className={`team-task-dropzone ${dragging ? 'is-dragging' : ''}`.trim()}
            onDragEnter={event => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragOver={event => event.preventDefault()}
            onDragLeave={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                setDragging(false);
            }}
            onDrop={dropped}
          >
            <span aria-hidden="true">＋</span>
            <strong>{t('teamTaskDropMediaTitle')}</strong>
            <small>{t('teamTaskDropMedia')}</small>
          </div>
          <CatalogSearchBar value={catalog.query} onChange={catalog.setQuery} />
          {catalog.loading && <p aria-live="polite">{t('teamTaskSearching')}</p>}
          {catalog.error && <p className="team-inline-error">{t('teamTaskSearchFailed')}</p>}
          <ul className="team-task-picker-results">
            {(catalog.result?.items ?? []).map(material => {
              const selectedMaterial = selected.has(material.id);
              return (
                <li key={material.id}>
                  <button
                    type="button"
                    className={selectedMaterial ? 'is-selected' : ''}
                    aria-pressed={selectedMaterial}
                    onClick={() => toggle(material)}
                  >
                    <span className="team-task-picker-item-type" aria-hidden="true">
                      {material.category === 'video'
                        ? '▶'
                        : material.category === 'image'
                          ? '▧'
                          : '◇'}
                    </span>
                    <span className="team-task-picker-item-copy">
                      <strong>{material.name}</strong>
                      <small>{material.category ?? material.kind}</small>
                    </span>
                    <span className="team-task-picker-check" aria-hidden="true">
                      {selectedMaterial ? '✓' : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {message && (
            <p className="team-task-picker-message" aria-live="polite">
              {message}
            </p>
          )}
          <Button
            type="button"
            variant="primary"
            loading={attaching}
            disabled={selected.size === 0}
            onClick={() => void attach([...selected])}
          >
            {t('teamTaskAttachSelected', { count: selected.size })}
          </Button>
        </div>
      )}
    </section>
  );
}
