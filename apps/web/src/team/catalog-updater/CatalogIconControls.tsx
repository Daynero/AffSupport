import { useLegacyCatalogImageSettings } from '../TeamContext';
import { useRef, useState, type CSSProperties } from 'react';
import {
  Clapperboard,
  CloudUpload,
  Link,
  Image,
  Type,
  ListPlus,
  LoaderCircle,
  LockKeyhole
} from 'lucide-react';
import type { CatalogUpdateProfile } from '@video-compressor/shared';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { spaceRouteFor } from '../SpaceSettingsLink';
import { Tooltip } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import type { CatalogField, InlineChangeState } from './useCatalogInlineChanges';
import type { CatalogVideoR2Row } from '../product-catalog/useCatalogVideoR2Team';
import { teamErrorMessageFor } from '../errors';

type Translate = ReturnType<typeof useI18n>['t'];

/** One sentence for the settings panel: where the catalog's video link is now (050). */
export function catalogVideoR2Sentence(row: CatalogVideoR2Row, t: Translate): string {
  if (row.link === 'r2' && row.enabled) return t('catalogVideoR2PanelReady');
  // Every reason message already says that the Drive link stays.
  if (row.reason) return teamErrorMessageFor({ code: row.reason }, t);
  // The copy is done; only the sheet write is left, which the copy does not control.
  if (row.copyState === 'ready') return t('catalogVideoR2PanelCopied');
  return t('catalogVideoR2PanelPending');
}

/** Where the catalog's link is now, in the words the tooltip uses (050). */
export function catalogVideoR2Status(row: CatalogVideoR2Row, t: Translate): string {
  if (row.link === 'r2' && row.enabled) return t('catalogVideoR2StatusR2');
  // Turned off, but the cells still hold the R2 link until the Drive links are back.
  if (!row.enabled && row.link === 'r2') return t('catalogVideoR2StatusReturning');
  if (!row.enabled) return t('catalogVideoR2StatusDrive');
  if (row.reason) return teamErrorMessageFor({ code: row.reason }, t);
  if (row.copyState === 'ready') return t('catalogVideoR2StatusCopied');
  return t('catalogVideoR2StatusPending');
}

export const CATALOG_FIELDS = [
  {
    field: 'restitch',
    icon: Clapperboard,
    label: 'catalogUpdaterRestitch',
    effect: 'catalogUpdaterRestitchEffect'
  },
  {
    field: 'randomLinkVariation',
    icon: Link,
    label: 'catalogRandomLinkVariation',
    effect: 'catalogUpdaterLinkVariationEffect'
  },
  {
    field: 'refreshImages',
    icon: Image,
    label: 'catalogUpdaterRefreshImages',
    effect: 'catalogUpdaterImagesEffect'
  },
  {
    field: 'refreshTexts',
    icon: Type,
    label: 'catalogUpdaterRefreshTexts',
    effect: 'catalogUpdaterTextsEffect'
  },
  {
    field: 'growProducts',
    icon: ListPlus,
    label: 'catalogUpdaterGrow',
    effect: 'catalogUpdaterGrowEffect'
  }
] as const;

