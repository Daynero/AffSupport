import { ChevronDown, FolderOpen, ImageIcon, Monitor, Play, Upload } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import {
  classifyMaterial,
  launchCreativeAlias,
  normalizeLaunchSub,
  type LaunchSourceSnapshot,
  type LaunchDraft
} from '@video-compressor/shared';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons.js';
import { MaterialPreview } from '../preview/MaterialPreview.js';
import { TaskAttachmentPicker } from '../tasks/TaskAttachmentPicker.js';
import { teamApi } from '../../api/team.js';
import { uploadTeamFile } from '../catalog/material-actions-client.js';
import { Button, DropdownMenu, Input, FormField } from '../../components/ui/index.js';
import { useI18n } from '../../i18n.js';
import { useThumbnailSession } from '../explorer/useThumbnailSession.js';
import { privateCacheEpoch, usePrivateCacheEpoch } from '../private-cache-scope.js';

/** One drop target, one source menu; full media is opened only on an explicit preview. */
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
  const [error, setError] = useState<'selection' | 'upload' | null>(null);
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const [aliasTouched, setAliasTouched] = useState(false);
  const [brokenThumbnail, setBrokenThumbnail] = useState<string | null>(null);
  const epoch = usePrivateCacheEpoch();
  const scope = `${epoch}:${teamId}:${config.materialId ?? ''}:${config.method}:${disabled}`;
  const authority = useRef({ scope, revision: 0 });
  if (authority.current.scope !== scope) {
    authority.current = { scope, revision: authority.current.revision + 1 };
  }
  const mounted = useRef(true);
  const active = useRef<{ revision: number; finish: () => void } | null>(null);
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
    enabled: Boolean(config.materialId)
  });
  const thumbnailUrl =
    thumbnailSession && config.materialId
      ? teamApi.thumbnailUrl(thumbnailSession, config.materialId)
      : null;
  const selectedName =
    selected && selected.id === config.materialId ? selected.name : config.creativeAlias;
  const currentRevision = authority.current.revision;
  const allowed = (revision: number, actorEpoch = epoch) =>
    mounted.current &&
    !disabled &&
    revision === authority.current.revision &&
    actorEpoch === privateCacheEpoch();
  const upload = async (files: File[]) => {
    if (!allowed(currentRevision) || active.current) return;
    if (files.length !== 1) {
      setError('selection');
      return;
    }
    const file = files[0];
    const kind = classifyMaterial({
      kind: 'file',
      mimeType: file.type,
      fileExtension: file.name.split('.').pop()
    }).category;
    if (kind !== 'video' && (kind !== 'image' || config.method === 'catalog')) {
      setError('selection');
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
    try {
      const folder = await teamApi.ensureTaskDropFolder(teamId);
      // A navigation, disabled edit or actor change revokes the old form's authority.
      if (!allowed(revision)) return;
      const result = await uploadTeamFile({
        teamId,
        destinationFolderId: folder.folderId,
        file,
        conflictMode: 'keep_both',
        replaceMaterialId: null,
        versionOfMaterialId: null
      });
      if (!allowed(revision)) return;
      if (!result.materialId || result.state !== 'succeeded') throw new Error('INVALID_RESPONSE');
      setSelected({ id: result.materialId, name: file.name });
      onChange({ materialId: result.materialId, creativeAlias: launchCreativeAlias(file.name) });
    } catch {
      if (allowed(revision)) setError('upload');
    } finally {
      finish();
    }
  };
  const unavailable = disabled || busy;
  const selectionError = submitted && !config.materialId ? t('launchesRequired') : undefined;
  const aliasError = (submitted || aliasTouched) && !normalizeLaunchSub(config.creativeAlias ?? '');
  return (
    <FormField label={t('launchesCreative')} error={selectionError}>
      <div
        className="launch-creative-field"
        data-dragging={dragging || undefined}
        data-busy={busy || undefined}
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
        {config.materialId && (
          <>
            <Button
              className="launch-creative-thumbnail"
              variant="ghost"
              disabled={unavailable}
              aria-label={t('launchesPreviewCreative')}
              onClick={() => setPreviewId(config.materialId ?? null)}
            >
              {thumbnailUrl && brokenThumbnail !== thumbnailUrl ? (
                <img src={thumbnailUrl} alt="" onError={() => setBrokenThumbnail(thumbnailUrl)} />
              ) : (
                <ImageIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              )}
              <span className="launch-creative-play">
                <Play size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </span>
            </Button>
            <div className="launch-creative-name">
              <label className="sr-only" htmlFor={`${id}-alias`}>
                {t('launchesAlias')}
              </label>
              <Input
                id={`${id}-alias`}
                value={config.creativeAlias ?? ''}
                disabled={unavailable}
                aria-invalid={aliasError || undefined}
                aria-describedby={aliasError ? `${id}-error` : undefined}
                onChange={event => {
                  setAliasTouched(true);
                  onChange({ creativeAlias: event.target.value.replace(/\p{Zs}+/gu, '_') });
                }}
              />
            </div>
          </>
        )}
        <TaskAttachmentPicker
          key={`${epoch}:${teamId}`}
          teamId={teamId}
          title={t('launchesSelectCreative')}
          confirmLabel={() => t('launchesSelectCreative')}
          single
          attachedMaterialIds={new Set()}
          accept={material =>
            material.kind === 'file' &&
            (material.category === 'video' ||
              (config.method !== 'catalog' && material.category === 'image'))
          }
          onAdd={items => {
            if (!allowed(currentRevision) || active.current) return;
            if (items.length !== 1) {
              setError('selection');
              return;
            }
            setError(null);
            setSelected({ id: items[0].id, name: items[0].name });
            onChange({
              materialId: items[0].id,
              creativeAlias: launchCreativeAlias(items[0].name)
            });
          }}
          trigger={open => (
            <>
              <Button
                ref={menuAnchor}
                variant="ghost"
                className={config.materialId ? 'launch-creative-replace' : 'launch-creative-empty'}
                disabled={unavailable}
                loading={busy}
                aria-haspopup="menu"
                aria-expanded={menuOpen && !unavailable}
                onClick={() => setMenuOpen(value => !value)}
              >
                {!config.materialId && (
                  <Upload size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                )}
                <span>
                  {busy
                    ? t('launchCreativeUploading')
                    : t(config.materialId ? 'launchCreativeReplace' : 'launchCreativeChooseOrDrop')}
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
          accept={config.method === 'catalog' ? 'video/*' : 'video/*,image/*'}
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
      {config.materialId && aliasError && (
        <p id={`${id}-error`} className="ui-field-error" role="alert">
          {t('launchesSubInvalid')}
        </p>
      )}
      {error && (
        <p role="alert" className="ui-field-error">
          {t(error === 'upload' ? 'errorUploadFailed' : 'launchesOneFile')}
        </p>
      )}
      {previewId && previewId === config.materialId && !disabled && (
        <MaterialPreview
          key={`${teamId}:${previewId}`}
          teamId={teamId}
          material={{
            id: previewId,
            name: selectedName ?? t('launchesCreative'),
            category: sources?.materialId === previewId ? sources.materialType : null
          }}
          onClose={() => setPreviewId(null)}
        />
      )}
    </FormField>
  );
}
