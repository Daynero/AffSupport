import { useEffect, useState } from 'react';
import {
  CRF_MAX,
  CRF_MIN,
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
import { Button, Collapse, SegmentedControl, Tooltip, type Translate } from './ui';
import { ImageEmbeddingSection } from './ImageEmbeddingSection';

const FPS_OPTIONS = [24, 25, 30, 50, 60];
const RESOLUTION_OPTIONS = [2160, 1440, 1080, 720, 550];

type UpdateSettings = (patch: AgentSettingsPatch, debounce?: boolean) => void;

export function SettingsPanel({
  settings,
  disabled,
  updateSettings,
  chooseOutputFolder,
  uploadImage = async () => {},
  removeImage = async () => {},
  imageUrl = () => '',
  onEmbeddingValidityChange = () => {},
  t
}: {
  settings: AgentSettings;
  disabled: boolean;
  updateSettings: UpdateSettings;
  chooseOutputFolder: () => void;
  uploadImage?: (slot: 'start' | 'end', file: File) => Promise<void>;
  removeImage?: (slot: 'start' | 'end') => Promise<void>;
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
          <FieldLabel label={t('compressionMode')} />
          <div className="control-with-help">
            <SegmentedControl<CompressionMode>
              label={t('compressionMode')}
              value={settings.mode}
              disabled={disabled}
              options={[
                { value: 'optimal', label: t('optimal') },
                { value: 'custom', label: t('custom') }
              ]}
              onChange={mode => updateSettings({ mode })}
            />
            {settings.mode === 'optimal' && (
              <Tooltip label={t('optimalTooltip')}>{t('optimalTooltip')}</Tooltip>
            )}
          </div>
        </div>
        <OutputSettings
          settings={settings}
          disabled={disabled}
          updateSettings={updateSettings}
          chooseOutputFolder={chooseOutputFolder}
          t={t}
        />
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
        uploadImage={uploadImage}
        removeImage={removeImage}
        imageUrl={imageUrl}
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
  return (
    <div className="custom-settings">
      <FpsControl settings={settings} disabled={disabled} updateSettings={updateSettings} t={t} />
      <ResolutionControl
        settings={settings}
        disabled={disabled}
        updateSettings={updateSettings}
        t={t}
      />
      <div className="field-group rate-control-field">
        <FieldLabel label={t('rateControl')} tooltip={t('rateControlTooltip')} />
        <SegmentedControl<RateControl>
          label={t('rateControl')}
          value={settings.rateControl}
          disabled={disabled}
          options={[
            { value: 'crf', label: t('constantQuality') },
            { value: 'bitrate', label: t('targetBitrate') }
          ]}
          onChange={rateControl => updateSettings({ rateControl })}
        />
      </div>
      <div className="rate-value-field">
        <Collapse open={settings.rateControl === 'crf'}>
          <CrfControl
            settings={settings}
            disabled={disabled || settings.rateControl !== 'crf'}
            updateSettings={updateSettings}
            t={t}
          />
        </Collapse>
        <Collapse open={settings.rateControl === 'bitrate'}>
          <BitrateControl
            settings={settings}
            disabled={disabled || settings.rateControl !== 'bitrate'}
            updateSettings={updateSettings}
            t={t}
          />
        </Collapse>
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
    <div className="field-group">
      <FieldLabel label={t('frameRate')} tooltip={t('frameRateTooltip')} />
      <div className="compound-control">
        <select
          value={choice}
          disabled={disabled}
          aria-label={t('frameRate')}
          onChange={event => {
            const value = event.target.value;
            setChoice(value);
            if (value === 'original') updateSettings({ frameRate: null });
            else if (value !== 'custom') updateSettings({ frameRate: Number(value) });
            else setCustom('');
          }}
        >
          <option value="original">{t('asOriginal')}</option>
          {FPS_OPTIONS.map(value => (
            <option value={value} key={value}>
              {value} FPS
            </option>
          ))}
          <option value="custom">{t('customValue')}</option>
        </select>
        {choice === 'custom' && (
          <input
            className={!valid && custom ? 'is-invalid' : ''}
            type="number"
            inputMode="numeric"
            min={FRAME_RATE_MIN}
            max={FRAME_RATE_MAX}
            value={custom}
            disabled={disabled}
            aria-label={t('customFps')}
            aria-invalid={!valid}
            onChange={event => {
              const value = event.target.value;
              setCustom(value);
              if (isValidIntegerInput(value, FRAME_RATE_MIN, FRAME_RATE_MAX)) {
                updateSettings({ frameRate: Number(value) }, true);
              }
            }}
          />
        )}
      </div>
      <Collapse fast open={choice === 'custom' && !valid}>
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
    <div className="field-group">
      <FieldLabel label={t('resolution')} tooltip={t('resolutionTooltip')} />
      <div className="compound-control">
        <select
          value={choice}
          disabled={disabled}
          aria-label={t('resolution')}
          onChange={event => {
            const value = event.target.value;
            setChoice(value);
            if (value === 'original') updateSettings({ resolutionLimit: null });
            else if (value !== 'custom') updateSettings({ resolutionLimit: Number(value) });
            else setCustom('');
          }}
        >
          <option value="original">{t('asOriginal')}</option>
          {RESOLUTION_OPTIONS.map(value => (
            <option value={value} key={value}>
              {value}p
            </option>
          ))}
          <option value="custom">{t('customValue')}</option>
        </select>
        {choice === 'custom' && (
          <div className="input-with-suffix">
            <input
              className={!valid && custom ? 'is-invalid' : ''}
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
      <Collapse fast open={choice === 'custom' && !valid}>
        <span className="field-error">
          {t('invalidResolution', { min: RESOLUTION_MIN, max: RESOLUTION_MAX })}
        </span>
      </Collapse>
    </div>
  );
}

function CrfControl({
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
    <div className="field-group">
      <FieldLabel label={t('crf')} tooltip={t('crfTooltip')} />
      <div className="range-number-control">
        <input
          type="range"
          min={CRF_MIN}
          max={CRF_MAX}
          step={1}
          value={numeric}
          disabled={disabled}
          aria-label={t('crf')}
          onChange={event => {
            const next = event.target.value;
            setValue(next);
            updateSettings({ crf: Number(next) }, true);
          }}
        />
        <input
          className={!valid ? 'is-invalid' : ''}
          type="number"
          inputMode="numeric"
          min={CRF_MIN}
          max={CRF_MAX}
          value={value}
          disabled={disabled}
          aria-label={t('crf')}
          aria-invalid={!valid}
          onChange={event => {
            const next = event.target.value;
            setValue(next);
            if (isValidIntegerInput(next, CRF_MIN, CRF_MAX)) {
              updateSettings({ crf: Number(next) }, true);
            }
          }}
        />
      </div>
      <Collapse fast open={!valid}>
        <span className="field-error">{t('invalidCrf', { min: CRF_MIN, max: CRF_MAX })}</span>
      </Collapse>
    </div>
  );
}

function BitrateControl({
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
    <div className="field-group">
      <FieldLabel label={t('bitrate')} tooltip={t('bitrateTooltip')} />
      <div className="input-with-suffix bitrate-control">
        <input
          className={!valid ? 'is-invalid' : ''}
          type="number"
          inputMode="numeric"
          min={VIDEO_BITRATE_MIN_KBPS}
          max={VIDEO_BITRATE_MAX_KBPS}
          value={value}
          disabled={disabled}
          aria-label={t('bitrate')}
          aria-invalid={!valid}
          onChange={event => {
            const next = event.target.value;
            setValue(next);
            if (isValidIntegerInput(next, VIDEO_BITRATE_MIN_KBPS, VIDEO_BITRATE_MAX_KBPS)) {
              updateSettings({ videoBitrateKbps: Number(next) }, true);
            }
          }}
        />
        <span>{t('bitrateUnit')}</span>
      </div>
      <Collapse fast open={!valid}>
        <span className="field-error">
          {t('invalidBitrate', {
            min: VIDEO_BITRATE_MIN_KBPS,
            max: VIDEO_BITRATE_MAX_KBPS
          })}
        </span>
      </Collapse>
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
          <SegmentedControl<'next-to-originals' | 'chosen-folder'>
            label={t('saveResults')}
            value={settings.outputMode}
            disabled={disabled}
            options={[
              { value: 'next-to-originals', label: t('nextToOriginals') },
              { value: 'chosen-folder', label: t('chooseFolder') }
            ]}
            onChange={value => {
              if (value === 'chosen-folder') chooseOutputFolder();
              else updateSettings({ outputMode: value });
            }}
          />
          {settings.outputMode === 'chosen-folder' && (
            <Button variant="ghost" disabled={disabled} onClick={chooseOutputFolder}>
              {t('selectFolder')}
            </Button>
          )}
        </div>
        {settings.outputMode === 'chosen-folder' && (
          <span className="selected-folder" title={settings.outputFolder ?? t('noFolderSelected')}>
            {settings.outputFolder ? compactPath(settings.outputFolder) : t('noFolderSelected')}
          </span>
        )}
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
