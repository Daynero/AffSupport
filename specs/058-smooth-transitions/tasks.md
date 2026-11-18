# Tasks: Плавні переходи в усьому застосунку

**Input**: `/specs/058-smooth-transitions/` — spec.md, plan.md, research.md, data-model.md, contracts/
**Tests**: потрібні (FR-027, Analytics & Diagnostic Coverage).

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [x] T001 Додати токен очікування перед заготовкою `--delay-skeleton: 300ms` у `apps/web/src/styles/tokens.css` (поруч із `--delay-patience`), задокументувати в `docs/DESIGN.md` (розділ «Рух»).

## Phase 2: Foundational (блокує всі історії)

- [x] T002 `apps/web/src/lib/motion-registry.ts`: `SCREEN_KINDS` (closed, data-model), `MotionKind`, `RouteSkeletonVariant`, `REGISTRY: RegistryEntry[]`, `screenOf(route)`, `motionBetween(fromRoute, toRoute)` (різні розділи простору → `section`, решта → `page`); `OVERLAY_KINDS` (Modal, Drawer, Popover, DropdownMenu, Toast) з видом руху — для FR-026.
- [x] T003 `apps/web/src/lib/motion-quality.ts`: спостерігач `long-animation-frame` (fallback `longtask`) і `layout-shift`; `beginWindow()/endWindow()` → `{ longFrames, layoutShift }`; режим `lite` після двох переходів поспіль із кадром > 50 мс; `isLite()`; безпечний без `PerformanceObserver`.
- [x] T004 Переписати ядро `apps/web/src/lib/navigation.ts` за contracts/motion-contract.md: `navigateTo(path, options)` + сумісна сигнатура; токен навігації; `prepare` з таймаутом 300 мс; `skipTransition()` для анімації в польоті; класи `wishly-page-transition` / `wishly-section-transition`; рішення про миттєвий коміт (reduced, hidden, lite, theming, без API → клас `ui-content-enter`); прибрати `crossesTeamBoundary` з рішення (функцію лишити лише якщо потрібна деінде).
- [x] T005 Прокрутка й фокус у `navigation.ts`: `history.scrollRestoration='manual'`, ключ запису в `history.state`, мапа позицій; push/replace → прокрутка на початок, pop → відновлення; фокус на ціль руху (`main`/`.team-space-shell-body`, `tabIndex=-1`, `preventScroll`), якщо активний елемент зник або був навігаційним; `motion:'none'` — без змін.
- [x] T006 CSS переходів у `apps/web/src/styles.css`: комплементарне згасання `wishly-page` (`--motion-base`, підйом 4px), нова група `wishly-section` на `.team-space-shell-body` (`--motion-fast`, 2px), корінь без анімації, імена `wishly-topbar-start/end` під класом переходу сторінки, `ui-content-enter` (fallback), reduced-motion — усі нові псевдоелементи в блоці `animation: none`.
- [x] T007 [P] `tests/navigation-motion.test.ts`: скасування до коміту; таймаут prepare; supersede (остання ціль); `skipTransition` у польоті; миттєвий коміт під reduced/hidden/lite/theming/без API; прокрутка push → 0 і pop → відновлення; `motion:'none'` не чіпає прокрутку; скасований popstate повертає адресу.
- [x] T008 [P] `tests/motion-registry.test.ts`: кожен інструмент із `tool-registry`, кожна вкладка `CONTENT_TABS`, `/account`, `/admin`, `/team`, публічні/legal шляхи мають `ScreenKind`≠`other`; `motionBetween` для пар; реєстр без дублікатів.

**Checkpoint**: ядро руху готове; історії можна робити незалежно.

## Phase 3: US1 — Розділи простору без порожнього кадру (P1) 🎯 MVP

- [x] T009 [US1] `RouteSkeleton` у `apps/web/src/components/ui/Feedback.tsx` (+ експорт в `index.ts`, стилі в `styles/components.css`): варіанти `tool|settings|lobby|list|tiles|board`, поява через `animation-delay: var(--delay-skeleton)` і плавне наростання opacity за `--motion-slow` (заготовка, що встигла показатись лише на мить, лишається майже прозорою — FR-008 без штучного утримання), `aria-busy` + підпис.
- [x] T010 [US1] `WorkspaceShell.tsx`: `preloadable()` для `LaunchSpace`, `ExplorerShell`, `MembersSection` (якщо лінивий); фонове завантаження всіх розділів після першого кадру (`requestIdleCallback` з таймаутом); preload при `pointerenter`/`focus` вкладки.
- [x] T011 [US1] `WorkspaceShell.tsx`: вкладки → `navigateTo(sectionRoute(next), { motion: 'section', prepare: preloadOf(next) })`, `internalLink` теж; окремий `Suspense` із `RouteSkeleton` навколо кожного лінивого розділу (включно з `ExplorerShell`), зовнішній `Suspense` тіла — заготовка, а не порожній `div`.
- [ ] T012 [US1] Живі оновлення: перевірити, що вставка рядка в списках (`explorer`, `tasks`, `launches`) не використовує анімацію розкладки; там, де рядок з'являється, — `ui-row-enter` (opacity, `--motion-fast`); без зсуву рядка у фокусі. Файли: `styles.css` / відповідні `*.css` секцій.

