# Tasks: Зручний менеджер оновлення каталогів

## Phase 1 — Setup

- [ ] T001 Зафіксувати локальні fixtures 1/40/400/500 каталогів і baseline швидкодії в `tests/catalog-manager-fixtures.ts` та `tests/performance-budgets.test.ts`.
- [x] T002 Додати типи профілю, спроби та terminal result у `packages/shared/src/team/catalog-updater.ts` і експортувати через `packages/shared/src/team/index.ts`.

## Phase 2 — Foundation

- [x] T003 Додати міграцію профілів із копією чинних глобальних параметрів, version check, історією спроб і rollback нотаткою в `supabase/migrations/20261203110000_catalog_manager_profiles.sql` та `supabase/migrations/ROLLBACK.md`.
- [ ] T004 Додати database regression для незмінності interval/next_run_at/параметрів, прав доступу й одночасних змін у `supabase/tests/database/catalog-manager-profile.test.sql`.
- [x] T005 Оновити validated RPC/read boundary і per-catalog patch results у `apps/web/src/api/team.ts`.

## Phase 3 — User Story 1: Стан каталогу

**Independent test**: Новий, off, running, success, failed і stale каталог пояснюються з рядка та деталей.

- [x] T006 [US1] Побудувати summary й історію останніх 10 спроб із підтвердженим успіхом у `supabase/migrations/20261203110000_catalog_manager_profiles.sql` та `apps/web/src/api/team.ts`.
- [x] T007 [US1] Переробити ієрархію рядка й панель деталей у `apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx` і новому `CatalogStatusDetails.tsx`.
- [x] T008 [US1] Додати локалізовані тексти точних дат, невідомого стану, помилки, partial та stale в `apps/web/src/i18n.ts`.
- [x] T009 [US1] Показати stale snapshot, час останнього читання, retry й початкові empty/error стани в `apps/web/src/team/catalog-updater/useCatalogUpdater.ts` та `CatalogUpdaterDialog.tsx`.
- [ ] T010 [US1] Перевірити keyboard, focus return, aria-live і 390 px, включно з одночасним давнім успіхом і новою невдачею та обома точними часами, у `tests/catalog-manager-status.test.tsx`.

## Phase 4 — User Story 2: Незалежний профіль

**Independent test**: A й B мають різний інтервал і зміст, C off; після reload та due run поведінка незалежна.

- [x] T011 [US2] Передавати знімок профілю при claim і застосовувати його до всіх п’яти дій у `supabase/functions/catalog-updater/worker.ts` та SQL claim функціях у `supabase/migrations/20261203110000_catalog_manager_profiles.sql`.
- [x] T012 [US2] Побудувати редактор одного каталогу з preview, readiness і version conflict у `apps/web/src/team/catalog-updater/CatalogProfileEditor.tsx`.
- [x] T013 [US2] Перенести глобальні перемикачі в явний шаблон нових каталогів, зберегти копії наявних профілів і короткий підсумок у `apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx`.
- [ ] T014 [US2] Передавати per-catalog restitch snapshot і attempt ID через `supabase/functions/drive-ops/updater-restitch.ts` та чинний agent restitch seam; при offline/stale агенті все одно оновити таблицю й зафіксувати video blocked/partial із дією відновлення.
- [x] T015 [US2] Розвести вимкнення розкладу, скасування активної спроби та видалення в `apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx` і server RPC у `supabase/migrations/20261203110000_catalog_manager_profiles.sql`.
- [ ] T016 [US2] Додати тести міграції, незалежності профілів, offline/stale restitch, зміни під час claim, keyboard/focus/aria-live/conflict/pending на 390 px у `tests/catalog-manager-profile.test.tsx` та `supabase/tests/database/catalog-manager-profile.test.sql`.

## Phase 5 — User Story 3: Масова робота й швидкодія

**Independent test**: Серед 500 каталогів змінити лише частоту двох, не торкнувшись їхніх різних типів оновлення.

