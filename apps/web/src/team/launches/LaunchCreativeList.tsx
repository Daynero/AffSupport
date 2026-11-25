import { useId, useState, type KeyboardEvent } from 'react';
import { ImageIcon, Play, RotateCcw, X } from 'lucide-react';
import {
  LAUNCH_CREATIVE_LABEL_MAX,
  launchCreativeLabelInput,
  type LaunchCreativeKind
} from '@video-compressor/shared';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons.js';
import {
  Button,
  FormField,
  IconButton,
  Input,
  Slider,
  Tooltip
} from '../../components/ui/index.js';
import { useI18n } from '../../i18n.js';

const PAGE_STEP = 10;
/** Characters of a long creative name always shown at its end. */
const NAME_TAIL = 4;

export function LaunchCreativeThumbnail({
  thumbnailUrl,
  kind,
  disabled,
  label,
  onPreview
}: {
  thumbnailUrl: string | null;
  kind: LaunchCreativeKind | null;
  disabled: boolean;
  /** The button's name where several thumbnails stand together. */
  label?: string;
  onPreview: () => void;
}) {
  const { t } = useI18n();
  const [broken, setBroken] = useState<string | null>(null);
  return (
    <Button
      className="launch-creative-thumbnail"
      variant="ghost"
      disabled={disabled}
      aria-label={label ?? t('launchesPreviewCreative')}
      onClick={onPreview}
    >
      {thumbnailUrl && broken !== thumbnailUrl ? (
        <img src={thumbnailUrl} alt="" onError={() => setBroken(thumbnailUrl)} />
      ) : (
        <ImageIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      )}
      {kind !== 'image' && (
        <span className="launch-creative-play">
          <Play size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </span>
      )}
    </Button>
  );
}

/**
 * 062: one creative of a catalog Launch — its thumbnail opens the preview, its
 * name (from the file, not typed) shows short with the whole name on hover, and
 * its share of the products is set right here: a slider and a number. The cross
 * removes it and its products go back to the others.
 */
export function LaunchCreativeShareRow({
  alias,
  kind,
  thumbnailUrl,
  copies,
  max,
  shared,
  disabled,
  onPreview,
  onDrag,
  onType,
  onRemove
}: {
  alias: string;
  kind: LaunchCreativeKind | null;
  thumbnailUrl: string | null;
  copies: number;
  /** The largest share while every other creative keeps one product. */
  max: number;
  /** With one creative it holds every product: no slider, no number. */
  shared: boolean;
  disabled: boolean;
  onPreview: () => void;
  onDrag: (value: number) => void;
  onType: (value: number) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const label = t('launchDistributionCopiesFor', { name: alias });
  const pageKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'PageUp' && event.key !== 'PageDown') return;
    event.preventDefault();
    onDrag(copies + (event.key === 'PageUp' ? PAGE_STEP : -PAGE_STEP));
  };
  return (
    <li className="launch-creative-share-row flex min-w-0 items-center gap-3">
      <LaunchCreativeThumbnail
        thumbnailUrl={thumbnailUrl}
        kind={kind}
        disabled={disabled}
        onPreview={onPreview}
      />
      {/* The free width of the row is the name's. Creatives of one batch share a beginning
          ("qa-multi-1", "qa-multi-2"), so a cut name keeps its end: "qa-mu…ti-1". */}
      <div className="launch-creative-share-name flex min-w-14 flex-1 items-center self-stretch">
        <Tooltip label={alias} asChild>
          <span tabIndex={0} className="flex min-w-0 items-center text-caption text-ink-muted">
            {alias.length > NAME_TAIL * 2 ? (
              <>
                <span className="min-w-0 truncate">{alias.slice(0, -NAME_TAIL)}</span>
                <span className="shrink-0">{alias.slice(-NAME_TAIL)}</span>
              </>
            ) : (
              <span className="min-w-0 truncate">{alias}</span>
            )}
          </span>
        </Tooltip>
      </div>
      {shared && (
        <>
          <div className="launch-creative-share-slider w-32 shrink-0">
            <Slider
              size="lg"
              aria-label={label}
              min={1}
              max={Math.max(1, max)}
              step={1}
              value={copies}
              disabled={disabled || max <= 1}
              onKeyDown={pageKeys}
              onChange={onDrag}
            />
          </div>
          <Input
            aria-label={label}
            type="number"
            width="narrow"
            className="launch-creative-share-count"
            min={1}
            max={max}
            value={copies}
            disabled={disabled}
            onChange={event => {
              const value = Number(event.target.value);
              if (Number.isFinite(value) && value >= 1) onType(value);
            }}
          />
        </>
      )}
      <IconButton
        className="launch-creative-share-remove ml-auto"
        label={t('launchCreativeRemoveOf', { name: alias || t('launchesCreative') })}
        disabled={disabled}
        onClick={onRemove}
      >
        <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>
    </li>
  );
}

