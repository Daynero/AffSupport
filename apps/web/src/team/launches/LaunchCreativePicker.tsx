import { ChevronDown, FolderOpen, Monitor, Upload } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import {
  CATALOG_PRODUCT_COUNT_MAX,
  addCreatives,
  balanceCopies,
  dragCopies,
  evenCopies,
  maxCopiesFor,
  setCopies,
  classifyMaterial,
  launchAutoCreativeLabel,
  launchCreativeAlias,
  normalizeLaunchSub,
  removeCreative,
  type LaunchCreative,
  type LaunchCreativeKind,
  type LaunchSourceSnapshot,
  type LaunchDraft
} from '@video-compressor/shared';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons.js';
import { MaterialPreview } from '../preview/MaterialPreview.js';
import { TaskAttachmentPicker } from '../tasks/TaskAttachmentPicker.js';
import { teamApi } from '../../api/team.js';
import { uploadTeamFile } from '../catalog/material-actions-client.js';
import {
  Button,
  DropdownMenu,
  FileTrigger,
  FormField,
  type FileTriggerHandle
} from '../../components/ui/index.js';
import { creativeSelectKey, useI18n } from '../../i18n.js';
import { useThumbnailSession } from '../explorer/useThumbnailSession.js';
import { privateCacheEpoch, usePrivateCacheEpoch } from '../private-cache-scope.js';
import { teamErrorMessageFor } from '../errors.js';
import { useOptionalToasts } from '../../components/toast.js';
import {
  completeTeamFileAttempt,
  startTeamFileAttempt,
  teamAnalyticsSizeBucket
} from '../../analytics/service.js';
import {
  analyticsOutcome,
  reportFileAttemptError,
  retryableError
} from '../../analytics/file-attempt-errors.js';
import {
  LaunchCreativeLabelField,
  LaunchCreativeRow,
  LaunchCreativeShareRow
} from './LaunchCreativeList.js';
import { creativesPatch, draftCreatives } from './launchCreatives.js';

type PickerError =
  { kind: 'selection' | 'mixed' | 'duplicate' | 'limit' } | { kind: 'upload'; cause?: unknown };
type Picked = { id: string; name: string; kind: LaunchCreativeKind };

function kindOf(category: string | null | undefined): LaunchCreativeKind | null {
  return category === 'video' || category === 'image' ? category : null;
}

/**
 * One drop target and one source menu. A catalog Launch collects any number of
 * creatives of one kind (videos or images); "other" keeps one creative. Full
 * media is opened only on an explicit preview.
 */
