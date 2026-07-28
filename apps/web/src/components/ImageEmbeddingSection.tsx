import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent
} from 'react';
import {
  MAX_CUSTOM_FINAL_IMAGE_DURATION_SECONDS,
  type ImageAsset,
  type ImageEmbeddingSettings,
  type ImageEmbeddingSettingsPatch,
  type ImageSlot
} from '@video-compressor/shared';
import type { TranslationKey } from '../i18n';
import { Checkbox, Collapse, IconButton, Spinner, Tooltip, type Translate } from './ui';

const supportedExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const supportedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function ImageEmbeddingSection({
  settings,
  disabled,
  update,
  uploadImages,
  removeImage,
  imageUrl,
  onValidityChange,
  t
}: {
  settings: ImageEmbeddingSettings;
  disabled: boolean;
  update: (patch: ImageEmbeddingSettingsPatch, debounce?: boolean) => void;
  uploadImages: (slot: ImageSlot, files: File[]) => Promise<void>;
  removeImage: (slot: ImageSlot, id: string) => Promise<void>;
  imageUrl: (id: string) => string;
  onValidityChange: (valid: boolean) => void;
  t: Translate;
}) {
  const [customTime, setCustomTime] = useState(() =>
    formatMinutesInput(settings.customFinalDurationSeconds)
  );
  useEffect(() => {
    setCustomTime(formatMinutesInput(settings.customFinalDurationSeconds));
  }, [settings.customFinalDurationSeconds]);
  const parsedCustomTime = parseMinutesInput(customTime);
  const customTimeValid = parsedCustomTime !== null;
  useEffect(() => {
    onValidityChange(
      !settings.enabled ||
        !settings.endImages.length ||
        settings.finalDurationMode !== 'custom' ||
        customTimeValid
    );
  }, [
    settings.enabled,
    settings.endImages.length,
    settings.finalDurationMode,
    customTimeValid,
    onValidityChange
  ]);

  return (
    <div className="image-embedding-settings">
      <div className="image-embedding-toggle">
        <Checkbox
          className="feature-switch"
          checked={settings.enabled}
          disabled={disabled}
          onChange={event => update({ enabled: event.target.checked })}
          label={<strong>{t('embedImages')}</strong>}
        />
        <Tooltip label={t('embedImagesTooltip')}>{t('embedImagesTooltip')}</Tooltip>
      </div>

      <Collapse open={settings.enabled}>
        <div className="image-embedding-panel">
          <div className="replace-existing-setting">
            <Checkbox
              checked={settings.replaceExisting}
              disabled={disabled}
              onChange={event => update({ replaceExisting: event.target.checked })}
              label={<strong>{t('replaceExistingImages')}</strong>}
            />
            <span>{t('replaceExistingImagesHint')}</span>
          </div>
          <div className="image-columns">
            <ImageColumn
              slot="start"
              title={t('startImageTitle')}
              description={t('startImageDescription')}
              assets={settings.startImages}
              disabled={disabled}
              uploadImages={uploadImages}
              removeImage={removeImage}
              imageUrl={imageUrl}
              t={t}
            >
              <div className="field-group embedding-fit-row">
                <FieldLabel label={t('frameFit')} tooltip={t('frameFitTooltip')} />
                <select
                  value={settings.fitMode}
                  disabled={disabled}
                  aria-label={t('frameFit')}
                  onChange={event =>
                    update({ fitMode: event.target.value as ImageEmbeddingSettings['fitMode'] })
                  }
                >
                  <option value="cover">{t('fitCover')}</option>
                  <option value="contain">{t('fitContain')}</option>
                  <option value="stretch">{t('fitStretch')}</option>
                </select>
                {settings.fitMode === 'stretch' && (
                  <span className="field-hint">{t('fitStretchWarning')}</span>
                )}
              </div>
            </ImageColumn>
            <ImageColumn
              slot="end"
              title={t('endImageTitle')}
              description={t('endImageDescription')}
              assets={settings.endImages}
              disabled={disabled}
              uploadImages={uploadImages}
              removeImage={removeImage}
              imageUrl={imageUrl}
              t={t}
            >
              <div className="field-group final-duration-field">
                <FieldLabel
                  label={t('finalImageDuration')}
                  tooltip={t('finalImageDurationTooltip')}
                />
                <select
                  value={settings.finalDurationMode}
                  disabled={disabled}
                  aria-label={t('finalImageDuration')}
                  onChange={event =>
                    update({
                      finalDurationMode: event.target
                        .value as ImageEmbeddingSettings['finalDurationMode']
                    })
                  }
                >
                  <option value="random-30-40">{t('randomDuration30To40')}</option>
                  <option value="random-40-50">{t('randomDuration40To50')}</option>
                  <option value="random-50-60">{t('randomDuration50To60')}</option>
                  <option value="custom">{t('customDuration')}</option>
                </select>
                {settings.finalDurationMode === 'custom' && (
                  <>
                    <div className="custom-duration-input">
                      <input
                        className={`time-input ${customTime && !customTimeValid ? 'is-invalid' : ''}`}
                        type="text"
                        inputMode="numeric"
                        placeholder="54"
                        value={customTime}
                        disabled={disabled}
                        aria-label={t('customDurationInput')}
                        aria-invalid={!customTimeValid}
                        onChange={event => {
                          const value = event.target.value;
                          setCustomTime(value);
                          const seconds = parseMinutesInput(value);
                          if (seconds !== null)
                            update({ customFinalDurationSeconds: seconds }, true);
                        }}
                      />
                      <span>{t('minutesUnit')}</span>
                    </div>
                    <Collapse fast open={!customTimeValid}>
                      <span className="field-error">{t('invalidCustomDuration')}</span>
                    </Collapse>
                  </>
                )}
              </div>
            </ImageColumn>
          </div>

          {!settings.startImages.length && !settings.endImages.length && (
            <p className="embedding-empty-warning" role="alert">
              {t('embeddingNeedsImage')}
            </p>
          )}
        </div>
      </Collapse>
    </div>
  );
}

