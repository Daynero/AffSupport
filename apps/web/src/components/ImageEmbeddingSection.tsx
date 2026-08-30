import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent, useLayoutEffect } from 'react';
import {
  MAX_CUSTOM_FINAL_IMAGE_DURATION_SECONDS,
  MAX_CUSTOM_START_IMAGE_DURATION_MS,
  MIN_CUSTOM_START_IMAGE_DURATION_MS,
  type ImageAsset,
  type ImageEmbeddingSettings,
  type ImageEmbeddingSettingsPatch,
  type ImageSlot
} from '@video-compressor/shared';
import type { TranslationKey } from '../i18n';
import { Checkbox, Collapse, IconButton, Spinner, Tooltip, type Translate } from './ui';
import { imageContentPath } from '../api/subresource-paths';
import { Crop, Dices, Image as ImageIcon, Minimize2, Plus, Timer, UnfoldVertical, X } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from './icons';
import { useSubresourceUrl } from '../api/useSubresourceUrl';

const supportedExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const supportedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function ImageEmbeddingSection({
  settings,
  disabled,
  update,
  uploadImages,
  removeImage,
  onValidityChange,
  t
}: {
  settings: ImageEmbeddingSettings;
  disabled: boolean;
  update: (patch: ImageEmbeddingSettingsPatch, debounce?: boolean) => void;
  uploadImages: (slot: ImageSlot, files: File[]) => Promise<void>;
  removeImage: (slot: ImageSlot, id: string) => Promise<void>;
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
  const [customStartMs, setCustomStartMs] = useState(() => String(settings.customStartDurationMs));
  useEffect(() => {
    setCustomStartMs(String(settings.customStartDurationMs));
  }, [settings.customStartDurationMs]);
  const parsedCustomStartMs = parseMillisecondsInput(customStartMs);
  const customStartMsValid = parsedCustomStartMs !== null;
  const finalDurationValid =
    !settings.endImages.length || settings.finalDurationMode !== 'custom' || customTimeValid;
  const startDurationValid =
    !settings.startImages.length || settings.startDurationMode !== 'custom' || customStartMsValid;
  useEffect(() => {
    onValidityChange(!settings.enabled || (finalDurationValid && startDurationValid));
  }, [settings.enabled, finalDurationValid, startDurationValid, onValidityChange]);

  const disabledIds = new Set(settings.disabledImageIds ?? []);
  const toggleImage = (id: string) => {
    const next = disabledIds.has(id)
      ? (settings.disabledImageIds ?? []).filter(item => item !== id)
      : [...(settings.disabledImageIds ?? []), id];
    update({ disabledImageIds: next });
  };

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
          <div className="embedding-settings-row">
<div className="field-group metadata-settings replace-existing-setting">
  <Checkbox
    className="feature-switch"
    checked={settings.replaceExisting}
    disabled={disabled}
    onChange={event => update({ replaceExisting: event.target.checked })}
    label={<strong>{t('replaceExistingImages')}</strong>}
  />
  <Tooltip label={t('replaceExistingImagesHint')}>{t('replaceExistingImagesHint')}</Tooltip>
</div>
<div className="field-group embedding-fit-row">
                  <FieldLabel label={t('frameFit')} tooltip={t('frameFitTooltip')} />
                  <div className="fit-mode-pictos" role="group" aria-label={t('frameFit')}>
                    {(
                      [
                        ['cover', t('fitCover'), <Crop key="c" size={ICON_SIZE} strokeWidth={ICON_STROKE} />],
                        [
                          'contain',
                          t('fitContain'),
                          <Minimize2 key="i" size={ICON_SIZE} strokeWidth={ICON_STROKE} />
                        ],
                        [
                          'stretch',
                          t('fitStretch'),
                          <UnfoldVertical key="s" size={ICON_SIZE} strokeWidth={ICON_STROKE} />
                        ]
                      ] as const
                    ).map(([value, label, icon]) => (
                      <button
                        key={value}
                        type="button"
                        className={settings.fitMode === value ? 'is-selected' : ''}
                        disabled={disabled}
                        data-tip={label}
                        aria-label={label}
                        aria-pressed={settings.fitMode === value}
                        onClick={() => update({ fitMode: value })}
                      >
                        {icon}
                      </button>
                    ))}
                  </div>
                  {settings.fitMode === 'stretch' && (
                    <span className="field-hint">{t('fitStretchWarning')}</span>
                  )}
                </div>


</div>
          <div className="image-columns">
            <ImageColumn
              slot="start"
              title={t('startImageTitle')}
              description={t('startImageDescription')}
              slotEnabled={settings.startEnabled !== false}
              onToggleSlot={() => update({ startEnabled: settings.startEnabled === false })}
              assets={settings.startImages}
              disabled={disabled}
              uploadImages={uploadImages}
              removeImage={removeImage}
              disabledIds={disabledIds}
              onToggleImage={toggleImage}
              t={t}
            >
              <div className="embedding-column-fields">
<div className="field-group start-duration-field">
                  <div className="start-duration-row">
                  <div className="fit-mode-pictos" role="group" aria-label={t('startImageDuration')}>
                    <button
                      type="button"
                      className={settings.startDurationMode === 'one-frame' ? 'is-selected' : ''}
                      disabled={disabled}
                      data-tip={t('startDurationOneFrame')}
                      aria-label={t('startDurationOneFrame')}
                      aria-pressed={settings.startDurationMode === 'one-frame'}
                      onClick={() => update({ startDurationMode: 'one-frame' })}
                    >
                      <ImageIcon size={20} strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      className={settings.startDurationMode !== 'one-frame' ? 'is-selected' : ''}
                      disabled={disabled}
                      data-tip={t('customDuration')}
                      aria-label={t('customDuration')}
                      aria-pressed={settings.startDurationMode !== 'one-frame'}
                      onClick={() => update({ startDurationMode: 'custom' })}
                    >
                      <Timer size={20} strokeWidth={1.75} />
                    </button>
                  </div>
                  {settings.startDurationMode === 'custom' && (
                    <>
                      <div className="custom-duration-input">
                        <input
                          className={`time-input ${customStartMs && !customStartMsValid ? 'is-invalid' : ''}`}
                          type="text"
                          inputMode="numeric"
                          placeholder="100"
                          value={customStartMs}
                          disabled={disabled}
                          aria-label={t('customStartDurationInput')}
                          aria-invalid={!customStartMsValid}
                          onChange={event => {
                            const value = event.target.value;
                            setCustomStartMs(value);
                            const ms = parseMillisecondsInput(value);
                            if (ms !== null) update({ customStartDurationMs: ms }, true);
                          }}
                        />
                        <span>{t('millisecondsUnit')}</span>
                      </div>
                      <Collapse fast open={!customStartMsValid}>
                        <span className="field-error">{t('invalidCustomStartDuration')}</span>
                      </Collapse>
                    </>
                  )}
                  </div>
                </div>
              </div>
            </ImageColumn>
            <ImageColumn
              slot="end"
              title={t('endImageTitle')}
              description={t('endImageDescription')}
              slotEnabled={settings.endEnabled !== false}
              onToggleSlot={() => update({ endEnabled: settings.endEnabled === false })}
              assets={settings.endImages}
              disabled={disabled}
              uploadImages={uploadImages}
              removeImage={removeImage}
              disabledIds={disabledIds}
              onToggleImage={toggleImage}
              t={t}
            >
              <div className="embedding-column-fields">
<div className="field-group final-duration-field">
                <div className="start-duration-row">
                  <div
                    className="fit-mode-pictos"
                    role="group"
                    aria-label={t('finalImageDuration')}
                  >
                    {(
                      [
                        ['random-30-40', t('randomDuration30To40'), '30–40'],
                        ['random-40-50', t('randomDuration40To50'), '40–50'],
                        ['random-50-60', t('randomDuration50To60'), '50–60']
                      ] as const
                    ).map(([value, label, range]) => (
                      <button
                        key={value}
                        type="button"
                        className={`is-labeled${settings.finalDurationMode === value ? ' is-selected' : ''}`}
                        disabled={disabled}
                        data-tip={label}
                        aria-label={label}
                        aria-pressed={settings.finalDurationMode === value}
                        onClick={() => update({ finalDurationMode: value })}
                      >
                        <Dices size={16} strokeWidth={1.75} />
                        <span>{range}</span>
                      </button>
                    ))}
                    <button
                      type="button"
                      className={settings.finalDurationMode === 'custom' ? 'is-selected' : ''}
                      disabled={disabled}
                      data-tip={t('customDuration')}
                      aria-label={t('customDuration')}
                      aria-pressed={settings.finalDurationMode === 'custom'}
                      onClick={() => update({ finalDurationMode: 'custom' })}
                    >
                      <Timer size={20} strokeWidth={1.75} />
                    </button>
                  </div>
                </div>

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
  slotEnabled,
  onToggleSlot,
  assets,
  disabled,
  uploadImages,
  removeImage,
  disabledIds,
  onToggleImage,
  children,
  t
}: {
  slotEnabled: boolean;
  onToggleSlot: () => void;
  slot: ImageSlot;
  title: string;
  description: string;
  assets: ImageAsset[];
  disabled: boolean;
  uploadImages: (slot: ImageSlot, files: File[]) => Promise<void>;
  removeImage: (slot: ImageSlot, id: string) => Promise<void>;
  disabledIds?: ReadonlySet<string>;
  onToggleImage?: (id: string) => void;
  t: Translate;
  children?: React.ReactNode;
}) {
  return (
    <section className="image-column" aria-label={title}>
      <div className="image-column-heading">
        <Checkbox
          className="feature-switch slot-feature-switch"
          checked={slotEnabled}
          aria-label={title}
          onChange={onToggleSlot}
          label={null}
        />
        <h3>{title}</h3>
        <Tooltip label={description}>{description}</Tooltip>
      </div>
      <Collapse open={slotEnabled}>
        <div className="image-column-body">
          {children}
          <ImageDropArea
            slot={slot}
            assets={assets}
            disabled={disabled}
            uploadImages={uploadImages}
            removeImage={removeImage}
            disabledIds={disabledIds}
            onToggleImage={onToggleImage}
            t={t}
          />
        </div>
      </Collapse>
    </section>
  );
}

