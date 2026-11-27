import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronLeft, FileText, FileVideo, Folder, Image, Plus } from 'lucide-react';
import type { CatalogMaterialItem, MaterialCategory } from '@video-compressor/shared';
import { CATEGORY_LABEL } from '../explorer/rowKinds';
import {
  teamApi,
  type TeamMaterialSummary,
  type TeamTaskAttachmentMutationResult
} from '../../api/team';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import {
  Button,
  PickerDialog,
  SegmentedControl,
  type PickerItem,
  type PickerView
} from '../../components/ui/index';
import { useThumbnailSession } from '../explorer/useThumbnailSession';
import { searchWithLayoutFallback } from '../../lib/layoutFallback';
import { useI18n } from '../../i18n';
import { useOptionalTeam } from '../TeamContext';

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
  pathOf,
  trailTo,
  accept,
  trigger,
  title,
  confirmLabel,
  single = false,
  unavailableWith,
  views = ['list', 'grid'],
  defaultView = 'list',
  viewKey = 'task-attachments',
  size = 'lg',
  kindFilter = false
}: {
  teamId: string;
  client?: TaskAttachmentPickerClient;
  attachedMaterialIds: ReadonlySet<string>;
  onAdd: (materials: TaskAttachmentCandidate[]) => void;
  /** The folder to open in — the one the task's files are already in (024). */
  startTrail?: { id: string; name: string }[];
  /** A found file's folder path, so same-named results say where each lives. */
  pathOf?: (parentFolderId: string | null | undefined) => string;
  /** The folders above a found folder, top down, so opening it from a search lands at its place. */
  trailTo?: (folderId: string | null | undefined) => { id: string; name: string }[];
  /** Only these files are offered (folders are always there to open). */
  accept?: (material: TeamMaterialSummary) => boolean;
  /** Draws the control that opens the picker, instead of the attachment tile. */
  trigger?: (open: () => void) => ReactNode;
  /** The dialog's title and its confirm button's words, when not attaching to a task. */
  title?: string;
  confirmLabel?: (count: number) => string;
  /** Reuse the same media browser for a single Creative selection. */
  single?: boolean;
  /**
   * Why a file cannot join what is already ticked, or null. Such a file is shown unavailable
   * with the reason, instead of being accepted and the whole choice refused at the end.
   */
  unavailableWith?: (
    material: TeamMaterialSummary,
    chosen: TaskAttachmentCandidate[]
  ) => string | null;
  /** 075: list and/or tiles; the person's choice is remembered under `viewKey`. */
  views?: readonly PickerView[];
  defaultView?: PickerView;
  viewKey?: string;
  size?: 'lg' | 'xl';
  /** «All / Videos / Pictures» beside the search. */
  kindFilter?: boolean;
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
  const [kind, setKind] = useState<'all' | 'video' | 'image'>('all');
  const thumbnails = useThumbnailSession({ teamId, client: teamApi, enabled: open });
  const term = search.normalize('NFC').trim();
  const searchable = typeof client.searchCatalog === 'function';
  const parentId = path.at(-1)?.id ?? null;
  /** What the list shows: search answers while a term is typed, the folder otherwise. */
  /*
   * A space whose storage needs its owner lists nothing to attach (the server reads only a
   * connected Drive), and the picker said «this folder is empty» (070 T069). It says what the
   * space header says instead.
   */
  const team = useOptionalTeam();
  const connectionState = team?.teams.find(space => space.id === teamId)?.connectionState;
  const storageGone =
    connectionState === 'needs_reauth'
      ? ({ title: 'teamStorageChipNeedsReauth', body: 'teamStorageBodyNeedsReauth' } as const)
      : connectionState === 'root_missing'
        ? ({ title: 'teamStorageChipRootMissing', body: 'teamStorageBodyRootMissing' } as const)
        : null;
  const shown = useMemo(
    () =>
      (found ? found : materials).filter(
        material =>
          material.kind === 'folder' ||
          ((!accept || accept(material)) && (kind === 'all' || material.category === kind))
      ),
    [accept, found, kind, materials]
  );

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
      void searchWithLayoutFallback(term, query =>
        searchCatalog(teamId, { query, page: 1, pageSize: 50 })
      )
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
      else {
        if (single) next.clear();
        next.set(candidate.id, candidate);
      }
      return next;
    });
  };

  const close = () => {
    setOpen(false);
    // The next opening starts where it should (the task's folder, or the root), not inside
    // whatever was walked into this time.
    setPath([]);
    setSelected(new Map());
    setSearch('');
    setFound(null);
    setKind('all');
  };

  const openFolder = (material: TeamMaterialSummary) => {
    const entry = { id: material.providerId ?? material.id, name: material.name };
    if (found) {
      /* A folder found by name opens at its own place and leaves the search (owner,
         25.11): the search kept answering over it, so each press stacked the same
         folder onto the trail again — «Туреччина / Туреччина / Туреччина…». */
      setPath([...(trailTo?.(material.parentFolderId) ?? []), entry]);
      setSearch('');
      setFound(null);
    } else {
      setPath(current => (current.at(-1)?.id === entry.id ? current : [...current, entry]));
    }
  };

  const byId = new Map(shown.map(material => [material.id, material]));
  const items: PickerItem[] = shown.map(material => {
    const isFolder = material.kind === 'folder';
    const isAttached = attachedMaterialIds.has(material.id);
    const unavailable =
      !isFolder && !selected.has(material.id) && unavailableWith
        ? unavailableWith(material, [...selected.values()])
        : null;
    const media = material.category === 'video' || material.category === 'image';
    return {
      id: material.id,
      title: material.name,
      branch: isFolder,
      disabled: !isFolder && (isAttached || unavailable !== null),
      icon: isFolder ? (
        <Folder size={18} strokeWidth={ICON_STROKE} />
      ) : (
        <MediaIcon category={material.category} />
      ),
      thumbnailUrl:
        !isFolder && media && thumbnails ? teamApi.thumbnailUrl(thumbnails, material.id) : null,
      subtitle: isAttached
        ? t('teamTaskAttachmentAlreadyAdded')
        : unavailable
          ? unavailable
          : isFolder
            ? t('teamTaskFolderOpen')
            : found && pathOf
              ? `${pathOf(material.parentFolderId)} · ${t(CATEGORY_LABEL[material.category ?? 'other'])}`
              : t(CATEGORY_LABEL[material.category ?? 'other'])
    };
  });

  return (
    <>
      {trigger ? (
        trigger(() => {
          if (startTrail && startTrail.length > 0) setPath(startTrail);
          setOpen(true);
        })
      ) : (
        <Button
          // No drop handling: the only thing that ever produced this payload was
          // the browser's dead drag plumbing, so advertising a drop target here
          // promised something nothing could deliver.
          variant="ghost"
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
        </Button>
      )}
      {open && (
        <PickerDialog
          title={title ?? t('teamTaskAttachmentPickerTitle')}
          onClose={close}
          closeLabel={t('teamCancel')}
          initialFocus="#team-task-picker-root"
          size={size}
          mode={single ? 'single' : 'multiple'}
          views={views}
          defaultView={defaultView}
          viewKey={viewKey}
          viewLabels={{
            label: t('pickerViewLabel'),
            list: t('pickerViewList'),
            grid: t('pickerViewGrid')
          }}
          search={
            searchable
              ? {
                  value: search,
                  onChange: setSearch,
                  placeholder: t('teamTaskAttachmentSearch'),
                  clearLabel: t('teamSearchClear')
                }
              : undefined
          }
          toolbar={
            kindFilter ? (
              <SegmentedControl
                size="sm"
                label={t('pickerKindLabel')}
                value={kind}
                onChange={setKind}
                options={[
                  { value: 'all', label: t('pickerKindAll') },
                  { value: 'video', label: t('pickerKindVideo') },
                  { value: 'image', label: t('pickerKindImage') }
                ]}
              />
            ) : undefined
          }
          trail={
            /* The trail is about the open folder, and a search is not in one. */
            found === null ? (
              <div className="team-task-picker-path">
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
                  <Button
                    id="team-task-picker-root"
                    size="sm"
                    variant="ghost"
                    className="team-task-picker-crumb"
                    onClick={() => setPath([])}
                  >
                    {t('teamTaskFolderRoot')}
                  </Button>
                  {path.map((folder, index) => (
                    <span key={folder.id}>
                      <i aria-hidden="true">/</i>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="team-task-picker-crumb"
                        onClick={() => setPath(current => current.slice(0, index + 1))}
                      >
                        {folder.name}
                      </Button>
                    </span>
                  ))}
                </nav>
              </div>
            ) : undefined
          }
          items={items}
          loading={loading || searching}
          loadingLabel={t('teamTaskLoadingPickable')}
          error={error ? t('teamTaskSearchFailed') : null}
          empty={
            storageGone
              ? { title: t(storageGone.title), description: t(storageGone.body) }
              : { title: t(found === null ? 'teamTaskFolderEmpty' : 'teamTaskSearchEmpty') }
          }
          selected={new Set(selected.keys())}
          onPick={item => {
            const material = byId.get(item.id);
            if (!material) return;
            if (material.kind === 'folder') openFolder(material);
            else toggle(material);
          }}
          footer={{
            summary: selected.size > 0 ? t('pickerSelectedCount', { count: selected.size }) : null,
            cancelLabel: t('teamCancel'),
            confirmDisabled: selected.size === 0,
            confirmLabel: (
              <>
                <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                {confirmLabel
                  ? confirmLabel(selected.size)
                  : t('teamTaskAddSelected', { count: selected.size })}
              </>
            ),
            onConfirm: () => {
              stage([...selected.values()]);
              close();
            }
          }}
        />
      )}
    </>
  );
}