function ImageColumn({
  slot,
  title,
  description,
  assets,
  disabled,
  uploadImages,
  removeImage,
  imageUrl,
  children,
  t
}: {
  slot: ImageSlot;
  title: string;
  description: string;
  assets: ImageAsset[];
  disabled: boolean;
  uploadImages: (slot: ImageSlot, files: File[]) => Promise<void>;
  removeImage: (slot: ImageSlot, id: string) => Promise<void>;
  imageUrl: (id: string) => string;
  children?: React.ReactNode;
  t: Translate;
}) {
  return (
    <section className="image-column" aria-label={title}>
      <div className="image-column-heading">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <ImageDropArea
        slot={slot}
        assets={assets}
        disabled={disabled}
        uploadImages={uploadImages}
        removeImage={removeImage}
        imageUrl={imageUrl}
        t={t}
      />
      {children}
    </section>
  );
}

export function ImageDropArea({
  slot,
  assets,
  disabled,
  uploadImages,
  removeImage,
  imageUrl,
  t
}: {
  slot: ImageSlot;
  assets: ImageAsset[];
  disabled: boolean;
  uploadImages: (slot: ImageSlot, files: File[]) => Promise<void>;
  removeImage: (slot: ImageSlot, id: string) => Promise<void>;
  imageUrl: (id: string) => string;
  t: Translate;
}) {
  const input = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  useEffect(() => {
    if (!errorKey) return;
    const timeout = window.setTimeout(() => setErrorKey(null), 2000);
    return () => window.clearTimeout(timeout);
  }, [errorKey]);

  const choose = () => {
    if (disabled || busy) return;
    if (input.current) input.current.value = '';
    input.current?.click();
  };
  const accept = async (files: File[]) => {
    if (!files.length || disabled || busy) return;
    if (files.some(file => !isSupportedImageFile(file))) {
      setErrorKey('unsupportedImageFormat');
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      await uploadImages(slot, files);
    } catch (error) {
      setErrorKey(imageErrorKey(error));
    } finally {
      setBusy(false);
    }
  };
  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (disabled || busy) return;
    dragDepth.current++;
    setDragging(true);
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void accept(Array.from(event.dataTransfer.files));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    choose();
  };
  const remove = async (id: string) => {
    if (disabled || busy) return;
    setBusy(true);
    setErrorKey(null);
    try {
      await removeImage(slot, id);
    } catch (error) {
      setErrorKey(imageErrorKey(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className={`image-drop-wrapper ${dragging ? 'is-dragging' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={event => event.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input
        ref={input}
        className="sr-only"
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        disabled={disabled || busy}
        aria-label={slot === 'start' ? t('chooseStartImage') : t('chooseEndImage')}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          void accept(Array.from(event.target.files ?? []))
        }
      />
      <div className="image-grid-scroll">
        <div
          className={`image-grid ${dragging ? 'is-dragging' : ''} ${errorKey ? 'has-error' : ''}`}
          role="group"
          aria-label={slot === 'start' ? t('startImageTitle') : t('endImageTitle')}
        >
          {assets.map(asset => (
            <div className="selected-image-tile" key={asset.id} title={asset.fileName}>
              {imageUrl(asset.id) && <img src={imageUrl(asset.id)} alt={asset.fileName} />}
              <IconButton
                className="selected-image-action is-delete"
                label={t('deleteImage')}
                disabled={disabled || busy}
                onClick={() => void remove(asset.id)}
              >
                <svg className="selected-image-action-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              </IconButton>
              <span>
                {asset.width}×{asset.height}
              </span>
            </div>
          ))}
          <div
            className={`image-drop-zone image-add-tile ${disabled ? 'is-disabled' : ''}`}
            role="button"
            title={t('dropImage')}
            tabIndex={!disabled ? 0 : -1}
            aria-disabled={disabled}
            onClick={choose}
            onKeyDown={onKeyDown}
          >
            <div className="image-drop-message">
              {busy ? <Spinner /> : <span className="image-drop-icon">＋</span>}
              <strong>
                {busy ? t('uploadingImage') : dragging ? t('dropImageActive') : t('addImage')}
              </strong>
              <span>{t('imageFormats')}</span>
            </div>
          </div>
        </div>
      </div>
      <div className="image-grid-error" aria-live="polite">
        {errorKey && (
          <strong className="field-error" role="alert">
            {t(errorKey)}
          </strong>
        )}
      </div>
    </div>
  );
}

export function isSupportedImageFile(file: Pick<File, 'name' | 'type'>) {
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  return supportedExtensions.has(extension) && (!file.type || supportedMimeTypes.has(file.type));
}

export function parseMinutesInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const minutes = Number(trimmed);
  const total = minutes * 60;
  return minutes > 0 && total <= MAX_CUSTOM_FINAL_IMAGE_DURATION_SECONDS ? total : null;
}

export function formatMinutesInput(seconds: number) {
  return String(Math.max(1, Math.round(seconds / 60)));
}

function imageErrorKey(error: unknown): TranslationKey {
  const code = error instanceof Error ? error.message : '';
  const errors: Record<string, TranslationKey> = {
    IMAGE_UNSUPPORTED_FORMAT: 'unsupportedImageFormat',
    IMAGE_DAMAGED: 'damagedImage',
    IMAGE_TOO_LARGE: 'imageTooLarge',
    IMAGE_UNAVAILABLE: 'imageUnavailable',
    IMAGE_IMPORT_FAILED: 'imageUploadFailed',
    CONNECTION_FAILED: 'connectionFailed'
  };
  return errors[code] ?? 'imageUploadFailed';
}

function FieldLabel({ label, tooltip }: { label: string; tooltip?: string }) {
  return (
    <div className="field-label">
      <span>{label}</span>
      {tooltip && <Tooltip label={tooltip}>{tooltip}</Tooltip>}
    </div>
  );
}
