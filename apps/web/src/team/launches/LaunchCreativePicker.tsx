import { ChevronDown, FolderOpen, Monitor, Plus, Upload } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import {
  CATALOG_PRODUCT_COUNT_MAX,
  addCreatives,
  classifyMaterial,
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
import { Button, DropdownMenu, FormField } from '../../components/ui/index.js';
import { useI18n } from '../../i18n.js';
import { useThumbnailSession } from '../explorer/useThumbnailSession.js';
import { privateCacheEpoch, usePrivateCacheEpoch } from '../private-cache-scope.js';
import { teamErrorMessageFor } from '../errors.js';
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
import { LaunchCreativeRow } from './LaunchCreativeList.js';

type PickerError =
  | { kind: 'selection' | 'mixed' | 'duplicate' | 'limit' }
  | { kind: 'upload'; cause?: unknown };
type Picked = { id: string; name: string; kind: LaunchCreativeKind };

/** The creatives a draft names; an older single-creative draft reads as one. */
export function draftCreatives(config: LaunchDraft): LaunchCreative[] {
  if (Array.isArray(config.creatives) && config.creatives.length > 0) return config.creatives;
  if (!config.materialId) return [];
  return [
    {
      materialId: config.materialId,
      alias: config.creativeAlias ?? '',
      copies: config.catalog?.productCount ?? 1,
      pinned: null
    }
  ];
}

/** The patch that stores `creatives` and keeps the first one mirrored. */
export function creativesPatch(
  config: LaunchDraft,
  creatives: LaunchCreative[],
  kind: LaunchCreativeKind | null,
  productCount = config.catalog?.productCount
): LaunchDraft {
  const first = creatives[0];
  const catalog =
    config.catalog && productCount !== undefined && productCount !== config.catalog.productCount
      ? { catalog: { ...config.catalog, productCount } }
      : {};
  if (!first)
    return {
      materialId: undefined,
      creativeAlias: undefined,
      creatives: undefined,
      creativeKind: undefined,
      ...catalog
    };
  return {
    materialId: first.materialId,
    creativeAlias: first.alias,
    creatives,
    creativeKind: kind ?? undefined,
    ...catalog,
    ...(kind === 'image' && config.catalog?.restitchEnabled
      ? {
          catalog: {
            ...config.catalog,
            ...(productCount !== undefined ? { productCount } : {}),
            restitchEnabled: false,
            ...(config.catalog.catalogVideoProtocolVersion === 1 ? { videoVariationCount: 1 } : {})
          }
        }
      : {})
  };
}

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
  const { t } = useI18n();
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
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
  const scope = `${epoch}:${teamId}:${config.method}:${disabled}`;
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
        creativeKind: undefined
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
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
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
    try {
      const folder = await teamApi.ensureTaskDropFolder(teamId);
      // A navigation, disabled edit or actor change revokes the old form's authority.
      if (!allowed(revision)) return;
      for (const { file, kind: fileKind } of classified) {
        const attempt = startTeamFileAttempt({
          action: 'upload',
          storageKind: 'unknown',
          sizeBucket: teamAnalyticsSizeBucket(file.size),
          stage: 'uploading'
        });
        let stage: 'uploading' | 'finalizing' = 'uploading';
        try {
          const result = await uploadTeamFile({
            teamId,
            destinationFolderId: folder.materialId,
            file,
            conflictMode: 'keep_both',
            replaceMaterialId: null,
            versionOfMaterialId: null
          });
          if (!allowed(revision)) {
            completeTeamFileAttempt(attempt, { outcome: 'skipped', retryable: false, stage });
            return;
          }
          if (!result.materialId || result.state !== 'succeeded')
            throw new Error('INVALID_RESPONSE');
          stage = 'finalizing';
          picked.push({ id: result.materialId, name: file.name, kind: fileKind! });
          completeTeamFileAttempt(attempt, { outcome: 'success', retryable: false, stage });
        } catch (cause) {
          reportFileAttemptError(attempt, cause);
          completeTeamFileAttempt(attempt, {
            outcome: analyticsOutcome(cause),
            retryable: retryableError(cause),
            stage
          });
          throw cause;
        }
      }
    } catch (cause) {
      if (allowed(revision)) setError({ kind: 'upload', cause });
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
  const repeatedAliases = new Set(
    creatives
      .map(creative => creative.alias)
      .filter((alias, index, all) => alias && all.indexOf(alias) !== index)
  );
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
  return (
    <FormField label={t('launchesCreative')} error={selectionError}>
      <div
        className="launch-creative-field"
        data-dragging={dragging || undefined}
        data-busy={busy || undefined}
        data-multiple={(catalogMode && creatives.length > 0) || undefined}
        aria-busy={busy}
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
        {creatives.length > 0 && (
          <ul className="launch-creative-list" aria-label={t('launchesCreative')}>
            {creatives.map((creative, index) => {
              const invalid =
                (submitted || touchedAliases.has(creative.materialId)) &&
                !normalizeLaunchSub(creative.alias);
              return (
                <LaunchCreativeRow
                  key={creative.materialId}
                  inputId={`${id}-alias-${index}`}
                  alias={creative.alias}
                  kind={kind}
                  thumbnailUrl={thumbnailFor(creative.materialId)}
                  disabled={unavailable}
                  invalid={invalid}
                  repeated={!invalid && repeatedAliases.has(creative.alias)}
                  removable={catalogMode}
                  onPreview={() => setPreviewId(creative.materialId)}
                  onRename={value => rename(index, value)}
                  onRemove={() => remove(index)}
                />
              );
            })}
          </ul>
        )}
        <TaskAttachmentPicker
          key={`${epoch}:${teamId}:${catalogMode}`}
          teamId={teamId}
          title={t('launchesSelectCreative')}
          confirmLabel={() => t('launchesSelectCreative')}
          single={!catalogMode}
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
                className={
                  creatives.length === 0
                    ? 'launch-creative-empty'
                    : catalogMode
                      ? 'launch-creative-add'
                      : 'launch-creative-replace'
                }
                disabled={unavailable || (catalogMode && creatives.length >= CATALOG_PRODUCT_COUNT_MAX)}
                loading={busy}
                aria-haspopup="menu"
                aria-expanded={menuOpen && !unavailable}
                onClick={() => setMenuOpen(value => !value)}
              >
                {creatives.length === 0 ? (
                  <Upload size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                ) : (
                  catalogMode && <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                )}
                <span>
                  {busy
                    ? t('launchCreativeUploading')
                    : creatives.length === 0
                      ? t('launchCreativeChooseOrDrop')
                      : catalogMode
                        ? t('launchCreativeAdd')
                        : t('launchCreativeReplace')}
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
                      if (allowed(currentRevision) && !active.current) fileInput.current?.click();
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
        <input
          ref={fileInput}
          type="file"
          accept={accept}
          multiple={catalogMode}
          hidden
          disabled={unavailable}
          aria-label={t('launchCreativeComputer')}
          onChange={event => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (files.length) void upload(files);
          }}
        />
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
