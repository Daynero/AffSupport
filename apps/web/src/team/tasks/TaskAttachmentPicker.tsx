import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, FileText, FileVideo, Folder, Image, Plus, Search, X } from 'lucide-react';
import type { CatalogMaterialItem, MaterialCategory } from '@video-compressor/shared';
import { CATEGORY_LABEL } from '../explorer/rowKinds';
import {
  teamApi,
  type TeamMaterialSummary,
  type TeamTaskAttachmentMutationResult
} from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/index';
import { useI18n } from '../../i18n';

export interface TaskAttachmentCandidate {
  id: string;
  name: string;
  category: MaterialCategory | null;
  previewState?: string;
}

export interface TaskAttachmentPickerClient {
  listMaterials: (teamId: string, parentFolderId: string | null) => Promise<TeamMaterialSummary[]>;
  /**
   * Looks through the whole space rather than the open folder. Optional: a
   * caller without it gets folder browsing alone, and the field is not shown.
   */
  searchCatalog?: (
    teamId: string,
    request: { query: string; page: number; pageSize: number }
  ) => Promise<{ items: CatalogMaterialItem[]; total: number }>;
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

/** The same icon set the rest of the space draws with, at the same weight. */
function MediaIcon({ category }: { category: MaterialCategory | null }) {
  if (category === 'video') return <FileVideo size={18} strokeWidth={ICON_STROKE} />;
  if (category === 'image') return <Image size={18} strokeWidth={ICON_STROKE} />;
  return <FileText size={18} strokeWidth={ICON_STROKE} />;
}

function toCandidate(material: TeamMaterialSummary): TaskAttachmentCandidate {
  return {
    id: material.id,
    name: material.name,
    category: material.category,
    previewState: material.previewState
  };
}

export function TaskAttachmentPicker({
  teamId,
  client = defaultClient,
  attachedMaterialIds,
  onAdd,
  startTrail,
  pathOf
}: {
  teamId: string;
  client?: TaskAttachmentPickerClient;
  attachedMaterialIds: ReadonlySet<string>;
  onAdd: (materials: TaskAttachmentCandidate[]) => void;
  /** The folder to open in — the one the task's files are already in (024). */
  startTrail?: { id: string; name: string }[];
  /** A found file's folder path, so same-named results say where each lives. */
  pathOf?: (parentFolderId: string | null | undefined) => string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState<{ id: string; name: string }[]>([]);
  const [materials, setMaterials] = useState<TeamMaterialSummary[]>([]);
  const [selected, setSelected] = useState<Map<string, TaskAttachmentCandidate>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  /**
   * Looking for one file by name, instead of opening folders until it turns up.
   * A space's media sits several folders deep and the picker opened at the
   * root, so attaching one known file was four presses of guesswork.
   */
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<TeamMaterialSummary[] | null>(null);
  const [searching, setSearching] = useState(false);
  const term = search.normalize('NFC').trim();
  const searchable = typeof client.searchCatalog === 'function';
  const parentId = path.at(-1)?.id ?? null;
  const pickerTitleId = 'team-task-attachment-picker-title';
  /** What the list shows: search answers while a term is typed, the folder otherwise. */
  const shown = useMemo(() => (found ? found : materials), [found, materials]);

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

  // Typing settles before the space is asked: one request per pause, not per
  // keystroke. Under two characters there is nothing worth searching for.
  useEffect(() => {
    const searchCatalog = client.searchCatalog;
    if (!open || !searchCatalog) return;
    if (term.length < 2) {
      setFound(null);
      setSearching(false);
      return;
    }
    let active = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchCatalog(teamId, { query: term, page: 1, pageSize: 50 })
        .then(response => {
          if (!active) return;
          setFound(
            response.items.map(item => ({
              ...(item as unknown as TeamMaterialSummary),
              teamId
            }))
          );
          setError(false);
        })
        .catch(() => {
          if (active) setError(true);
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [client, open, teamId, term]);

  const stage = (candidates: readonly TaskAttachmentCandidate[]) => {
    const unique = new Map<string, TaskAttachmentCandidate>();
    for (const candidate of candidates) {
      if (!attachedMaterialIds.has(candidate.id)) unique.set(candidate.id, candidate);
    }
    if (unique.size > 0) onAdd([...unique.values()]);
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
    setSearch('');
    setFound(null);
  };

  return (
    <>
      <button
        type="button"
        // No drop handling: the only thing that ever produced this payload was
        // the browser's dead drag plumbing, so advertising a drop target here
        // promised something nothing could deliver.
        className="team-task-attachment-add"
        onClick={() => {
          // Where this task's files already are, not the root four folders up (024).
          if (startTrail && startTrail.length > 0) setPath(startTrail);
          setOpen(true);
        }}
      >
        <span className="team-task-attachment-add-icon">
          <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
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
              <h2 id={pickerTitleId}>{t('teamTaskAttachmentPickerTitle')}</h2>
            </div>
            {searchable && (
              <div className="team-task-picker-search">
                <Search size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
                <input
                  type="search"
                  value={search}
                  aria-label={t('teamTaskAttachmentSearch')}
                  placeholder={t('teamTaskAttachmentSearch')}
                  onChange={event => setSearch(event.target.value)}
                />
                {term.length > 0 && (
                  <button
                    type="button"
                    className="team-task-picker-search-clear"
                    aria-label={t('teamCancel')}
                    onClick={() => setSearch('')}
                  >
                    <X size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  </button>
                )}
              </div>
            )}
            {/* The trail is about the open folder, and a search is not in one. */}
            {found === null && (
              <div
                className="team-task-picker-path"
                aria-label={t('teamTaskAttachmentPickerTitle')}
              >
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
                    <ChevronLeft size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
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
            )}
            {(loading || searching) && (
              <LoadingState shape="row" count={5} label={t('teamTaskLoadingPickable')} />
            )}
            {error && <ErrorState message={t('teamTaskSearchFailed')} />}
            {!loading && !searching && !error && shown.length === 0 && (
              <EmptyState
                size="sm"
                title={found === null ? t('teamTaskFolderEmpty') : t('teamTaskSearchEmpty')}
              />
            )}
            {!loading && !searching && !error && shown.length > 0 && (
              <ul className="team-task-picker-results team-task-picker-folder-results">
                {shown.map(material => {
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
                          {isFolder ? (
                            <Folder size={18} strokeWidth={ICON_STROKE} />
                          ) : (
                            <MediaIcon category={material.category} />
                          )}
                        </span>
                        <span className="team-task-picker-item-copy">
                          <strong>{material.name}</strong>
                          <small>
                            {isAttached
                              ? t('teamTaskAttachmentAlreadyAdded')
                              : isFolder
                                ? t('teamTaskFolderOpen')
                                : found && pathOf
                                  ? `${pathOf(material.parentFolderId)} · ${t(CATEGORY_LABEL[material.category ?? 'other'])}`
                                  : t(CATEGORY_LABEL[material.category ?? 'other'])}
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
                <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                {t('teamTaskAddSelected', { count: selected.size })}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