/**
 * The single creative of a Launch without a catalog: thumbnail and its name,
 * which stays editable there because it names the campaigns.
 */
export function LaunchCreativeRow({
  inputId,
  alias,
  kind,
  thumbnailUrl,
  disabled,
  invalid,
  onPreview,
  onRename
}: {
  inputId: string;
  alias: string;
  kind: LaunchCreativeKind | null;
  thumbnailUrl: string | null;
  disabled: boolean;
  invalid: boolean;
  onPreview: () => void;
  onRename: (value: string) => void;
}) {
  const { t } = useI18n();
  const messageId = `${inputId}-message`;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <LaunchCreativeThumbnail
        thumbnailUrl={thumbnailUrl}
        kind={kind}
        disabled={disabled}
        onPreview={onPreview}
      />
      <div className="launch-creative-name">
        <label className="sr-only" htmlFor={inputId}>
          {t('launchesAlias')}
        </label>
        <Input
          id={inputId}
          value={alias}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? messageId : undefined}
          onChange={event => onRename(event.target.value)}
        />
        {invalid && (
          <p id={messageId} className="ui-field-error" role="alert">
            {t('launchesSubInvalid')}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The one name of several creatives (owner, 2026-11-25): SUB «Креатив», the campaign names and
 * the result's title carry it. It shows the automatic «<first>+N» and follows the list until the
 * person types a name of their own («пак 1» → «pak_1», as the trackers take it); clearing the
 * field or «Скинути» gives the automatic name back.
 */
export function LaunchCreativeLabelField({
  value,
  automatic,
  disabled,
  onChange
}: {
  /** The typed name; undefined while the name is automatic. */
  value: string | undefined;
  automatic: string;
  disabled: boolean;
  onChange: (label: string | undefined) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  // What the field shows while focused: «» stays «» there, not the automatic name.
  const [editing, setEditing] = useState<string | null>(null);
  const store = (text: string) => onChange(text && text !== automatic ? text : undefined);
  return (
    <FormField
      label={t('launchCreativeLabel')}
      htmlFor={id}
      help={
        value
          ? t('launchCreativeLabelCustomHelp', { name: automatic })
          : t('launchCreativeLabelHelp')
      }
      className="launch-creative-label"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Input
          id={id}
          value={editing ?? value ?? automatic}
          placeholder={automatic}
          maxLength={LAUNCH_CREATIVE_LABEL_MAX}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          onFocus={() => setEditing(value ?? automatic)}
          onChange={event => {
            const text = launchCreativeLabelInput(event.target.value);
            setEditing(text);
            store(text);
          }}
          onBlur={() => {
            if (editing === null) return;
            store(launchCreativeLabelInput(editing, true));
            setEditing(null);
          }}
        />
        {value && (
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0"
            disabled={disabled}
            onClick={() => {
              setEditing(null);
              onChange(undefined);
            }}
          >
            <RotateCcw size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span>{t('launchCreativeLabelReset')}</span>
          </Button>
        )}
      </div>
    </FormField>
  );
}
