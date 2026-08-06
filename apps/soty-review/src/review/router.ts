import { findSurface } from './catalog';
import type { ReviewLocale, ReviewRoute, StateId, Theme } from './model';

function theme(value: unknown): Theme {
  return value === 'dark' ? 'dark' : 'light';
}

function locale(value: unknown): ReviewLocale {
  return value === 'en-long' ? 'en-long' : 'uk';
}

export function parseReviewHash(input: unknown): ReviewRoute {
  if (typeof input !== 'string')
    return { kind: 'catalog', theme: 'light', locale: 'uk', notice: 'Некоректне посилання.' };
  const raw = input.replace(/^#/, '') || '/catalog';
  const [path, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const selectedTheme = theme(params.get('theme'));
  const selectedLocale = locale(params.get('locale'));
  if (path === '/catalog' || path === 'catalog')
    return { kind: 'catalog', theme: selectedTheme, locale: selectedLocale };
  const match = path.match(/^\/?screen\/([a-z0-9-]+)$/);
  if (!match)
    return {
      kind: 'catalog',
      theme: selectedTheme,
      locale: selectedLocale,
      notice: 'Екран не знайдено — повернуто до каталогу.'
    };
  const selectedSurface = findSurface(match[1]);
  if (!selectedSurface)
    return {
      kind: 'catalog',
      theme: selectedTheme,
      locale: selectedLocale,
      notice: 'Екран не знайдено — повернуто до каталогу.'
    };
  const requestedState = params.get('state') ?? selectedSurface.primaryStateId;
  const selectedState = selectedSurface.states.find(item => item.id === requestedState);
  if (!selectedState)
    return {
      kind: 'catalog',
      theme: selectedTheme,
      locale: selectedLocale,
      notice: 'Стан не знайдено — повернуто до каталогу.'
    };
  return {
    kind: 'screen',
    surfaceId: selectedSurface.id,
    stateId: selectedState.id,
    theme: selectedTheme,
    locale: selectedLocale
  };
}

export function serializeReviewRoute(route: ReviewRoute): string {
  const params = new URLSearchParams({ theme: route.theme, locale: route.locale });
  if (route.kind === 'catalog') return `#/catalog?${params}`;
  params.set('state', route.stateId satisfies StateId);
  return `#/screen/${route.surfaceId}?${params}`;
}
