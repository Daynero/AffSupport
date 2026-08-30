import { useEffect, useState } from 'react';
import { Eraser, Files, Film, FolderOpen, Gauge, Gem, Grid3x3, Monitor, Sparkles, SlidersHorizontal, Timer } from 'lucide-react';
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
  return (
    <section className="settings-panel" aria-labelledby="settings-title">
      <div className="section-heading compact-heading">
        <h2 id="settings-title">{t('compressionSettings')}</h2>
      </div>
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
              title={t('optimal')}
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
              title={t('custom')}
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
          <FieldLabel label={t('metadata')} tooltip={t('stripMetadataTooltip')} />
          <div className="metadata-control">
            <div className="fit-mode-pictos is-single">
              <button
                type="button"
                role="switch"
                className={settings.stripMetadata ? 'is-selected' : ''}
                title={t('stripMetadata')}
                aria-label={t('stripMetadata')}
                aria-checked={settings.stripMetadata}
                disabled={disabled}
                onClick={() => updateSettings({ stripMetadata: !settings.stripMetadata })}
              >
                <Eraser size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </button>
            </div>
          </div>
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
        <FieldLabel label={t('rateControl')} tooltip={t('rateControlTooltip')} />
        <div className="start-duration-row">
        <div className="fit-mode-pictos" role="radiogroup" aria-label={t('rateControl')}>
          <button
            type="button"
            role="radio"
            className={rateMode === 'optimal' ? 'is-selected' : ''}
            title={t('optimal')}
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
            className={rateMode === 'crf' ? 'is-selected' : ''}
            title={t('constantQuality')}
            aria-label={t('constantQuality')}
            aria-checked={rateMode === 'crf'}
            disabled={disabled}
            onClick={() => {
              setRateMode('crf');
              updateSettings({ rateControl: 'crf' });
            }}
          >
            <Gem size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </button>
          <button
            type="button"
            role="radio"
            className={rateMode === 'bitrate' ? 'is-selected' : ''}
            title={t('targetBitrate')}
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
          <RateValueCrf settings={settings} disabled={disabled} updateSettings={updateSettings} t={t} />
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
            title={t('asOriginal')}
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
              title={`${value} FPS`}
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
            title={t('customValue')}
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
              className={`time-input ${!valid && custom ? 'is-invalid' : ''}`}
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
            title={t('asOriginal')}
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
              title={`${value}p`}
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
            title={t('customValue')}
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
              className={`time-input ${!valid && custom ? 'is-invalid' : ''}`}
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
  t
}: {
  settings: AgentSettings;
  disabled: boolean;
  updateSettings: UpdateSettings;
  t: Translate;
}) {
  const [value, setValue] = useState(String(settings.crf));
  useEffect(() => setValue(String(settings.crf)), [settings.crf]);
  const valid = isValidIntegerInput(value, CRF_MIN, CRF_MAX);
  const numeric = valid ? Number(value) : settings.crf;
  return (
    <>
      <span className="crf-edge crf-edge-quality" aria-hidden="true">
        <Gem size={14} strokeWidth={ICON_STROKE} />
      </span>
      <span className="crf-track-wrap">
        <input
          type="range"
          className="rate-slider crf-gradient"
          min={CRF_MIN}
          max={CRF_MAX}
          step={1}
          value={numeric}
          disabled={disabled}
          aria-label={t('crf')}
          title={t('crfTooltip')}
          onChange={event => {
            const next = event.target.value;
            setValue(next);
            updateSettings({ crf: Number(next) }, true);
          }}
        />
        <span
          className="crf-opt-mark"
          aria-hidden="true"
          style={{ left: `${((DEFAULT_CRF - CRF_MIN) / (CRF_MAX - CRF_MIN)) * 100}%` }}
        >
          <Sparkles size={12} strokeWidth={ICON_STROKE} />
        </span>
      </span>
      <span className="crf-edge crf-edge-pixel" aria-hidden="true">
        <Grid3x3 size={14} strokeWidth={ICON_STROKE} />
      </span>
      <div className="input-with-suffix">
        <input
          className={`time-input crf-input ${!valid && value !== '' ? 'is-invalid' : ''}`}
          type="number"
          inputMode="numeric"
          min={CRF_MIN}
          max={CRF_MAX}
          value={value}
          disabled={disabled}
          aria-label={t('crf')}
          aria-invalid={!valid && value !== ''}
          onChange={event => {
            const next = event.target.value;
            setValue(next);
            if (isValidIntegerInput(next, CRF_MIN, CRF_MAX)) {
              updateSettings({ crf: Number(next) }, true);
            }
          }}
        />
        <span>CRF</span>
      </div>
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
        title={t('bitrateTooltip')}
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
              title={t('nextToOriginals')}
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
              title={t('chooseFolder')}
              aria-label={t('chooseFolder')}
              aria-checked={settings.outputMode === 'chosen-folder'}
              disabled={disabled}
              onClick={chooseOutputFolder}
            >
              <FolderOpen size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
          </div>
          {settings.outputMode === 'chosen-folder' && (
            <span className="selected-folder" title={settings.outputFolder ?? t('noFolderSelected')}>
              {settings.outputFolder ? compactPath(settings.outputFolder) : t('noFolderSelected')}
            </span>
          )}
          <input
            className="time-input suffix-input"
            type="text"
            maxLength={60}
            placeholder="_compressed"
            title={t('outputSuffixLabel')}
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