export function ImageDropArea({
  slot,
  assets,
  disabled,
  uploadImages,
  removeImage,
  disabledIds,
  onToggleImage,
  t
}: {
  slot: ImageSlot;
  assets: ImageAsset[];
  disabled: boolean;
  uploadImages: (slot: ImageSlot, files: File[]) => Promise<void>;
  removeImage: (slot: ImageSlot, id: string) => Promise<void>;
  disabledIds?: ReadonlySet<string>;
  onToggleImage?: (id: string) => void;
  t: Translate;
}) {
  const input = useRef<HTMLInputElement>(null);
  // Scrolling is switched on only when the tiles actually overflow two rows,
  // so a short gallery never swallows the page's wheel events.
  const scrollHost = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  // Measured from the grid's own height against the host's two-row cap, so the
  // answer never depends on the state it is about to set — the earlier version
  // compared the host's scroll height with its client height, which stayed
  // equal once scrolling was on and left it stuck there.
  useLayoutEffect(() => {
    const host = scrollHost.current;
    const grid = host?.firstElementChild as HTMLElement | null;
    if (!host || !grid) return;
    const measure = () => {
      const cap = Number.parseFloat(getComputedStyle(host).maxHeight);
      if (!Number.isFinite(cap)) return;
      setScrollable(grid.getBoundingClientRect().height > cap + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    observer.observe(grid);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  });
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
      <div className={`image-grid-scroll ${scrollable ? 'is-scrollable' : ''}`.trim()} ref={scrollHost}>
        <div
          className={`image-grid ${dragging ? 'is-dragging' : ''} ${errorKey ? 'has-error' : ''}`}
          role="group"
          aria-label={slot === 'start' ? t('startImageTitle') : t('endImageTitle')}
        >
          {assets.map(asset => (
            <div
              className={`selected-image-tile ${
                disabledIds?.has(asset.id) ? 'is-inactive' : 'is-active'
              }`}
              key={asset.id}
              data-tip={
                disabledIds?.has(asset.id) ? t('imageInactiveHint') : t('imageActiveHint')
              }
              role={onToggleImage ? 'button' : undefined}
              tabIndex={onToggleImage && !disabled ? 0 : undefined}
              aria-pressed={onToggleImage ? !disabledIds?.has(asset.id) : undefined}
              onClick={() => {
                if (!disabled && onToggleImage) onToggleImage(asset.id);
              }}
              data-inactive-label={t('imageInactiveBadge')}
              onKeyDown={event => {
                if (!onToggleImage || disabled) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onToggleImage(asset.id);
                }
              }}
            >
              <AssetThumbnail id={asset.id} fileName={asset.fileName} />

              <IconButton
                className="selected-image-action is-delete"
                label={t('deleteImage')}
                disabled={disabled || busy}
                onClick={event => {
                  event.stopPropagation();
                  void remove(asset.id);
                }}
              >
                <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </IconButton>
              <span>
                {asset.width}×{asset.height}
              </span>
            </div>
          ))}
          <div
            className={`image-drop-zone image-add-tile ${disabled ? 'is-disabled' : ''}`}
            role="button"
            data-tip={`${t('addImage')} · ${t('imageFormats')}`}
            aria-label={t('addImage')}
            tabIndex={!disabled ? 0 : -1}
            aria-disabled={disabled}
            onClick={choose}
            onKeyDown={onKeyDown}
          >
            <div className="image-drop-message is-minimal">
              {busy ? <Spinner /> : <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
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

export function parseMillisecondsInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const milliseconds = Number(trimmed);
  return milliseconds >= MIN_CUSTOM_START_IMAGE_DURATION_MS &&
    milliseconds <= MAX_CUSTOM_START_IMAGE_DURATION_MS
    ? milliseconds
    : null;
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

/**
 * The thumbnail, fetched with a capability ticket rather than the session token.
 *
 * A ticket has to be asked for, so the URL arrives a moment after the row does.
 * Rendering nothing until then is what the component did anyway while the image
 * loaded — there is no new state here, only a slightly earlier one.
 */
function AssetThumbnail({ id, fileName }: { id: string; fileName: string }) {
  const url = useSubresourceUrl(imageContentPath(id));
  if (!url) return null;
  return <img src={url} alt={fileName} />;
}
