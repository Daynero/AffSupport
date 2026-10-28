import { useRef, useState, type CSSProperties } from 'react';
import { Clapperboard, Link, Image, Type, ListPlus, LoaderCircle, LockKeyhole } from 'lucide-react';
import type { CatalogUpdateProfile } from '@video-compressor/shared';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { spaceRouteFor } from '../SpaceSettingsLink';
import { Tooltip } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import type { CatalogField, InlineChangeState } from './useCatalogInlineChanges';

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
  onChange,
  onReadiness
}: {
  profile: CatalogUpdateProfile;
  name: string;
  disabledReason?: string;
  state?: InlineChangeState;
  restitchProgress?: number | null;
  onChange: (field: CatalogField, value: boolean) => void;
  onReadiness?: () => void;
}) {
  const { t } = useI18n();
  const group = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const pending = state?.phase === 'pending';
  const videoState = !profile.restitch ? 'off' : (profile.restitchStatus ?? 'waiting');
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
            event.key === 'Home' ? 0 : event.key === 'End' ? 4 : (active + delta + 5) % 5;
          setActive(next);
          group.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
        }}
      >
        {CATALOG_FIELDS.map(({ field, icon: Icon, label }, index) => {
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
                  tabIndex={active === index ? 0 : -1}
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
      </div>
    </div>
  );
}

export function CatalogIconLegend({
  teamId,
  onOpenSettings
}: {
  teamId: string;
  onOpenSettings: (href: string) => void;
}) {
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
      {CATALOG_FIELDS.map(({ field, icon: Icon, label, effect }) => (
        <div key={field}>
          <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <span>
            <strong>{t(label)}</strong>
            <small>{linkedEffect(field, effect)}</small>
          </span>
        </div>
      ))}
      <p>{t('catalogIconsLegendHint')}</p>
    </div>
  );
}
