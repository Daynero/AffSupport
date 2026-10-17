import { Eye } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { MaterialPreview } from '../preview/MaterialPreview';
import { useEffect, useRef, useState } from 'react';
import {
  classifyMaterial,
  launchCreativeAlias,
  normalizeLaunchSub,
  type LaunchSourceSnapshot,
  type LaunchDraft
} from '@video-compressor/shared';
import { TaskAttachmentPicker } from '../tasks/TaskAttachmentPicker';
import { teamApi } from '../../api/team';
import { uploadTeamFile } from '../catalog/material-actions-client';
import { Button, IconButton, Input, FormField } from '../../components/ui/index';
import { useI18n } from '../../i18n';
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
  const fileInput = useRef<HTMLInputElement>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [aliasTouched, setAliasTouched] = useState(false);
  const aliasValid = normalizeLaunchSub(config.creativeAlias ?? '') !== null;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const mounted = useRef(true);
  const busyRef = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setPreviewId(null);
  }, [teamId, config.materialId, disabled]);
  const upload = async (files: File[]) => {
    if (disabledRef.current || busyRef.current) return;
    if (files.length !== 1) {
      setError(true);
      return;
    }
    const kind = classifyMaterial({
      kind: 'file',
      mimeType: files[0].type,
      fileExtension: files[0].name.split('.').pop()
    }).category;
    if (kind !== 'video' && (kind !== 'image' || config.method === 'catalog')) {
      setError(true);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(false);
    try {
      const folder = await teamApi.ensureTaskDropFolder(teamId);
      const result = await uploadTeamFile({
        teamId,
        destinationFolderId: folder.folderId,
        file: files[0],
        conflictMode: 'keep_both',
        replaceMaterialId: null,
        versionOfMaterialId: null
      });
      if (!result.materialId || result.state !== 'succeeded') throw new Error('INVALID_RESPONSE');
      if (!mounted.current || disabledRef.current) return;
      onChange({
        materialId: result.materialId,
        creativeAlias: launchCreativeAlias(files[0].name)
      });
      setSelectedName(files[0].name);
    } catch {
      if (mounted.current) setError(true);
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        setBusy(false);
        onBusyChange?.(false);
      }
    }
  };
  return (
    <div
      className="flex flex-col gap-2"
      onDragOver={e => {
        if (!disabled) e.preventDefault();
      }}
      onDrop={e => {
        e.preventDefault();
        void upload(Array.from(e.dataTransfer.files));
      }}
    >
      <FormField
        label={t('launchesCreative')}
        help={submitted && !config.materialId ? t('launchesRequired') : undefined}
        error={submitted && !config.materialId ? t('launchesRequired') : undefined}
      >
        <div className="launch-creative-controls">
          <Input
            aria-label={t('launchesAlias')}
            value={config.creativeAlias ?? ''}
            disabled={disabled || busy}
            onChange={e => {
              setAliasTouched(true);
              onChange({ creativeAlias: e.target.value.replace(/\p{Zs}+/gu, '_') });
            }}
          />
          <IconButton
            label={t('launchesPreviewCreative')}
            disabled={disabled || busy || !config.materialId}
            onClick={() => setPreviewId(config.materialId ?? null)}
          >
            <Eye size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
          <TaskAttachmentPicker
            teamId={teamId}
            title={t('launchesSelectCreative')}
            confirmLabel={() => t('launchesSelectCreative')}
            single
            attachedMaterialIds={new Set()}
            accept={m =>
              m.kind === 'file' &&
              (m.category === 'video' || (config.method !== 'catalog' && m.category === 'image'))
            }
            onAdd={items => {
              if (!mounted.current || disabledRef.current || busyRef.current) return;
              if (items.length !== 1) {
                setError(true);
                return;
              }
              onChange({
                materialId: items[0].id,
                creativeAlias: launchCreativeAlias(items[0].name)
              });
              setSelectedName(items[0].name);
            }}
            trigger={open => (
              <Button disabled={disabled || busy} onClick={open}>
                {t('launchesSelectCreative')}
              </Button>
            )}
          />
          <input
            ref={fileInput}
            type="file"
            accept="video/*,image/*"
            hidden
            disabled={disabled || busy}
            onChange={e => {
              void upload(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <Button
            disabled={disabled || busy}
            loading={busy}
            onClick={() => fileInput.current?.click()}
          >
            {t('launchesUpload')}
          </Button>
          {config.materialId && (
            <span className="text-caption text-muted" title={selectedName ?? undefined}>
              {t('launchesSelectedCreative')}
            </span>
          )}
        </div>
        {(submitted || aliasTouched) && !aliasValid && (
          <p className="ui-field-error" role="alert">
            {t('launchesSubInvalid')}
          </p>
        )}
      </FormField>
      {previewId && previewId === config.materialId && !disabled && (
        <MaterialPreview
          key={`${teamId}:${previewId}`}
          teamId={teamId}
          material={{
            id: previewId,
            name: selectedName ?? config.creativeAlias ?? t('launchesCreative'),
            category: sources?.materialId === previewId ? sources.materialType : null
          }}
          onClose={() => setPreviewId(null)}
        />
      )}
      {error && (
        <p role="alert" className="text-error-text">
          {t('launchesOneFile')}
        </p>
      )}
    </div>
  );
}