export function LaunchCreativePicker({
  teamId,
  config,
  sources,
  onChange,
  disabled,
  onBusyChange,
  submitted = false
}: {
  teamId: string;
  config: LaunchDraft;
  sources?: LaunchSourceSnapshot | null;
  onChange: (patch: LaunchDraft) => void;
  disabled: boolean;
  onBusyChange?: (busy: boolean) => void;
  submitted?: boolean;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const fileInput = useRef<FileTriggerHandle>(null);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWasOpen = useRef(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<PickerError | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [touchedAliases, setTouchedAliases] = useState<Set<string>>(new Set());
  const catalogMode = config.method === 'catalog';
  const creatives = draftCreatives(config);
  const kind: LaunchCreativeKind | null =
    config.creativeKind ??
    (creatives.length > 0 ? (sources?.materialType ?? (catalogMode ? 'video' : null)) : null);
  const epoch = usePrivateCacheEpoch();
  const scope = `${epoch}:${teamId}:${config.materialId ?? ''}:${config.method}:${disabled}`;
  const authority = useRef({ scope, revision: 0 });
  if (authority.current.scope !== scope) {
    authority.current = { scope, revision: authority.current.revision + 1 };
  }
  const mounted = useRef(true);
  const active = useRef<{ revision: number; finish: () => void } | null>(null);
  // The latest draft, so a long upload adds to what is there when it finishes.
  const latest = useRef(config);
  latest.current = config;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.finish();
    };
  }, []);
  useEffect(() => {
    setPreviewId(null);
    setMenuOpen(false);
    setDragging(false);
    setError(null);
    if (active.current && active.current.revision !== authority.current.revision)
      active.current.finish();
  }, [scope]);
  const thumbnailSession = useThumbnailSession({
    teamId,
    client: teamApi,
    enabled: creatives.length > 0
  });
  const thumbnailFor = (materialId: string) =>
    thumbnailSession ? teamApi.thumbnailUrl(thumbnailSession, materialId) : null;
  const currentRevision = authority.current.revision;
  const allowed = (revision: number, actorEpoch = epoch) =>
    mounted.current &&
    !disabled &&
    revision === authority.current.revision &&
    actorEpoch === privateCacheEpoch();

  /** Every picked file must be of one kind, and of the kind already chosen. */
  const admissible = (picked: ReadonlyArray<{ kind: LaunchCreativeKind | null }>) => {
    const kinds = new Set(picked.map(item => item.kind));
    if (kinds.has(null)) return { ok: false as const, error: { kind: 'selection' as const } };
    if (kinds.size > 1 || (kind && creatives.length > 0 && !kinds.has(kind)))
      return { ok: false as const, error: { kind: 'mixed' as const } };
    if (!catalogMode && picked.length !== 1)
      return { ok: false as const, error: { kind: 'selection' as const } };
    if (catalogMode && creatives.length + picked.length > CATALOG_PRODUCT_COUNT_MAX)
      return { ok: false as const, error: { kind: 'limit' as const } };
    return { ok: true as const, kind: [...kinds][0] as LaunchCreativeKind };
  };

  const add = (picked: Picked[]) => {
    const draft = latest.current;
    const current = draftCreatives(draft);
    if (!catalogMode) {
      const [one] = picked;
      if (!one) return;
      onChange({
        materialId: one.id,
        creativeAlias: launchCreativeAlias(one.name),
        creatives: undefined,
        creativeKind: undefined,
        creativeLabel: undefined
      });
      return;
    }
    const known = new Set(current.map(creative => creative.materialId));
    const fresh = picked.filter(item => !known.has(item.id));
    if (fresh.length === 0) {
      setError({ kind: 'duplicate' });
      return;
    }
    const next = addCreatives(
      current,
      fresh.map(item => ({ materialId: item.id, alias: launchCreativeAlias(item.name) })),
      draft.catalog?.productCount ?? current.length
    );
    if (fresh.length < picked.length) setError({ kind: 'duplicate' });
    onChange(creativesPatch(draft, next.creatives, picked[0]!.kind, next.productCount));
  };

  const upload = async (files: File[]) => {
    if (!allowed(currentRevision) || active.current) return;
    const classified = files.map(file => ({
      file,
      kind: kindOf(
        classifyMaterial({
          kind: 'file',
          mimeType: file.type,
          fileExtension: file.name.split('.').pop()
        }).category
      )
    }));
    const verdict = admissible(classified);
    if (!verdict.ok) {
      setError(verdict.error);
      return;
    }
    const revision = currentRevision;
    // One observed attempt per file, started before the destination is found.
    const attempts = classified.map(({ file }) => ({
      attempt: startTeamFileAttempt({
        action: 'upload',
        storageKind: 'unknown',
        sizeBucket: teamAnalyticsSizeBucket(file.size),
        stage: 'finding'
      }),
      stage: 'finding' as 'finding' | 'uploading' | 'finalizing',
      done: false
    }));
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      // Leaving the form ends this observation, not the independently owned upload.
      for (const entry of attempts)
        if (!entry.done) {
          entry.done = true;
          completeTeamFileAttempt(entry.attempt, {
            outcome: 'skipped',
            retryable: false,
            stage: entry.stage
          });
        }
      if (active.current?.revision === revision) active.current = null;
      if (mounted.current) setBusy(false);
      onBusyChange?.(false);
    };
    active.current = { revision, finish };
    setBusy(true);
    setMenuOpen(false);
    setError(null);
    onBusyChange?.(true);
    const picked: Picked[] = [];
    let current: (typeof attempts)[number] | undefined;
    try {
      const folder = await teamApi.ensureTaskDropFolder(teamId);
      // A navigation, disabled edit or actor change revokes the old form's authority.
      if (!allowed(revision)) return;
      for (const [index, { file, kind: fileKind }] of classified.entries()) {
        current = attempts[index]!;
        current.stage = 'uploading';
        const result = await uploadTeamFile({
          teamId,
          destinationFolderId: folder.materialId,
          file,
          conflictMode: 'keep_both',
          replaceMaterialId: null,
          versionOfMaterialId: null
        });
        if (!allowed(revision)) return;
        if (!result.materialId || result.state !== 'succeeded') throw new Error('INVALID_RESPONSE');
        current.stage = 'finalizing';
        picked.push({ id: result.materialId, name: file.name, kind: fileKind! });
        current.done = true;
        completeTeamFileAttempt(current.attempt, {
          outcome: 'success',
          retryable: false,
          stage: current.stage
        });
      }
    } catch (cause) {
      if (allowed(revision)) {
        // The failing file (or, before any upload, every file) carries the cause.
        for (const entry of current ? [current] : attempts) {
          entry.done = true;
          reportFileAttemptError(entry.attempt, cause);
          completeTeamFileAttempt(entry.attempt, {
            outcome: analyticsOutcome(cause),
            retryable: retryableError(cause),
            stage: entry.stage
          });
        }
        setError({ kind: 'upload', cause });
      }
    } finally {
      // Files already uploaded stay chosen even when a later one fails.
      if (picked.length && allowed(revision)) {
        setNames(previous => ({
          ...previous,
          ...Object.fromEntries(picked.map(item => [item.id, item.name]))
        }));
        add(picked);
      }
      finish();
    }
  };

  const remove = (index: number) => {
    const draft = latest.current;
    const current = draftCreatives(draft);
    const next = removeCreative(current, index, draft.catalog?.productCount ?? current.length);
    setError(null);
    onChange(creativesPatch(draft, next, next.length ? kind : null));
  };

  const toasts = useOptionalToasts();
  /** Every creative at once (owner, 25.11): one by one was fourteen presses of «×». Undoable. */
  const removeAll = () => {
    const draft = latest.current;
    const before = draftCreatives(draft);
    if (before.length === 0) return;
    setError(null);
    onChange(creativesPatch(draft, [], null));
    toasts?.push({
      tone: 'info',
      text: t('launchCreativesRemovedAll', { count: before.length }),
      action: {
        label: t('teamUndo'),
        run: () => {
          if (draftCreatives(latest.current).length > 0) return;
          onChange(creativesPatch(latest.current, before, kind));
        }
      }
    });
  };

  const rename = (index: number, value: string) => {
    const draft = latest.current;
    const alias = value.replace(/\p{Zs}+/gu, '_');
    const current = draftCreatives(draft);
    setTouchedAliases(previous => new Set([...previous, current[index]!.materialId]));
    if (!catalogMode || current.length === 0) {
      onChange({ creativeAlias: alias });
      return;
    }
    const next = current.map((creative, at) => (at === index ? { ...creative, alias } : creative));
    onChange(creativesPatch(draft, next, kind));
  };

  const unavailable = disabled || busy;
  const selectionError = submitted && creatives.length === 0 ? t('launchesRequired') : undefined;
  const accept = catalogMode
    ? creatives.length > 0 && kind
      ? `${kind}/*`
      : 'video/*,image/*'
    : 'video/*,image/*';
  const errorText =
    error === null
      ? null
      : error.kind === 'upload'
        ? teamErrorMessageFor(error.cause, t)
        : error.kind === 'mixed'
          ? t('launchCreativesMixed')
          : error.kind === 'duplicate'
            ? t('launchCreativeDuplicate')
            : error.kind === 'limit'
              ? t('launchCreativesLimit')
              : t('launchesOneFile');
  const previewed = creatives.find(creative => creative.materialId === previewId);
  const n = config.catalog?.productCount ?? creatives.length;
  const shareMax = maxCopiesFor(n, creatives.length);
  const evenSplit = evenCopies(n, creatives.length);
  const isEven = creatives.every((creative, index) => creative.copies === evenSplit[index]);
  const share = (next: LaunchCreative[]) => onChange(creativesPatch(latest.current, next, kind));
  const singleInvalid =
    creatives[0] !== undefined &&
    (submitted || touchedAliases.has(creatives[0].materialId)) &&
    !normalizeLaunchSub(creatives[0].alias);
  // One compact drop strip: it says it takes dropped files and opens the source menu.
  const compactDrop = catalogMode || creatives.length === 0;
  return (
    <FormField
      label={t(creatives.length > 1 ? 'launchesCreatives' : 'launchesCreative')}
      error={selectionError}
    >
      <div
        className="flex min-w-0 max-w-xl flex-col gap-2"
        onDragOver={event => {
          if (event.dataTransfer.types?.includes('Files')) {
            event.preventDefault();
            event.dataTransfer.dropEffect = unavailable ? 'none' : 'copy';
            if (!unavailable) setDragging(true);
          }
        }}
        onDragLeave={event => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          )
            setDragging(false);
        }}
        onDrop={event => {
          event.preventDefault();
          setDragging(false);
          if (!unavailable && event.dataTransfer.files.length)
            void upload(Array.from(event.dataTransfer.files));
        }}
      >
        {catalogMode && creatives.length > 0 && (
          <ul
            className="m-0 flex max-h-96 list-none flex-col gap-2 overflow-y-auto p-0"
            aria-label={t('launchesCreative')}
          >
            {creatives.map((creative, index) => (
              <LaunchCreativeShareRow
                key={creative.materialId}
                alias={creative.alias}
                kind={kind}
                thumbnailUrl={thumbnailFor(creative.materialId)}
                copies={creative.copies}
                max={shareMax}
                shared={creatives.length > 1}
                disabled={unavailable}
                onPreview={() => setPreviewId(creative.materialId)}
                onDrag={value => share(dragCopies(draftCreatives(latest.current), index, value, n))}
                onType={value => share(setCopies(draftCreatives(latest.current), index, value, n))}
                onRemove={() => remove(index)}
              />
            ))}
          </ul>
        )}
        <div
          className={
            compactDrop
              ? `launch-creative-drop flex min-h-10 min-w-0 items-center gap-2 rounded-md border border-dashed px-3 text-caption text-ink-muted ${
                  dragging ? 'border-secondary-border bg-secondary-soft' : 'border-neutral-border'
                }`
              : 'launch-creative-field'
          }
          data-dragging={dragging || undefined}
          data-busy={busy || undefined}
          data-disabled={(compactDrop && unavailable) || undefined}
          aria-busy={busy}
          // The whole drop zone opens «Обрати», not only its button (next QA 2026-11-21).
          // A pointer convenience: the button inside stays the one control for the
          // keyboard and for assistive technology, so the zone takes no role of its own.
          onPointerDownCapture={() => {
            menuWasOpen.current = menuOpen;
          }}
          onClick={event => {
            if (!compactDrop || unavailable || busy) return;
            if (event.target instanceof Element && event.target.closest('button, input, a')) return;
            // A press on the zone while the menu is up closes it, as the button does.
            if (!menuWasOpen.current) setMenuOpen(true);
          }}
        >
          {!compactDrop && creatives[0] && (
            <LaunchCreativeRow
              inputId={`${id}-alias-0`}
              alias={creatives[0].alias}
              kind={kind}
              thumbnailUrl={thumbnailFor(creatives[0].materialId)}
              disabled={unavailable}
              invalid={singleInvalid}
              onPreview={() => setPreviewId(creatives[0]!.materialId)}
              onRename={value => rename(0, value)}
            />
          )}
          {compactDrop && (
            <>
              <Upload size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              <span className="launch-creative-drop-hint min-w-0 truncate">
                {busy
                  ? t('launchCreativeUploading')
                  : t(creatives.length ? 'launchCreativeDropMore' : 'launchCreativeDropHint')}
              </span>
            </>
          )}
          {catalogMode && creatives.length > 1 && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto shrink-0"
              disabled={unavailable || isEven}
              onClick={() => share(balanceCopies(draftCreatives(latest.current), n))}
            >
              {t('launchDistributionBalance')}
            </Button>
          )}
          {catalogMode && creatives.length > 1 && (
            <Button
              size="sm"
              variant="ghost"
              color="error"
              className="shrink-0"
              disabled={unavailable}
              onClick={removeAll}
            >
              {t('launchCreativesRemoveAll')}
            </Button>
          )}
          <TaskAttachmentPicker
            key={`${epoch}:${teamId}:${catalogMode}`}
            teamId={teamId}
            title={t(catalogMode ? 'launchesSelectCreatives' : 'launchesSelectCreative')}
            confirmLabel={count =>
              catalogMode && count > 0
                ? t(creativeSelectKey(language, count), { count })
                : t('launchesSelectCreative')
            }
            single={!catalogMode}
            // 075: a creative is found by its picture — a large window, tiles first.
            size="xl"
            defaultView="grid"
            viewKey="launch-creatives"
            kindFilter={!(catalogMode && creatives.length > 0)}
            // A video and a picture cannot share a Launch: once one kind is ticked the other
            // is shown unavailable, not accepted and then refused with the whole choice.
            unavailableWith={(material, chosen) => {
              if (!catalogMode || chosen.length === 0) return null;
              const first = kindOf(chosen[0]!.category);
              const own = kindOf(material.category);
              return first && own && first !== own ? t('launchCreativesMixed') : null;
            }}
            attachedMaterialIds={new Set(catalogMode ? creatives.map(c => c.materialId) : [])}
            accept={material => {
              if (material.kind !== 'file') return false;
              const category = kindOf(material.category);
              if (!category) return false;
              return !(catalogMode && creatives.length > 0 && kind && category !== kind);
            }}
            onAdd={items => {
              if (!allowed(currentRevision) || active.current) return;
              const picked = items.map(item => ({
                id: item.id,
                name: item.name,
                kind: kindOf(item.category)
              }));
              // The browser's filter is fixed when it opens, so the set is checked again here.
              const verdict = admissible(picked);
              if (!verdict.ok) {
                setError(verdict.error);
                return;
              }
              setError(null);
              setNames(previous => ({
                ...previous,
                ...Object.fromEntries(items.map(item => [item.id, item.name]))
              }));
              add(picked.map(item => ({ ...item, kind: verdict.kind })));
            }}
            trigger={open => (
              <>
                <Button
                  ref={menuAnchor}
                  variant="ghost"
                  size={compactDrop ? 'sm' : 'md'}
                  className={
                    compactDrop
                      ? catalogMode && creatives.length > 1
                        ? 'shrink-0'
                        : 'ml-auto shrink-0'
                      : 'launch-creative-replace'
                  }
                  disabled={
                    unavailable || (catalogMode && creatives.length >= CATALOG_PRODUCT_COUNT_MAX)
                  }
                  loading={busy}
                  aria-label={
                    compactDrop
                      ? t(
                          busy
                            ? 'launchCreativeUploading'
                            : creatives.length
                              ? 'launchCreativeAdd'
                              : 'launchCreativeChooseOrDrop'
                        )
                      : undefined
                  }
                  aria-haspopup="menu"
                  aria-expanded={menuOpen && !unavailable}
                  onClick={() => setMenuOpen(value => !value)}
                >
                  <span>
                    {compactDrop ? t('launchCreativeChoose') : t('launchCreativeReplace')}
                  </span>
                  <ChevronDown size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                </Button>
                <DropdownMenu
                  open={menuOpen && !unavailable}
                  onClose={() => setMenuOpen(false)}
                  anchor={menuAnchor}
                  placement="bottom-start"
                  label={t('launchesSelectCreative')}
                  items={[
                    {
                      id: 'computer',
                      label: t('launchCreativeComputer'),
                      icon: <Monitor size={ICON_SIZE} strokeWidth={ICON_STROKE} />,
                      onSelect: () => {
                        if (allowed(currentRevision) && !active.current) fileInput.current?.open();
                      }
                    },
                    {
                      id: 'workspace',
                      label: t('launchCreativeWorkspace'),
                      icon: <FolderOpen size={ICON_SIZE} strokeWidth={ICON_STROKE} />,
                      onSelect: () => {
                        if (allowed(currentRevision) && !active.current) open();
                      }
                    }
                  ]}
                />
              </>
            )}
          />
          {/* The inventory's way into the file system (070, T080): opened from the menu item
              through the ref; an unavailable picker never opens it (the item checks first). */}
          <FileTrigger
            ref={fileInput}
            acceptedFileTypes={accept.split(',')}
            allowsMultiple={catalogMode}
            label={t('launchCreativeComputer')}
            onSelect={files => {
              if (!unavailable) void upload(files);
            }}
          />
        </div>
        {catalogMode && creatives.length > 1 && (
          <LaunchCreativeLabelField
            value={config.creativeLabel}
            automatic={launchAutoCreativeLabel({ creativeAlias: creatives[0]!.alias, creatives })}
            disabled={unavailable}
            onChange={creativeLabel => onChange({ creativeLabel })}
          />
        )}
      </div>
      {errorText && (
        <p role="alert" className="ui-field-error">
          {errorText}
        </p>
      )}
      {previewed && !disabled && (
        <MaterialPreview
          key={`${teamId}:${previewed.materialId}`}
          teamId={teamId}
          material={{
            id: previewed.materialId,
            name: names[previewed.materialId] ?? previewed.alias ?? t('launchesCreative'),
            category: kind
          }}
          onClose={() => setPreviewId(null)}
        />
      )}
    </FormField>
  );
}