- [x] T012a [US1] `recoverableLazy(load)` у `apps/web/src/lib/recoverable-lazy.tsx` (функціональний, без класу): відмова завантаження чанка → стан `ChunkFailed` з інвентаря (`Empty` + «Повторити» / «Оновити сторінку»), повтор створює новий `lazy`; застосувати до `TeamSpace`, `WorkspaceShell`, розділів простору й `preloadable()`; сповіщає `navigation-analytics` про `chunk_failed` (FR-009). Тест у `tests/navigation-motion.test.ts`.

## Phase 4: US2 — Інструменти ↔ простір без накладання (P1)

- [x] T013 [US2] Header уже має `.topbar-lead` / `.topbar-actions` — імена `wishly-topbar-lead/actions` і `wishly-topbar` повішено на них у `styles.css`; `App.tsx` не змінювався.
- [x] T014 [US2] `ProtectedSoty.tsx`: `Suspense` `TeamSpace` → `RouteSkeleton variant="lobby"` у `.page-container.team-space-page`; `navigateTo` у межі простору з `prepare: () => import('./team/TeamSpace')`; preload чанка простору при наведенні на пункт меню/плитку простору (`HomePage.tsx`, `UserMenu.tsx`, `SpaceSwitcher.tsx`).
- [x] T015 [US2] `TeamSpace.tsx`: зовнішній `Suspense` → заготовка лобі; редирект усередині спроби — `replace` без другого руху (`navigateTo(..., { replace: true, motion: 'none' })` коли перехід ще триває).

## Phase 5: US3 — Оверлеї (P2)

- [x] T016 [US3] `usePresence(open)` у `components/ui/Overlay.tsx`; `Modal` (отже й `Drawer`), `Popover`, `DropdownMenu` (крім `frequent`) тримають поверхню на час закриття, `data-state="closing"`; повернення фокусу — після закриття.
- [x] T017 [US3] `styles/components.css`: `ui-surface-out`, `ui-fade-out` (`--motion-fast`), `pointer-events:none` під час закриття, `.ui-overlay.is-nested` без тла; `html { scrollbar-gutter: stable }` у `styles.css`; reduced-motion покриває нові анімації.
- [x] T018 [P] [US3] `tests/overlay-presence.test.tsx`: модаль лишається змонтованою до кінця закриття й не приймає кліки; повторне відкриття під час закриття скасовує закриття; `frequent` popover зникає одразу.

## Phase 6: US4 — Публічні сторінки, вхід, перший запуск (P2)

- [x] T019 [US4] `Root.tsx`: `HoneycombField` лишається `null`; `ProtectedSoty`-`Suspense` — `AuthLoadingScreen` (вже не порожній), перевірити, що вхід → застосунок — один стан завантаження; переходи публічна → вхід → застосунок ідуть через `navigateTo` з `page`.
- [x] T020 [US4] `ProtectedSoty.tsx` `ToolRoute`: зміна стану агента setup ↔ tool не миготить — короткі стани (< `--delay-skeleton`) не показуються (затримка показу `ToolSetupScreen` при `connectedOnce=false` і `connection='connecting'`).

## Phase 7: US5 — Зменшений рух і слабке залізо (P2)

- [x] T021 [US5] Підключити `motion-quality` до `navigation.ts` (вікно на час переходу; `lite`), пропуск переходу у прихованій вкладці; fallback `ui-content-enter` для браузерів без API.
- [x] T022 [P] [US5] Тести в `tests/navigation-motion.test.ts` для `lite` і fallback-класу.

## Phase 8: Аналітика (наскрізна)

- [x] T023 `apps/web/src/analytics/events.ts`: подія `navigation_attempt_finished`, переліки `NAV_*`, ключі `nav_from_screen`, `nav_to_screen`, `nav_motion`, `nav_mode`, `nav_skip_reason`, `nav_final`, `nav_history`, `prepare_ms`, `skeleton_ms`, `layout_shift_milli`, `long_frame_count` (+ наявні `duration_ms`, `browser_family`), типи й правила; `service.ts` — `TERMINAL_EVENT_NAMES`.
- [x] T024 `apps/web/src/lib/navigation-analytics.ts`: життєвий цикл спроби з `navigation.ts` (start/commit/settled/superseded/cancelled/chunk_failed), вимір `skeleton_ms` (заготовка повідомляє про показ/зникнення), вибірка й ліміт 60 на сесію, `flow_id = crypto.randomUUID()`.
- [x] T025 Міграція `supabase/migrations/<наступний ts>_navigation_analytics_guard.sql` (повне тіло `analytics_properties_are_safe_v2` + нові ключі, enum-и, межі), рядок у `supabase/migrations/ROLLBACK.md`, pgTAP у `supabase/tests/database/analytics-guard-contract.test.sql` (+ `plan`).
- [x] T026 `scripts/analytics/coverage-registry.ts` (`CapabilityTool` `'web'`, capability `web.navigation`), `queries.ts` (`getNavigation`, `QUERY_EVENT_NAMES`), `cli.ts` (`navigation`, HELP), `format.ts`; `docs/ANALYTICS_CLI.md`, `AGENTS.md`.
- [x] T027 [P] `tests/navigation-analytics.test.ts` (вибірка, ліміт, фінали, відсутність адрес/ідентифікаторів у властивостях) + оновити `tests/analytics-cli.test.ts` для `navigation`.

