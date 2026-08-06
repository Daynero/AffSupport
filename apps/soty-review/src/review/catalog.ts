import {
  canonicalStateKinds,
  type CanonicalStateKind,
  type CoverageDecision,
  type RequirementId,
  type ReviewCatalog,
  type ReviewState,
  type ReviewSurface,
  type SurfaceGroup,
  type SurfaceId
} from './model';
import { demoItems, emptyItems } from './fixtures/base';

export const SOTY_REVIEW_ITERATION = 'soty-ui-r01' as const;

const labels: Record<CanonicalStateKind, string> = {
  default: 'Основний',
  loading: 'Завантаження',
  empty: 'Порожньо',
  success: 'Успіх',
  error: 'Помилка',
  active: 'Активна робота',
  confirmation: 'Підтвердження',
  disabled: 'Недоступно'
};

const descriptions: Record<CanonicalStateKind, string> = {
  default: 'Головний сценарій із безпечними типовими параметрами.',
  loading: 'Soty готує локальний демонстраційний стан.',
  empty: 'Ще нічого немає — почніть із головної дії.',
  success: 'Демонстраційний результат готовий. Реальні дані не змінено.',
  error: 'Не вдалося завершити демо-крок. Спробуйте інший стан.',
  active: 'Локальна демонстрація триває; це не справжня обробка.',
  confirmation: 'Перевірте ціль і наслідок перед демонстраційним підтвердженням.',
  disabled: 'Ця дія недоступна в поточному демонстраційному стані.'
};

function makeStates(title: string): readonly ReviewState[] {
  return canonicalStateKinds.map(kind => ({
    id: kind,
    kind,
    label: labels[kind],
    model: {
      kind,
      eyebrow: kind === 'active' ? 'ДЕМО · АКТИВНО' : 'SOTY · ЛОКАЛЬНИЙ ОГЛЯД',
      title,
      description: descriptions[kind],
      items: kind === 'empty' || kind === 'loading' ? emptyItems : demoItems,
      progress: kind === 'active' ? 64 : kind === 'loading' ? null : undefined,
      advanced: false,
      overlay: kind === 'confirmation' ? 'confirmation' : 'none'
    },
    primaryAction: kind === 'loading' || kind === 'disabled' ? null : 'primary-action'
  }));
}

function coverage(id: SurfaceId): Readonly<Record<CanonicalStateKind, CoverageDecision>> {
  return Object.fromEntries(
    canonicalStateKinds.map(kind => [
      kind,
      { applicability: 'scenario', scenarioId: `${id}-${kind}` }
    ])
  ) as Readonly<Record<CanonicalStateKind, CoverageDecision>>;
}

function surface(
  id: SurfaceId,
  group: SurfaceGroup,
  title: string,
  routeHint: string,
  requirements: readonly RequirementId[]
): ReviewSurface {
  return {
    id,
    group,
    title,
    routeHint,
    primaryStateId: 'default',
    states: makeStates(title),
    coverage: coverage(id),
    requirements
  };
}

export const reviewCatalog: ReviewCatalog = {
  iteration: SOTY_REVIEW_ITERATION,
  themes: ['light', 'dark'],
  locales: ['uk', 'en-long'],
  viewports: [
    { id: 'compact', width: 320, height: 568 },
    { id: 'mobile', width: 390, height: 844 },
    { id: 'tablet', width: 768, height: 1024 },
    { id: 'landscape', width: 1024, height: 768 },
    { id: 'desktop', width: 1440, height: 900 }
  ],
  evidence: {
    motionModes: ['no-preference', 'reduce'],
    contentModes: ['standard', 'long'],
    interactionModes: ['pointer', 'keyboard'],
    checks: ['contrast', 'reflow', 'focus', 'overlap'],
    scenarios: [
      'primary-action',
      'timed-tool-entry',
      'basic',
      'advanced',
      'nested-return',
      'confirmation',
      'lifecycle'
    ]
  },
  surfaces: [
    surface('auth-entry', 'auth', 'Вхід до Soty', '/login', ['FR-001', 'FR-003']),
    surface('global-shell', 'shell', 'Глобальна оболонка', 'persistent shell', [
      'FR-004',
      'FR-031'
    ]),
    surface('home-tools', 'home', 'Інструменти Soty', '/', ['FR-021', 'FR-022']),
    surface('compressor', 'tool', 'Стиснення відео', '/compressor', ['FR-024', 'FR-026']),
    surface('landing-optimizer', 'tool', 'Оптимізація лендингів', '/landing-optimizer', [
      'FR-024',
      'FR-031'
    ]),
    surface('landing-gallery', 'tool', 'Галерея лендингів', '/landing-preview', [
      'FR-029',
      'FR-031'
    ]),
    surface('transcription', 'tool', 'Транскрипція', '/transcription', ['FR-024', 'FR-030']),
    surface('team-lobby', 'team', 'Командні простори', '/team', ['FR-021', 'FR-029']),
    surface('team-create-space', 'team', 'Новий простір', '/team#create', ['FR-026', 'FR-030']),
    surface('team-workspace', 'team', 'Робочий простір', '/team#workspace', ['FR-022', 'FR-027']),
    surface('team-settings', 'team', 'Налаштування простору', '/team#settings', [
      'FR-025',
      'FR-030'
    ]),
    surface('account-profile', 'account', 'Профіль і запрошення', '/account', ['FR-027', 'FR-031']),
    surface('component-showcase', 'components', 'Компоненти Soty', 'review-only', [
      'FR-009',
      'FR-019'
    ])
  ],
  exclusions: [
    { id: 'marketing-home', rationale: 'Marketing site is outside the first-stage in-app scope.' },
    { id: 'legal-pages', rationale: 'Legal documents are explicitly outside the first stage.' },
    { id: 'admin-only', rationale: 'Role-gated internal administration is not customer-facing.' },
    {
      id: 'installer-release',
      rationale: 'Installer and release assets require a later scope decision.'
    },
    { id: 'external-messaging', rationale: 'Email, store listings and integrations are excluded.' }
  ]
};

export function findSurface(id: string): ReviewSurface | undefined {
  return reviewCatalog.surfaces.find(item => item.id === id);
}
