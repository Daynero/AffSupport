import { useEffect, useState, type DragEvent } from 'react';
import type { MaterialCategory } from '@video-compressor/shared';
import {
  teamApi,
  type TeamMaterialSummary,
  type TeamTaskAttachmentMutationResult
} from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import {
  decodeTaskMaterialDragItems,
  TASK_MATERIAL_DRAG_TYPE,
  type TaskMaterialDragItem
} from './task-drag';
export {
  decodeTaskMaterialDrag,
  decodeTaskMaterialDragItems,
  TASK_MATERIAL_DRAG_TYPE
} from './task-drag';

export interface TaskAttachmentCandidate {
  id: string;
  name: string;
  category: MaterialCategory | null;
  previewState?: string;
}

export interface TaskAttachmentPickerClient {
  listMaterials: (teamId: string, parentFolderId: string | null) => Promise<TeamMaterialSummary[]>;
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

function FolderIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M2.8 5.5a1.7 1.7 0 0 1 1.7-1.7h3.15l1.55 1.7h6.3a1.7 1.7 0 0 1 1.7 1.7v7.3a1.7 1.7 0 0 1-1.7 1.7H4.5a1.7 1.7 0 0 1-1.7-1.7Z" />
      <path d="M2.8 7.3h14.4" />
    </svg>
  );
}

function MediaIcon({ category }: { category: MaterialCategory | null }) {
  if (category === 'video') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <rect x="2.5" y="4.3" width="11.1" height="11.4" rx="2" />
        <path d="m9 8 3.1 2-3.1 2Z" fill="currentColor" stroke="none" />
        <path d="m13.6 8.1 3.9-2v7.8l-3.9-2" />
      </svg>
    );
  }
  if (category === 'image') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
        <circle cx="7" cy="8" r="1.25" />
        <path d="m4.5 14 3.8-3.7 2.5 2.35 2.1-1.85 2.6 3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M5.4 2.8h6.1l3 3v11.4H5.4a1.6 1.6 0 0 1-1.6-1.6V4.4a1.6 1.6 0 0 1 1.6-1.6Z" />
      <path d="M11.5 2.8v3h3M6.8 10h6.4M6.8 13h4.5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M10 3.2v13.6M3.2 10h13.6" />
    </svg>
  );
}

function ArrowLeftIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="m11.8 4.4-5.6 5.6 5.6 5.6M6.6 10h8.2" />
    </svg>
  );
}

function toCandidate(material: TeamMaterialSummary): TaskAttachmentCandidate {
  return {
    id: material.id,
    name: material.name,
    category: material.category,
    previewState: material.previewState
  };
}

function toDragCandidate(item: TaskMaterialDragItem): TaskAttachmentCandidate {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    previewState: item.previewState
  };
}

