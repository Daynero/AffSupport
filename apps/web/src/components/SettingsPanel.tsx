import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Eraser, Settings as SettingsIcon, Files, Film, FolderOpen, Gauge, Gem, Monitor, Sparkles, SlidersHorizontal, Timer } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from './icons';
import {
  CRF_MAX,
  CRF_MIN,
  DEFAULT_CRF,
  FRAME_RATE_MAX,
  FRAME_RATE_MIN,
  RESOLUTION_MAX,
  RESOLUTION_MIN,
  VIDEO_BITRATE_MAX_KBPS,
  VIDEO_BITRATE_MIN_KBPS,
  type AgentSettings,
  type AgentSettingsPatch,
  type CompressionMode,
  type RateControl
} from '@video-compressor/shared';
import { compactPath } from '../format';
import { isValidIntegerInput } from '../queue-ui';
import { Button, Checkbox, Collapse, SegmentedControl, Tooltip, type Translate } from './ui';
import { ImageEmbeddingSection } from './ImageEmbeddingSection';

const FPS_OPTIONS = [24, 25, 30, 50, 60];
const RESOLUTION_OPTIONS = [2160, 1440, 1080, 720, 550];

type UpdateSettings = (patch: AgentSettingsPatch, debounce?: boolean) => void;

export function SettingsPanel({
  settings,
  disabled,
  updateSettings,
  chooseOutputFolder,
  uploadImages = async () => {},
  removeImage = async () => {},
  onEmbeddingValidityChange = () => {},
  t
}: {
  settings: AgentSettings;
  disabled: boolean;
  updateSettings: UpdateSettings;
  chooseOutputFolder: () => void;
  uploadImages?: (slot: 'start' | 'end', files: File[]) => Promise<void>;
  removeImage?: (slot: 'start' | 'end', id: string) => Promise<void>;
  imageUrl?: (id: string) => string;
  onEmbeddingValidityChange?: (valid: boolean) => void;
  t: Translate;
}) {
  // The whole panel folds down to its title line so the file list can own
  // the screen once the settings are set.
  const [open, setOpen] = useState(true);
  return (
    <section
      className={`settings-panel ${open ? '' : 'is-collapsed'}`.trim()}
      aria-labelledby="settings-title"
    >
      {/* The whole header is the toggle: gear and title on the left, the
          current choices in the middle (only while collapsed, so they never
          duplicate the controls below), chevron in the corner. */}
      <button
        type="button"
        className="settings-collapse section-heading compact-heading"
        aria-expanded={open}
        aria-controls="settings-body"
        onClick={() => setOpen(current => !current)}
      >
        <SettingsIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <h2 id="settings-title">{t('compressionSettings')}</h2>
        {!open && (
          <span className="settings-summary">
            <span>
              <span className="settings-summary-key">{t('settingsSummaryPreset')}</span>
              {settings.mode === 'optimal' ? t('optimal') : t('custom')}
            </span>
            <span>
              <span className="settings-summary-key">{t('settingsSummaryResolution')}</span>
              {settings.resolutionLimit
                ? `${settings.resolutionLimit}p`
                : t('settingsSummaryOriginal')}
            </span>
            <span>
              <span className="settings-summary-key">{t('settingsSummaryFps')}</span>
              {settings.frameRate ?? t('settingsSummaryOriginal')}
            </span>
            <span>
              <span className="settings-summary-key">{t('settingsSummaryQuality')}</span>
              {settings.rateControl === 'crf'
                ? `CRF ${settings.crf}`
                : `${settings.videoBitrateKbps} kbps`}
            </span>
          </span>
        )}
        <ChevronDown
          size={ICON_SIZE}
          strokeWidth={ICON_STROKE}
          className={`settings-chevron ${open ? '' : 'is-rotated'}`.trim()}
          aria-hidden="true"
        />
      </button>
      <div id="settings-body" className="settings-body" hidden={!open}>
      <div className="settings-primary-row">
        <div className="field-group">
          <FieldLabel
            label={t('compressionMode')}
            tooltip={settings.mode === 'optimal' ? t('optimalTooltip') : undefined}
          />
          <div className="fit-mode-pictos" role="radiogroup" aria-label={t('compressionMode')}>
            <button
              type="button"
              className={settings.mode === 'optimal' ? 'is-selected' : ''}
              data-tip={t('optimal')}
              aria-label={t('optimal')}
              aria-checked={settings.mode === 'optimal'}
              role="radio"
              disabled={disabled}
              onClick={() => updateSettings({ mode: 'optimal' })}
            >
              <Sparkles size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={settings.mode === 'custom' ? 'is-selected' : ''}
              data-tip={t('custom')}
              aria-label={t('custom')}
              aria-checked={settings.mode === 'custom'}
              role="radio"
              disabled={disabled}
              onClick={() => updateSettings({ mode: 'custom' })}
            >
              <SlidersHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
          </div>
          {settings.mode === 'optimal' && (
            <span className="optimal-summary">{t('optimalSummary')}</span>
          )}
        </div>
        <OutputSettings
          settings={settings}
          disabled={disabled}
          updateSettings={updateSettings}
          chooseOutputFolder={chooseOutputFolder}
          t={t}
        />
        <div className="field-group metadata-settings">
          <Checkbox
            className="feature-switch"
            checked={settings.stripMetadata}
            disabled={disabled}
            onChange={event => updateSettings({ stripMetadata: event.target.checked })}
            label={<strong>{t('stripMetadata')}</strong>}
          />
          <Tooltip label={t('stripMetadataTooltip')}>{t('stripMetadataTooltip')}</Tooltip>
        </div>
      </div>
      <div className="mode-detail">
        <Collapse open={settings.mode === 'custom'}>
          <CustomSettings
            settings={settings}
            disabled={disabled || settings.mode !== 'custom'}
            updateSettings={updateSettings}
            t={t}
          />
        </Collapse>
      </div>
      <ImageEmbeddingSection
        settings={settings.imageEmbedding}
        disabled={disabled}
        update={(patch, debounce) => updateSettings({ imageEmbedding: patch }, debounce)}
        uploadImages={uploadImages}
        removeImage={removeImage}
        onValidityChange={onEmbeddingValidityChange}
        t={t}
      />
      </div>
    </section>
  );
}