export function CatalogIconControls({
  profile,
  name,
  disabledReason,
  state,
  restitchProgress,
  updatePending,
  restitching,
  onChange,
  onReadiness,
  videoR2
}: {
  profile: CatalogUpdateProfile;
  name: string;
  disabledReason?: string;
  state?: InlineChangeState;
  restitchProgress?: number | null;
  /**
   * Whether an update is running now. Without one nothing is preparing a video yet, so "waiting
   * for video preparation" read as a stuck job on a catalog nobody had asked to update (1.4.3).
   * Absent keeps the waiting wording.
   */
  updatePending?: boolean;
  /**
   * The running round is stitching this catalog's video now. The profile's own status lags the
   * round and still says «waiting», so without this the icon read «Очікуємо підготовку відео…»
   * through the whole stitch.
   */
  restitching?: boolean;
  onChange: (field: CatalogField, value: boolean) => void;
  onReadiness?: () => void;
  /** 050: the catalog's R2 option, saved on its own; absent while R2 is unavailable. */
  videoR2?: { row: CatalogVideoR2Row; disabledReason?: string; onToggle: (next: boolean) => void };
}) {
  const legacyImages = useLegacyCatalogImageSettings();
  const fields = CATALOG_FIELDS.filter(({ field }) => legacyImages || field !== 'refreshImages');
  const { t } = useI18n();
  const count = fields.length + (videoR2 ? 1 : 0);
  const group = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const activeIndex = Math.min(active, count - 1);
  const pending = state?.phase === 'pending';
  const reported = !profile.restitch ? 'off' : (profile.restitchStatus ?? 'waiting');
  const videoState = reported === 'waiting' && restitching ? 'preparing' : reported;
  const measured = typeof restitchProgress === 'number' && Number.isFinite(restitchProgress);
  // Processing completion is not proof that the finalized spare can be consumed.
  const percent =
    videoState === 'ready'
      ? 100
      : videoState === 'preparing' && measured
        ? Math.min(99, Math.max(0, restitchProgress))
        : 0;
  const videoLabel =
    videoState === 'ready'
      ? t('catalogSpareVideoReady')
      : videoState === 'preparing'
        ? `${t('catalogRunPreparingVideo')}${measured ? ` · ${Math.round(percent)}%` : ''}`
        : videoState === 'blocked'
          ? t('catalogRunNextVideoFailed')
          : updatePending === false
            ? t('catalogRunVideoNotPrepared')
            : t('catalogRunVideoWaiting');

  return (
    <div className="catalog-icon-group">
      <div
        className="catalog-icon-toolbar"
        role="toolbar"
        aria-label={`${t('catalogUpdaterWhat')}: ${name}`}
        ref={group}
        onKeyDown={event => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          if (!delta && event.key !== 'Home' && event.key !== 'End') return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? count - 1
                : (activeIndex + delta + count) % count;
          setActive(next);
          group.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
        }}
      >
        {fields.map(({ field, icon: Icon, label }, index) => {
          const selected = profile[field];
          const waiting = pending && state.field === field;
          const description = `${t(label)} · ${t(selected ? 'catalogUpdaterBulkOn' : 'catalogUpdaterBulkOff')}${field === 'restitch' && selected ? ` · ${videoLabel}` : ''}${disabledReason ? ` · ${disabledReason}` : ''}`;
          return (
            <div
              key={field}
              className={`fit-mode-pictos is-single${index === 0 ? ' catalog-video-toggle' : ''}`}
            >
              <Tooltip asChild label={description} disabled={pending}>
                <button
                  type="button"
                  className={selected ? 'is-selected' : undefined}
                  data-video-state={field === 'restitch' ? videoState : undefined}
                  style={
                    field === 'restitch'
                      ? ({ '--catalog-video-fill': percent / 100 } as CSSProperties)
                      : undefined
                  }
                  tabIndex={activeIndex === index ? 0 : -1}
                  aria-pressed={selected}
                  aria-disabled={Boolean(disabledReason)}
                  aria-busy={waiting}
                  aria-label={`${description}: ${name}`}
                  data-catalog-field={field}
                  onFocus={() => setActive(index)}
                  onClick={() => {
                    if (!disabledReason) onChange(field, !selected);
                    else onReadiness?.();
                  }}
                >
                  {waiting ? (
                    <LoaderCircle
                      size={ICON_SIZE}
                      strokeWidth={ICON_STROKE}
                      className="is-spinning"
                      aria-hidden="true"
                    />
                  ) : disabledReason && !pending && !(field === 'restitch' && selected) ? (
                    <LockKeyhole size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  ) : (
                    <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  )}
                </button>
              </Tooltip>
              {field === 'restitch' && videoState === 'preparing' && (
                <span
                  className="sr-only"
                  role="progressbar"
                  aria-label={`${t('catalogRunPreparingVideo')}: ${name}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={measured ? percent : undefined}
                  aria-valuetext={videoLabel}
                />
              )}
            </div>
          );
        })}
        {videoR2 &&
          (() => {
            const { row, disabledReason: r2Disabled, onToggle } = videoR2;
            const index = fields.length;
            const error = row.error ? teamErrorMessageFor(row.error, t) : null;
            const description = [
              t('catalogVideoR2Toggle'),
              t(row.enabled ? 'catalogUpdaterBulkOn' : 'catalogUpdaterBulkOff'),
              catalogVideoR2Status(row, t),
              ...(error ? [error] : []),
              ...(r2Disabled ? [r2Disabled] : [])
            ].join(' · ');
            return (
              <div key="videoR2" className="fit-mode-pictos is-single catalog-video-r2-toggle">
                <Tooltip asChild label={description} disabled={row.pending}>
                  <button
                    type="button"
                    className={row.enabled ? 'is-selected' : undefined}
                    data-video-r2-state={
                      !row.enabled
                        ? 'off'
                        : row.link === 'r2'
                          ? 'ready'
                          : row.reason
                            ? 'blocked'
                            : 'preparing'
                    }
                    tabIndex={activeIndex === index ? 0 : -1}
                    aria-pressed={row.enabled}
                    aria-disabled={Boolean(r2Disabled) || row.pending}
                    aria-busy={row.pending}
                    aria-invalid={error ? true : undefined}
                    aria-label={`${description}: ${name}`}
                    data-catalog-field="copyVideoToR2"
                    onFocus={() => setActive(index)}
                    onClick={() => {
                      if (!r2Disabled && !row.pending) onToggle(!row.enabled);
                    }}
                  >
                    {row.pending ? (
                      <LoaderCircle
                        size={ICON_SIZE}
                        strokeWidth={ICON_STROKE}
                        className="is-spinning"
                        aria-hidden="true"
                      />
                    ) : r2Disabled ? (
                      <LockKeyhole size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                    ) : (
                      <CloudUpload size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                    )}
                  </button>
                </Tooltip>
              </div>
            );
          })()}
      </div>
    </div>
  );
}

export function CatalogIconLegend({
  teamId,
  onOpenSettings,
  videoR2 = false
}: {
  teamId: string;
  onOpenSettings: (href: string) => void;
  /** 050: list the R2 icon only where the option is offered. */
  videoR2?: boolean;
}) {
  const legacyImages = useLegacyCatalogImageSettings();
  const fields = CATALOG_FIELDS.filter(({ field }) => legacyImages || field !== 'refreshImages');
  const { t } = useI18n();
  const linkedEffect = (field: CatalogField, effect: Parameters<typeof t>[0]) => {
    const key =
      field === 'restitch'
        ? 'catalogLegendRestitch'
        : field === 'refreshImages'
          ? 'catalogLegendImages'
          : field === 'refreshTexts'
            ? 'catalogLegendTexts'
            : null;
    if (!key) return t(effect);
    const [before, after] = t(key, { settings: '[[settings]]' }).split('[[settings]]');
    const href = spaceRouteFor(teamId, {
      kind: 'settings',
      tab: field === 'restitch' ? 'restitch' : 'product-catalog'
    });
    return (
      <>
        {before}
        <a
          href={href}
          onClick={event => {
            if (
              event.defaultPrevented ||
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            onOpenSettings(href);
          }}
        >
          {t('catalogLegendSettings')}
        </a>
        {after}
      </>
    );
  };
  return (
    <div className="catalog-icon-legend">
      {fields.map(({ field, icon: Icon, label, effect }) => (
        <div key={field}>
          <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <span>
            <strong>{t(label)}</strong>
            <small>{linkedEffect(field, effect)}</small>
          </span>
        </div>
      ))}
      {videoR2 && (
        <div>
          <CloudUpload size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <span>
            <strong>{t('catalogVideoR2Toggle')}</strong>
            <small>{t('catalogVideoR2Legend')}</small>
          </span>
        </div>
      )}
      <p>{t('catalogIconsLegendHint')}</p>
    </div>
  );
}