- [x] T017 [US3] Додати фільтри стану, інтервалу, давності й типу змін та стабільне сортування на повному наборі у `apps/web/src/team/catalog-updater/useCatalogUpdater.ts` і `CatalogUpdaterDialog.tsx`.
- [x] T018 [US3] Додати mixed-state bulk editor з явним patch preview, кількістю прихованих вибраних і per-item result у `apps/web/src/team/catalog-updater/CatalogBulkEditor.tsx`.
- [ ] T019 [US3] Прибрати ручне перехоплення wheel, стабілізувати scroll anchor і мінімізувати повний refetch під час прогресу у `apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx` та `useCatalogUpdater.ts`.
- [ ] T020 [US3] Виміряти 500 рядків і перевірити повноту пошуку, mixed values, частковий bulk fail, keyboard/reader/focus/aria-live, 390 px і reduced motion у `tests/catalog-manager-scale.test.tsx`.

## Phase 6 — User Story 4: Результат і відновлення

**Independent test**: Ручний запуск off каталогу не змінює next run; частковий результат і retry безпечні.

- [x] T021 [US4] Додати attempt ID, profile snapshot, етап verification та terminal result у SQL claim/complete RPC в `supabase/migrations/20261203110000_catalog_manager_profiles.sql` і `supabase/functions/catalog-updater/worker.ts`.
- [x] T022 [US4] Реалізувати readback доступності після Drive write, resume після невизначеної відповіді та безпечну заміну відео в `supabase/functions/catalog-updater/worker.ts`.
- [x] T023 [US4] Додати retry з актуальним профілем, idempotent manual start, незмінний next run і окреме cancel у `supabase/migrations/20261203110000_catalog_manager_profiles.sql` та `apps/web/src/api/team.ts`.
- [x] T024 [US4] Показати історію, partial, retry і зв’язок зі старою спробою в `apps/web/src/team/catalog-updater/CatalogStatusDetails.tsx`.
- [ ] T025 [US4] Додати регресії timeout-after-write, inconclusive readback, partial-video, дубль запуску, off/manual та cancellation у `tests/catalog-updater-worker.test.ts` і `supabase/tests/database/catalog-manager-attempt.test.sql`.

## Phase 7 — Polish and diagnostics

- [ ] T026 Додати типізовані події профілю/спроби/доставки та privacy guard у `packages/shared/src/team/analytics.ts` і `apps/web/src/analytics/events.ts`.
- [x] T027 Розширити read-only CLI, code map та capability inventory для catalog/attempt у `scripts/analytics/investigate.ts`, `scripts/analytics/coverage-registry.ts`, `scripts/analytics/code-map.ts` і перевірити повний шлях у `tests/analytics-catalog-manager.test.ts`.
- [x] T028 Узгодити UI з `docs/DESIGN.md`, токенами та інвентарем компонентів у `apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx` і `apps/web/src/styles/components.css`.
- [ ] T029 Провести непідказаний usability test із 10 репрезентативними баєрами за SC-001/002 (час, помилки, допомога; прохід 9/10), пройти `specs/039-catalog-manager-ux/quickstart.md`, `npm run verify`, релевантні database/release gates і записати фактичні SC-001–SC-007 у `specs/039-catalog-manager-ux/acceptance.md`.

## Dependencies and delivery

T001–T005 блокують профілі й read model. US1 можна завершити на чинних даних до US2. US2 потребує T003–T005. US3 потребує read model і patch contract. US4 потребує профілів і worker snapshot. T025–T028 завершують кожен шлях; жоден із них не відкладається після релізу.

**MVP**: US1 + міграція/US2, щоб користувач бачив і налаштовував фактичний профіль. US3 та US4 потрібні для повного приймання. Незалежні задачі для паралельного виконання: T001/T002, T008/T006, T025/T027 після відповідних контрактів. Завершення кожної історії визначено її Independent test.

## Closure

Closed 2026-10-20 at the owner’s request. Final desktop scope, delivered refinements and retained acceptance limits: [closeout](../040-simplify-catalog-manager/acceptance.md). Production promotion remains separate.