function CustomSettings({
  settings,
  disabled,
  updateSettings,
  t
}: {
  settings: AgentSettings;
  disabled: boolean;
  updateSettings: UpdateSettings;
  t: Translate;
}) {
  // 'Оптимальний' is the CRF preset (DEFAULT_CRF); picking Gem keeps the
  // custom CRF editable even when its value happens to equal the preset.
  // While the CRF slider is being dragged the gem button grows 30% and
  // repaints from the live value instead of the debounced setting.
  const [crfDrag, setCrfDrag] = useState<number | null>(null);
  useEffect(() => {
    if (crfDrag === null) return;
    const release = () => setCrfDrag(null);
    // Pointer release ends the zoom; the idle timer catches every other way
    // a drag can end (keyboard arrows, focus loss, synthetic events).
    const idle = window.setTimeout(release, 800);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.clearTimeout(idle);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, [crfDrag]);
  const [rateMode, setRateMode] = useState<'optimal' | 'crf' | 'bitrate'>(
    settings.rateControl === 'bitrate'
      ? 'bitrate'
      : settings.crf === DEFAULT_CRF
        ? 'optimal'
        : 'crf'
  );

  return (
    <div className="custom-settings">
      <FpsControl settings={settings} disabled={disabled} updateSettings={updateSettings} t={t} />
      <ResolutionControl
        settings={settings}
        disabled={disabled}
        updateSettings={updateSettings}
        t={t}
      />
      <div className="field-group rate-control-field custom-column-primary">
        <FieldLabel label={t('rateControl')} />
        <div className="start-duration-row">
        <div className="fit-mode-pictos" role="radiogroup" aria-label={t('rateControl')}>
          <button
            type="button"
            role="radio"
            className={rateMode === 'optimal' ? 'is-selected' : ''}
            data-tip={t('optimal')}
            aria-label={t('optimal')}
            aria-checked={rateMode === 'optimal'}
            disabled={disabled}
            onClick={() => {
              setRateMode('optimal');
              updateSettings({ rateControl: 'crf', crf: DEFAULT_CRF });
            }}
          >
            <Sparkles size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </button>
          <button
            type="button"
            role="radio"
            className={`${rateMode === 'crf' ? 'is-selected' : ''} ${crfDrag !== null ? 'is-zoomed' : ''}`.trim()}
            data-tip={t('constantQuality')}
            aria-label={t('constantQuality')}
            aria-checked={rateMode === 'crf'}
            disabled={disabled}
            onClick={() => {
              setRateMode('crf');
              updateSettings({ rateControl: 'crf' });
            }}
          >
            <PixelGem crf={crfDrag ?? settings.crf} selected={rateMode === 'crf'} />
          </button>
          <button
            type="button"
            role="radio"
            className={rateMode === 'bitrate' ? 'is-selected' : ''}
            data-tip={t('targetBitrate')}
            aria-label={t('targetBitrate')}
            aria-checked={rateMode === 'bitrate'}
            disabled={disabled}
            onClick={() => {
              setRateMode('bitrate');
              updateSettings({ rateControl: 'bitrate' });
            }}
          >
            <Gauge size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </button>
        </div>
        {rateMode === 'optimal' ? (
          <span className="rate-optimal-note">CRF {DEFAULT_CRF}</span>
        ) : rateMode === 'crf' ? (
          <RateValueCrf
            settings={settings}
            disabled={disabled}
            updateSettings={updateSettings}
            onDrag={setCrfDrag}
            t={t}
          />
        ) : (
          <RateValueBitrate settings={settings} disabled={disabled} updateSettings={updateSettings} t={t} />
        )}
        </div>
      </div>
    </div>
  );
}

function FpsControl({
  settings,
  disabled,
  updateSettings,
  t
}: {
  settings: AgentSettings;
  disabled: boolean;
  updateSettings: UpdateSettings;
  t: Translate;
}) {
  const initialChoice = fpsChoice(settings.frameRate);
  const [choice, setChoice] = useState(initialChoice);
  const [custom, setCustom] = useState(
    initialChoice === 'custom' && settings.frameRate ? String(settings.frameRate) : ''
  );
  useEffect(() => {
    const next = fpsChoice(settings.frameRate);
    setChoice(next);
    if (next === 'custom' && settings.frameRate) setCustom(String(settings.frameRate));
  }, [settings.frameRate]);
  const valid = isValidIntegerInput(custom, FRAME_RATE_MIN, FRAME_RATE_MAX);

  return (
    <div className="field-group custom-column-primary">
      <FieldLabel label={t('frameRate')} tooltip={t('frameRateTooltip')} />
      <div className="start-duration-row">
        <div className="fit-mode-pictos" role="radiogroup" aria-label={t('frameRate')}>
          <button
            type="button"
            role="radio"
            className={choice === 'original' ? 'is-selected' : ''}
            data-tip={t('asOriginal')}
            aria-label={t('asOriginal')}
            aria-checked={choice === 'original'}
            disabled={disabled}
            onClick={() => {
              setChoice('original');
              updateSettings({ frameRate: null });
            }}
          >
            <Film size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </button>
          {[24, 30, 60].map(value => (
            <button
              key={value}
              type="button"
              role="radio"
              className={`is-labeled ${choice === String(value) ? 'is-selected' : ''}`}
              data-tip={`${value} FPS`}
              aria-label={`${value} FPS`}
              aria-checked={choice === String(value)}
              disabled={disabled}
              onClick={() => {
                setChoice(String(value));
                updateSettings({ frameRate: value });
              }}
            >
              {value}
            </button>
          ))}
          <button
            type="button"
            role="radio"
            className={choice === 'custom' ? 'is-selected' : ''}
            data-tip={t('customValue')}
            aria-label={t('customValue')}
            aria-checked={choice === 'custom'}
            disabled={disabled}
            onClick={() => {
              setChoice('custom');
              setCustom('');
            }}
          >
            <Timer size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </button>
        </div>
        {choice === 'custom' && (
          <div className="input-with-suffix">
            <input
              className={`time-input fps-input ${!valid && custom ? 'is-invalid' : ''}`}
              type="number"
              inputMode="numeric"
              min={FRAME_RATE_MIN}
              max={FRAME_RATE_MAX}
              value={custom}
              disabled={disabled}
              aria-label={t('customFps')}
              aria-invalid={!valid && custom !== ''}
              onChange={event => {
                const value = event.target.value;
                setCustom(value);
                if (isValidIntegerInput(value, FRAME_RATE_MIN, FRAME_RATE_MAX)) {
                  updateSettings({ frameRate: Number(value) }, true);
                }
              }}
            />
            <span>fps</span>
          </div>
        )}
      </div>
      <Collapse fast open={choice === 'custom' && !valid && custom !== ''}>
        <span className="field-error">
          {t('invalidFrameRate', { min: FRAME_RATE_MIN, max: FRAME_RATE_MAX })}
        </span>
      </Collapse>
    </div>
  );
}

function ResolutionControl({
  settings,
  disabled,
  updateSettings,
  t
}: {
  settings: AgentSettings;
  disabled: boolean;
  updateSettings: UpdateSettings;
  t: Translate;
}) {
  const initialChoice = resolutionChoice(settings.resolutionLimit);
  const [choice, setChoice] = useState(initialChoice);
  const [custom, setCustom] = useState(
    initialChoice === 'custom' && settings.resolutionLimit ? String(settings.resolutionLimit) : ''
  );
  useEffect(() => {
    const next = resolutionChoice(settings.resolutionLimit);
    setChoice(next);
    if (next === 'custom' && settings.resolutionLimit) setCustom(String(settings.resolutionLimit));
  }, [settings.resolutionLimit]);
  const valid = isValidIntegerInput(custom, RESOLUTION_MIN, RESOLUTION_MAX);

  return (
    <div className="field-group custom-column-secondary">
      <FieldLabel label={t('resolution')} tooltip={t('resolutionTooltip')} />
      <div className="start-duration-row">
        <div className="fit-mode-pictos" role="radiogroup" aria-label={t('resolution')}>
          <button
            type="button"
            role="radio"
            className={choice === 'original' ? 'is-selected' : ''}
            data-tip={t('asOriginal')}
            aria-label={t('asOriginal')}
            aria-checked={choice === 'original'}
            disabled={disabled}
            onClick={() => {
              setChoice('original');
              updateSettings({ resolutionLimit: null });
            }}
          >
            <Monitor size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </button>
          {[720, 1080].map(value => (
            <button
              key={value}
              type="button"
              role="radio"
              className={`is-labeled ${choice === String(value) ? 'is-selected' : ''}`}
              data-tip={`${value}p`}
              aria-label={`${value}p`}
              aria-checked={choice === String(value)}
              disabled={disabled}
              onClick={() => {
                setChoice(String(value));
                updateSettings({ resolutionLimit: value });
              }}
            >
              {value}p
            </button>
          ))}
          <button
            type="button"
            role="radio"
            className={choice === 'custom' ? 'is-selected' : ''}
            data-tip={t('customValue')}
            aria-label={t('customValue')}
            aria-checked={choice === 'custom'}
            disabled={disabled}
            onClick={() => {
              setChoice('custom');
              setCustom('');
            }}
          >
            <Timer size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </button>
        </div>
        {choice === 'custom' && (
          <div className="input-with-suffix">
            <input
              className={`time-input res-input ${!valid && custom ? 'is-invalid' : ''}`}
              type="number"
              inputMode="numeric"
              min={RESOLUTION_MIN}
              max={RESOLUTION_MAX}
              value={custom}
              disabled={disabled}
              aria-label={t('customResolution')}
              aria-invalid={!valid}
              onChange={event => {
                const value = event.target.value;
                setCustom(value);
                if (isValidIntegerInput(value, RESOLUTION_MIN, RESOLUTION_MAX)) {
                  updateSettings({ resolutionLimit: Number(value) }, true);
                }
              }}
            />
            <span>px</span>
          </div>
        )}
      </div>
      <Collapse fast open={choice === 'custom' && !valid && custom !== ''}>
        <span className="field-error">
          {t('invalidResolution', { min: RESOLUTION_MIN, max: RESOLUTION_MAX })}
        </span>
      </Collapse>
    </div>
  );
}

function RateValueCrf({
  settings,
  disabled,
  updateSettings,
  onDrag,
  t
}: {
  settings: AgentSettings;
  disabled: boolean;
  updateSettings: UpdateSettings;
  onDrag: (value: number | null) => void;
  t: Translate;
}) {
  // Local value keeps the thumb glued to the pointer; the settings update
  // itself is debounced behind it.
  const [value, setValue] = useState(settings.crf);
  useEffect(() => setValue(settings.crf), [settings.crf]);
  return (
    <>
      <span className="crf-track-wrap">
        <input
          type="range"
          className="rate-slider crf-gradient"
          min={CRF_MIN}
          max={CRF_MAX}
          step={1}
          value={value}
          disabled={disabled}
          aria-label={t('crf')}
          data-tip={t('crfTooltip')}
          onPointerDown={event => onDrag(Number((event.target as HTMLInputElement).value))}
          onChange={event => {
            const next = Number(event.target.value);
            setValue(next);
            onDrag(next);
            updateSettings({ crf: next }, true);
          }}
        />
      </span>
      <span className="rate-optimal-note">CRF {value}</span>
    </>
  );
}

/**
 * The diamond that falls apart: the Gem icon is rasterized through a tiny
 * canvas whose sample size shrinks as CRF grows, so dragging the slider
 * visibly pixelates the crystal on the button itself.
 */
function PixelGem({ crf, selected }: { crf: number; selected: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hiddenRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const svg = hiddenRef.current?.querySelector('svg');
    if (!canvas || !svg) return;
    const color = getComputedStyle(canvas).color;
    const markup = svg.outerHTML.replaceAll('currentColor', color);
    const img = new Image();
    img.onload = () => {
      const context = canvas.getContext('2d');
      if (!context) return;
      const SIZE = 40;
      const ratio = (crf - CRF_MIN) / (CRF_MAX - CRF_MIN);
      const sample = Math.max(5, Math.round(SIZE - ratio * (SIZE - 5)));
      const tmp = document.createElement('canvas');
      tmp.width = sample;
      tmp.height = sample;
      const tmpContext = tmp.getContext('2d');
      if (!tmpContext) return;
      tmpContext.drawImage(img, 0, 0, sample, sample);
      context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, SIZE, SIZE);
      context.drawImage(tmp, 0, 0, SIZE, SIZE);
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  }, [crf, selected]);
  return (
    <>
      <span ref={hiddenRef} style={{ display: 'none' }} aria-hidden="true">
        <Gem size={ICON_SIZE} strokeWidth={ICON_STROKE} />
      </span>
      <canvas ref={canvasRef} className="pixel-gem" width={40} height={40} aria-hidden="true" />
    </>
  );
}

