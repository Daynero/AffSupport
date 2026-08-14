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

  const toggle = (material: CatalogMaterialItem, checked: boolean) => {
    setSelected(current => {
      const next = new Set(current);
      if (checked) next.add(material.id);
      else next.delete(material.id);
      return next;
    });
  };

  return (
    <section className="team-task-attachment-picker" aria-labelledby="team-task-attach-title">
      <h3 id="team-task-attach-title">{t('teamTaskAttachMedia')}</h3>
      <div
        className={`team-task-dropzone ${dragging ? 'is-dragging' : ''}`.trim()}
        onDragEnter={event => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={event => event.preventDefault()}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={dropped}
      >
        {t('teamTaskDropMedia')}
      </div>
      <CatalogSearchBar value={catalog.query} onChange={catalog.setQuery} />
      {catalog.loading && <p aria-live="polite">{t('teamTaskSearching')}</p>}
      {catalog.error && <p className="team-inline-error">{t('teamTaskSearchFailed')}</p>}
      <ul className="team-task-picker-results">
        {(catalog.result?.items ?? []).map(material => (
          <li key={material.id}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(material.id)}
                onChange={event => toggle(material, event.target.checked)}
              />
              <span>{material.name}</span>
              <small>{material.category ?? material.kind}</small>
            </label>
          </li>
        ))}
      </ul>
      {message && <p aria-live="polite">{message}</p>}
      <Button
        type="button"
        variant="primary"
        loading={attaching}
        disabled={selected.size === 0}
        onClick={() => void attach([...selected])}
      >
        {t('teamTaskAttachSelected', { count: selected.size })}
      </Button>
    </section>
  );
}
