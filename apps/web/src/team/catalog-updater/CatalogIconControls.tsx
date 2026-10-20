import { useRef, useState } from 'react';
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
  onChange,
  onReadiness
}: {
  profile: CatalogUpdateProfile;
  name: string;
  disabledReason?: string;
  state?: InlineChangeState;
  onChange: (field: CatalogField, value: boolean) => void;
  onReadiness?: () => void;
}) {
  const { t } = useI18n();
  const group = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const pending = state?.phase === 'pending';

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
          const description = `${t(label)} · ${t(selected ? 'catalogUpdaterBulkOn' : 'catalogUpdaterBulkOff')}${disabledReason ? ` · ${disabledReason}` : ''}`;
          return (
            <div
              key={field}
              className={`fit-mode-pictos is-single${index === 0 ? ' catalog-video-toggle' : ''}`}
            >
              <Tooltip asChild label={description} disabled={pending}>
                <button
                  type="button"
                  className={selected ? 'is-selected' : undefined}
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
                  ) : disabledReason && !pending ? (
                    <LockKeyhole size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  ) : (
                    <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  )}
                </button>
              </Tooltip>
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