function RateValueBitrate({
  settings,
  disabled,
  updateSettings,
  t
}: {
  settings: AgentSettings;
  disabled: boolean;
  updateSettings: UpdateSettings;
  t: Translate;
}) {
  const [value, setValue] = useState(String(settings.videoBitrateKbps));
  useEffect(() => setValue(String(settings.videoBitrateKbps)), [settings.videoBitrateKbps]);
  const valid = isValidIntegerInput(value, VIDEO_BITRATE_MIN_KBPS, VIDEO_BITRATE_MAX_KBPS);
  return (
    <div className="input-with-suffix">
      <input
        className={`time-input ${!valid && value !== '' ? 'is-invalid' : ''}`}
        type="number"
        inputMode="numeric"
        min={VIDEO_BITRATE_MIN_KBPS}
        max={VIDEO_BITRATE_MAX_KBPS}
        value={value}
        disabled={disabled}
        aria-label={t('videoBitrate')}
        data-tip={t('bitrateTooltip')}
        aria-invalid={!valid && value !== ''}
        onChange={event => {
          const next = event.target.value;
          setValue(next);
          if (isValidIntegerInput(next, VIDEO_BITRATE_MIN_KBPS, VIDEO_BITRATE_MAX_KBPS)) {
            updateSettings({ videoBitrateKbps: Number(next) }, true);
          }
        }}
      />
      <span>kbps</span>
    </div>
  );
}