## Phase 9: Покадровий смок (FR-027)

- [x] T028 `scripts/motion-lib.mjs` (метрика `excess`, `d`, аналіз кадрів) + `scripts/motion-smoke.mjs` (playwright-core, CDP screencast, вхід через magic link як у пам'яті беті, маршрути з реєстру, звіт JSON + найгірші кадри PNG).
- [x] T029 [P] `tests/motion-smoke-metric.test.ts`: синтетичні кадри — кросфейд проходить, кадр-дірка падає, «хвіст після кінця» падає.

## Phase 10: Polish & перевірка

- [x] T030 Аудит картинок у списках/плитках без зарезервованих розмірів (FR-014) і аудит `styles.css`/`styles/*.css`: `transition`/`animation` поза токенами або на властивостях розкладки, що стосуються переходів; привести до правил (FR-003).
- [x] T031 Оновити `specs/058-smooth-transitions/current-state.md` → «стало», `docs/DESIGN.md` (мова руху з трьох видів).
- [x] T032 Гейти по черзі (quickstart): prettier, eslint, typecheck, related vitest, design gates, guard-контракт.
- [x] T033 Бета: `beta:up` з воркдерева, міграція psql, `motion-smoke.mjs`, ручний прохід історій 1–5 (зокрема reduced motion), фікси, повтор до зеленого звіту.
- [ ] T034 Передати бету власнику: адреса, що перевірити, звіт смоку.

## Dependencies

- T001 → T006, T009. T002–T006 → усі історії. T004 → T005, T011, T014, T021, T024.
- US1 (T009–T012) перед US2 (T014 використовує `RouteSkeleton`).
- T023 → T024 → T027; T025 ↔ T023 (ключі однакові); T026 після T023.
- T028 після T002 (реєстр); T033 після всього.

## Analysis (speckit-analyze, 2026-11-18) — застосовано

| ID | Знахідка | Виправлення |
|----|----------|-------------|
| A1 | FR-009 (помилка чанка) не мав задачі; друга відмова в `main.tsx` лишається необробленою → порожня сторінка | T012a `recoverableLazy` |
| A2 | FR-008 «мінімальний час індикатора» конфліктує з Suspense (резолв не відкласти) | T009: заготовка наростає поступово, коротка поява непомітна; зафіксовано як рішення |
| A3 | FR-026 вимагає оверлеї в реєстрі, T002 мав лише маршрути | T002 `OVERLAY_KINDS` |
| A4 | FR-014 картинки без зарезервованого місця не мали задачі | T030 доповнено |
| A5 | Конституція VI «100 % функціональні компоненти» vs класичний error boundary | обрано функціональний `recoverableLazy` |
| A6 | Публічні сторінки не шлють аналітику (немає `userId`) — розрив із «усі екрани» в аналітиці | Задокументовано в contracts/navigation-analytics.md як свідома межа; покриття публічних — смок FR-027 |

Покриття: FR-001…FR-027 мають щонайменше одну задачу; SC-001/002/004/007 — T033 (смок + ручний прохід), SC-003 — аналітика `duration_ms` + смок, SC-005 — T008/T030 + design gates, SC-006 — після віддачі бети.

## Beta smoke (2026-11-18) — знахідки й фікси

| Знахідка (смок) | Причина | Фікс |
|---|---|---|
| Вхід у простір: кадр без вмісту (~100 мс) | стани «перевірка доступу» / «простір підхоплюється» — текст або заготовка з затримкою | заготовка `workspace`; одразу після переходу заготовка без затримки (`data-nav-recent`) |
| «Назад» у простір: порожній кадр | режим `lite` (миттєвий) + `.page-enter` з opacity 0 | сторінка, змонтована миттєвою навігацією, не грає появи з прозорості; fallback — підйом без opacity |
| Нижній край панелі стрибає між вкладками | розділи мали висоту вмісту | каркас простору на висоту вікна, тіло 1fr |
| Бета не стартувала (CLI 3.x health-deadline) | storage/pg-meta «unhealthy» у ту саму секунду, що слухали | `beta-up`: `--ignore-health-check` + власне очікування Docker health (5 хв) |

Підсумок: `motion-smoke` warm/cold — 26/26 без моргань і накладань; reduced motion — 12/13, лишився зсув 0.057 у діалозі налаштувань простору під час дозавантаження (T035).

- [ ] T035 Діалог налаштувань простору: зарезервувати місце під блоки, що дозавантажуються (зсув 0.057 > 0.05).
- [ ] T036 Повний vitest-набір перед релізом на next.
