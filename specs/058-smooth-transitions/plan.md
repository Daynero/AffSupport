# Implementation Plan: Плавні переходи в усьому застосунку

**Branch**: `058-smooth-transitions` | **Date**: 2026-11-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/058-smooth-transitions/spec.md`

## Summary

Один шар руху для вебзастосунку замість трьох несумісних латок. У ньому:
- справжнє комплементарне перехресне згасання сторінок замість «старий
  непрозорий під новим»;
- новий вид `section` для розділів простору;
- підготовка чанка до коміту переходу (≤ 300 мс, далі — заготовка);
- одна черга переходів зі скасуванням застарілих;
- прокрутка й фокус, якими керує роутер;
- рух закриття для оверлеїв;
- адаптивний режим `lite` для слабкого заліза;
- реєстр екранів, одна подія аналітики на спробу навігації, CLI-команда
  `navigation` і покадровий димовий скрипт для бети.

Рішення та їх обґрунтування — у [research.md](research.md) (R1–R11).

## Technical Context

**Language/Version**: TypeScript 5 (strict), React 19.2, CSS (шар токенів + Tailwind v4)

**Primary Dependencies**: власний роутер `apps/web/src/lib/navigation.ts`, View Transitions API браузера, HeroUI v3 / інвентар `components/ui`, `playwright-core` + `pngjs` (вже встановлені) для димового скрипта

**Storage**: Supabase `public.analytics_events` (лише нова гілка в guard-функції властивостей)

**Testing**: vitest single-worker (`--maxWorkers=1 --minWorkers=1 --no-file-parallelism`), jsdom для навігації та оверлеїв, PGlite guard-contract, pgTAP для guard, покадровий `scripts/motion-smoke.mjs` на беті

**Target Platform**: Chrome/Edge 111+, Safari 18+, Firefox 144+ на Mac M-серії та Windows; старіші браузери — рівноцінний fallback без View Transitions

**Project Type**: web-застосунок (`apps/web`) + аналітичний CLI (`scripts/analytics`) + одна міграція

**Performance Goals**: перехід ≤ 220 мс (сторінка), ≤ 150 мс (розділ); теплий клік → готовий вміст ≤ 300 мс p95; пропущені кадри ≤ 5 % на слабкій машині

**Constraints**: стеля руху 300 мс; лише `opacity`/`transform`; жодного значення поза `tokens.css`; машина розробки слабка — один важкий процес за раз; агент не змінюється (веб + міграція → швидкий шлях next)

**Scale/Scope**: ~20 екранів (інструменти, акаунт, адмін, лобі, 6+ розділів простору, публічні), ~10 видів оверлеїв

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Принцип | Як дотримано |
|---------|--------------|
| I. Type-safe contracts | `ScreenKind`, `NavMotion`, `NavFinal`, `NavMode`, `NavSkipReason` — закриті `as const` юніони; властивості події типізовані й записані в `ANALYTICS_PROPERTY_RULES`; guard у БД доповнюється в тій самій зміні, а контракт перевіряє `analytics-guard-contract.test.ts`. |
| II. One source of truth | Реєстр переходів — єдине джерело для аналітики, тесту покриття й димового скрипта. Протокол агента не змінюється. |
| III. Security / least privilege | Подія без адрес, ідентифікаторів і вмісту; лише закриті переліки та числа. Guard відкидає все інше. |
| IV. Child-process orchestration | Не стосується: є лише димовий скрипт, який запускає браузер і закриває його у `finally`. |
| V. HTTP / error conventions | Не стосується: нових ендпоінтів немає. |
| VI. Frontend composition | Роутинг лишається власним (`navigation.ts`); нові компоненти (`RouteSkeleton`, `usePresence`) живуть в інвентарі `components/ui`; усі тривалості й криві — токени; аналітика — через `analytics.track(typedName, props)`; нових бібліотек немає. |
| Якість | Гейти format/lint/typecheck/related tests; `check-design-tokens`, `check-tailwind-classes` і `verify-styles` мають пройти без винятків. |

**Результат**: порушень немає. Повторна перевірка після Phase 1 нічого не змінила.

## Project Structure

### Documentation (this feature)

```text
specs/058-smooth-transitions/
├── spec.md
├── current-state.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── motion-contract.md
│   └── navigation-analytics.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
apps/web/src/
├── lib/
│   ├── navigation.ts           # черга переходів, motion: page|section|none, prepare, прокрутка, фокус
│   ├── motion-registry.ts      # NEW: ScreenKind, маршрут → екран, вид руху, заготовка, покриття
│   ├── motion-quality.ts       # NEW: спостерігач довгих кадрів і зсуву, режим lite
│   └── navigation-analytics.ts # NEW: спроба навігації → navigation_attempt_finished (вибірка, ліміт)
├── components/ui/
│   ├── Feedback.tsx            # RouteSkeleton (варіанти екранів)
│   ├── Overlay.tsx             # usePresence + рух закриття Modal/Drawer/Popover/DropdownMenu
│   └── index.ts
├── ProtectedSoty.tsx           # Suspense → RouteSkeleton
├── Root.tsx                    # заглушки публічних і legal-сторінок → заготовки
├── team/TeamSpace.tsx          # Suspense → заготовка лобі
├── team/workspace/WorkspaceShell.tsx  # motion 'section', preload, окремий Suspense для кожного розділу
├── App.tsx                     # Header: імена кластерів верхньої панелі
├── analytics/events.ts         # подія + ключі + правила
├── styles.css                  # view-transition групи, reduced-motion, fallback-рух
└── styles/components.css       # оверлеї: closing, тло вкладеного оверлея, ui-content-enter
supabase/migrations/<ts>_navigation_analytics_guard.sql  (+ ROLLBACK.md, pgTAP)
scripts/analytics/{coverage-registry,queries,cli,format}.ts   # capability web.navigation, команда navigation
scripts/motion-smoke.mjs                                      # NEW: покадровий смок для бети
tests/
├── navigation-motion.test.ts         # NEW
├── motion-registry.test.ts           # NEW
├── overlay-presence.test.tsx         # NEW
├── navigation-analytics.test.ts      # NEW
├── motion-smoke-metric.test.ts       # NEW
└── analytics-cli.test.ts, guard-тести (оновлення)
docs/DESIGN.md, docs/ANALYTICS_CLI.md, AGENTS.md (рядок команди)
```

**Structure Decision**: усі зміни — у наявних шарах (`apps/web`, `scripts/analytics`,
`supabase/migrations`). Нових пакетів і залежностей немає.

## Delivery

1. Реалізація в гілці `058-smooth-transitions` (база `1d496010`).
2. Гейти по черзі: format → lint → typecheck → related vitest (single-worker) →
   design gates → guard-контракт.
3. Бета з цього воркдерева через `beta:up`. Міграцію накатуємо через psql із записом у
   `schema_migrations` (див. пам'ять про заблокований `migration up`). Далі
   `scripts/motion-smoke.mjs` і ручний прохід у Playwright-браузері, фікси, повтор.
4. Передати бету власнику. На next — лише за окремою командою (веб + backend plan).

## Complexity Tracking

Порушень конституції немає.