function OutputSettings({
  settings,
  disabled,
  updateSettings,
  chooseOutputFolder,
  t
}: {
  settings: AgentSettings;
  disabled: boolean;
  updateSettings: UpdateSettings;
  chooseOutputFolder: () => void;
  t: Translate;
}) {
  return (
    <div className="output-settings">
      <div className="field-group">
        <FieldLabel label={t('saveResults')} tooltip={t('saveTooltip')} />
        <div className="output-control-row">
          <div className="fit-mode-pictos" role="radiogroup" aria-label={t('saveResults')}>
            <button
              type="button"
              role="radio"
              className={settings.outputMode === 'next-to-originals' ? 'is-selected' : ''}
              data-tip={t('nextToOriginals')}
              aria-label={t('nextToOriginals')}
              aria-checked={settings.outputMode === 'next-to-originals'}
              disabled={disabled}
              onClick={() => updateSettings({ outputMode: 'next-to-originals' })}
            >
              <Files size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
            <button
              type="button"
              role="radio"
              className={settings.outputMode === 'chosen-folder' ? 'is-selected' : ''}
              data-tip={t('chooseFolder')}
              aria-label={t('chooseFolder')}
              aria-checked={settings.outputMode === 'chosen-folder'}
              disabled={disabled}
              onClick={chooseOutputFolder}
            >
              <FolderOpen size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
          </div>
          {settings.outputMode === 'chosen-folder' && (
            <span className="selected-folder" data-tip={settings.outputFolder ?? t('noFolderSelected')}>
              {settings.outputFolder ? compactPath(settings.outputFolder) : t('noFolderSelected')}
            </span>
          )}
          <input
            className="time-input suffix-input"
            type="text"
            maxLength={60}
            placeholder="_compressed"
            data-tip={t('outputSuffixLabel')}
            aria-label={t('outputSuffixLabel')}
            value={settings.outputSuffix ?? ''}
            disabled={disabled}
            onChange={event => updateSettings({ outputSuffix: event.target.value }, true)}
          />
        </div>
      </div>
    </div>
  );
}

function FieldLabel({ label, tooltip }: { label: string; tooltip?: string }) {
  return (
    <div className="field-label">
      <span>{label}</span>
      {tooltip && <Tooltip label={tooltip}>{tooltip}</Tooltip>}
    </div>
  );
}

function fpsChoice(value: number | null) {
  if (value === null) return 'original';
  return FPS_OPTIONS.includes(value) ? String(value) : 'custom';
}

function resolutionChoice(value: number | null) {
  if (value === null) return 'original';
  return RESOLUTION_OPTIONS.includes(value) ? String(value) : 'custom';
}
