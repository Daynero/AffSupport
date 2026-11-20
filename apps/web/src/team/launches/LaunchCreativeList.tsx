import { useState } from 'react';
import { ImageIcon, Play, X } from 'lucide-react';
import type { LaunchCreativeKind } from '@video-compressor/shared';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons.js';
import { Button, IconButton, Input } from '../../components/ui/index.js';
import { useI18n } from '../../i18n.js';

/**
 * 062: one chosen creative — its thumbnail opens the preview, its name becomes
 * the product-ID prefix, and in a catalog Launch it can be removed.
 */
export function LaunchCreativeRow({
  as: Tag = 'li',
  inputId,
  alias,
  kind,
  thumbnailUrl,
  disabled,
  invalid,
  repeated,
  removable,
  onPreview,
  onRename,
  onRemove
}: {
  /** `div` when the row sits inside the drop field (single-creative methods). */
  as?: 'li' | 'div';
  inputId: string;
  alias: string;
  kind: LaunchCreativeKind | null;
  thumbnailUrl: string | null;
  disabled: boolean;
  invalid: boolean;
  repeated: boolean;
  removable: boolean;
  onPreview: () => void;
  onRename: (value: string) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const [broken, setBroken] = useState<string | null>(null);
  const messageId = `${inputId}-message`;
  return (
    <Tag className="flex min-w-0 items-center gap-3">
      <Button
        className="launch-creative-thumbnail"
        variant="ghost"
        disabled={disabled}
        aria-label={t('launchesPreviewCreative')}
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
      <div className="launch-creative-name">
        <label className="sr-only" htmlFor={inputId}>
          {t('launchesAlias')}
        </label>
        <Input
          id={inputId}
          value={alias}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid || repeated ? messageId : undefined}
          onChange={event => onRename(event.target.value)}
        />
        {(invalid || repeated) && (
          <p
            id={messageId}
            className={invalid ? 'ui-field-error' : 'field-hint'}
            role={invalid ? 'alert' : undefined}
          >
            {invalid ? t('launchesSubInvalid') : t('launchCreativeAliasRepeated')}
          </p>
        )}
      </div>
      {removable && (
        <IconButton
          label={t('launchCreativeRemoveOf', { name: alias || t('launchesCreative') })}
          disabled={disabled}
          onClick={onRemove}
        >
          <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
      )}
    </Tag>
  );
}