export function TaskAttachmentPicker({
  teamId,
  client = defaultClient,
  attachedMaterialIds,
  onAdd
}: {
  teamId: string;
  client?: TaskAttachmentPickerClient;
  attachedMaterialIds: ReadonlySet<string>;
  onAdd: (materials: TaskAttachmentCandidate[]) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState<{ id: string; name: string }[]>([]);
  const [materials, setMaterials] = useState<TeamMaterialSummary[]>([]);
  const [selected, setSelected] = useState<Map<string, TaskAttachmentCandidate>>(new Map());
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState(false);
  const parentId = path.at(-1)?.id ?? null;
  const pickerTitleId = 'team-task-attachment-picker-title';

  useEffect(() => {
    setPath([]);
    setSelected(new Map());
    setMaterials([]);
  }, [teamId]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(false);
    void client
      .listMaterials(teamId, parentId)
      .then(value => {
        if (!active) return;
        setMaterials(value.filter(material => material.teamId === teamId));
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, open, parentId, teamId]);

  const stage = (candidates: readonly TaskAttachmentCandidate[]) => {
    const unique = new Map<string, TaskAttachmentCandidate>();
    for (const candidate of candidates) {
      if (!attachedMaterialIds.has(candidate.id)) unique.set(candidate.id, candidate);
    }
    if (unique.size > 0) onAdd([...unique.values()]);
  };

  const dropped = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragging(false);
    stage(
      decodeTaskMaterialDragItems(event.dataTransfer.getData(TASK_MATERIAL_DRAG_TYPE)).map(
        toDragCandidate
      )
    );
  };

  const toggle = (material: TeamMaterialSummary) => {
    if (material.kind === 'folder' || attachedMaterialIds.has(material.id)) return;
    const candidate = toCandidate(material);
    setSelected(current => {
      const next = new Map(current);
      if (next.has(candidate.id)) next.delete(candidate.id);
      else next.set(candidate.id, candidate);
      return next;
    });
  };

  const close = () => {
    setOpen(false);
    setSelected(new Map());
  };

  return (
    <>
      <button
        type="button"
        className={`team-task-attachment-add ${dragging ? 'is-dragging' : ''}`.trim()}
        onClick={() => setOpen(true)}
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
        <span className="team-task-attachment-add-icon">
          <PlusIcon />
        </span>
        <strong>{t('teamTaskAttachMedia')}</strong>
        <small>{t('teamTaskAttachmentAddHint')}</small>
      </button>
      {open && (
        <Modal
          nested
          labelledBy={pickerTitleId}
          onClose={close}
          closeLabel={t('teamCancel')}
          initialFocus="#team-task-picker-root"
          size="lg"
        >
          <div className="team-task-picker-dialog">
            <div className="team-task-picker-dialog-heading">
              <div>
                <p className="team-workspace-eyebrow">{t('teamTaskAttachments')}</p>
                <h2 id={pickerTitleId}>{t('teamTaskAttachmentPickerTitle')}</h2>
              </div>
              <small>{t('teamTaskAttachmentAddDraftHint')}</small>
            </div>
            <div className="team-task-picker-path" aria-label={t('teamTaskAttachmentPickerTitle')}>
              {/* "Root" used to appear twice: once as a standalone action and
                  again as the first crumb. The standalone one was also the
                  dialog's initial-focus target while being disabled at the
                  root, so opening the picker focused nothing. One root, in the
                  trail, where a path reads. */}
              {path.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  className="team-task-picker-path-action"
                  onClick={() => setPath(current => current.slice(0, -1))}
                >
                  <ArrowLeftIcon />
                  {t('teamTaskFolderBack')}
                </Button>
              )}
              <nav aria-label={t('teamTaskAttachmentPickerTitle')}>
                <button id="team-task-picker-root" type="button" onClick={() => setPath([])}>
                  {t('teamTaskFolderRoot')}
                </button>
                {path.map((folder, index) => (
                  <span key={folder.id}>
                    <i aria-hidden="true">/</i>
                    <button
                      type="button"
                      onClick={() => setPath(current => current.slice(0, index + 1))}
                    >
                      {folder.name}
                    </button>
                  </span>
                ))}
              </nav>
            </div>
            {loading && <p aria-live="polite">{t('teamTaskLoadingPickable')}</p>}
            {error && <p className="team-inline-error">{t('teamTaskSearchFailed')}</p>}
            {!loading && !error && materials.length === 0 && (
              <p className="team-task-picker-empty">{t('teamTaskFolderEmpty')}</p>
            )}
            {!loading && !error && materials.length > 0 && (
              <ul className="team-task-picker-results team-task-picker-folder-results">
                {materials.map(material => {
                  const isFolder = material.kind === 'folder';
                  const isAttached = attachedMaterialIds.has(material.id);
                  const selectedMaterial = selected.has(material.id);
                  return (
                    <li key={material.id}>
                      <button
                        type="button"
                        className={`${selectedMaterial ? 'is-selected' : ''} ${
                          isAttached ? 'is-attached' : ''
                        }`.trim()}
                        aria-pressed={isFolder ? undefined : selectedMaterial}
                        disabled={isAttached}
                        onClick={() => {
                          if (isFolder) {
                            setPath(current => [
                              ...current,
                              { id: material.providerId ?? material.id, name: material.name }
                            ]);
                          } else {
                            toggle(material);
                          }
                        }}
                      >
                        <span className="team-task-picker-item-type" aria-hidden="true">
                          {isFolder ? <FolderIcon /> : <MediaIcon category={material.category} />}
                        </span>
                        <span className="team-task-picker-item-copy">
                          <strong>{material.name}</strong>
                          <small>
                            {isAttached
                              ? t('teamTaskAttachmentAlreadyAdded')
                              : isFolder
                                ? t('teamTaskFolderOpen')
                                : (material.category ?? material.kind)}
                          </small>
                        </span>
                        <span className="team-task-picker-check" aria-hidden="true">
                          {isFolder ? '›' : selectedMaterial ? '✓' : ''}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="team-dialog-actions team-task-picker-dialog-actions">
              <Button type="button" variant="ghost" onClick={close}>
                {t('teamCancel')}
              </Button>
              <Button
                type="button"
                variant="primary"
                disabled={selected.size === 0}
                onClick={() => {
                  stage([...selected.values()]);
                  close();
                }}
              >
                <PlusIcon />
                {t('teamTaskAddSelected', { count: selected.size })}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
