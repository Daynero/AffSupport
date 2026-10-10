# Задачі: тарифи на простір

Вхід: [spec.md](./spec.md), [plan.md](./plan.md). `[P]` — можна паралельно (інші файли). Тести перед реалізацією в межах фази.

## Фаза 1 — Основа бази (блокує все)

- [ ] T001 Міграція `supabase/migrations/20261130100000_space_tariffs.sql`: таблиці `tariff_plans` (seed solo/lead),
      `space_tariffs`, `space_tariff_events`, `space_tariff_notices`, `tariff_settings` (singleton, `legacy_rule_enabled=true`),
      колонка `team_catalog_updaters.stopped_by_tariff_at`; RLS увімкнено й примусово, `revoke all`.
- [ ] T002 У тій самій міграції: `private.kyiv_day_end(date)`, `private.space_tariff_for_team(team)`,
      `private.team_seats_used(team)`, `private.space_tariff_state(team)` (R1), `private.claim_tariff_owner(user)` (R3).
- [ ] T003 Тест `tests/space-tariffs-sql.test.ts`: стани `active/expiring/grace/blocked/legacy/none` на межах доби за Києвом,
      відкликання = одразу `blocked`, днів лишилось.

## Фаза 2 — US1/US2/US6: доступ (P1)

- [ ] T004 Тест: `private.can`, `can_access_team_workspace`, `list_my_teams.access_state`, `accept_invitation` для
      тарифного, пільгового, заблокованого, legacy і legacy-вимкненого простору.
- [ ] T005 Міграція: нові `private.team_workspace_allowed` (R4), `can_access_team_workspace`, `list_my_teams`
      (`access_state`, drop+create), `accept_invitation` (шлюз + місця).
- [ ] T006 Тест + міграція: `create_team` — адміністратор або власник тарифу без прив'язаного й без власного активного
      простору; прив'язка `team_id` при створенні.
- [ ] T007 Тест + міграція: `get_my_space_access()` (R10, лінива прив'язка пошти), `get_team_tariff(team)`.

## Фаза 3 — US4: місця (P1)

- [ ] T008 Тест: `create_invitation`, `resend_invitation`, `accept_invitation`, `service_direct_add_registered_member`
      поважають місця; Соло не запрошує; прострочене/відкликане запрошення звільняє місце; legacy — межа 50.
- [ ] T009 Міграція: перевірки місць з кодом `SEATS_FULL`; `packages/shared/src/team/transport.ts` — новий код.

## Фаза 4 — US3: адмінка в базі (P1)

- [ ] T010 Тест: адмін-RPC (видача на пошту з акаунтом і без, вибір простору, зміна, продовження, відкликання,
      `SEATS_IN_USE`, журнал, учасники/видалення, простори на старому правилі, налаштування й `LEGACY_SPACES_REMAIN`),
      відмова не-адміну.
- [ ] T011 Міграція: `admin_list_space_tariffs`, `admin_grant_space_tariff`, `admin_update_space_tariff`,
      `admin_revoke_space_tariff`, `admin_list_space_tariff_events`, `admin_list_tariff_members`, `admin_remove_tariff_member`,
      `admin_list_legacy_spaces`, `admin_get_tariff_settings`, `admin_set_tariff_settings`, `admin_list_tariff_plans`.

## Фаза 5 — US6: зупинка фону (P1)

- [ ] T012 Тест: заблокований простір не потрапляє в claim оновлювача, rounds, claim синхронізації, dispatcher
      синхронізації, preview-warm; ручні resync відмовляють; `apply_tariff_blocks` зупиняє оновлювач і ставить
      `stopped_by_tariff_at`; повторне ввімкнення його скидає.
- [ ] T013 Міграція: фільтри в `service_open_catalog_updater_rounds`, `private.claim_catalog_updater_items`,
      `private.claim_catalog_sync_jobs`, `private.invoke_catalog_sync_worker`, `service_claim_preview_warm`,
      `request_team_catalog_resync`, `request_team_folder_resync`, `save_team_catalog_updater` (скидає позначку);
      `private.apply_tariff_blocks()` + cron кожні 10 хв.

## Фаза 6 — US5: попередження (P2)

- [ ] T014 Тест: `private.queue_tariff_notices()` створює `warn_3d`, `warn_1d`, `grace`, `blocked` у свої моменти, без дублів;
      продовження не породжує попереджень за старий строк; `service_claim_tariff_notices`/`service_finish_tariff_notice`
      з повторами до 3.
- [ ] T015 Міграція: черга, service-RPC, `private.invoke_tariff_notices()` (URL похідна від `wishly_catalog_sync_url`,
      секрет воркерів), cron щогодини.
- [ ] T016 [P] Винести відправку листа в `supabase/functions/_shared/email.ts`; `team-invitations/email.ts` використовує його.
- [ ] T017 [P] Edge function `supabase/functions/tariff-notices/` (`index.ts`, `handler.ts`, `email.ts`), `verify_jwt=false`
      у `supabase/config.toml`; тест `tests/tariff-notices.test.ts`.

## Фаза 7 — Веб (P1/P2)

- [ ] T018 [P] `packages/shared/src/team/tariffs.ts` — типи й парсери; тест `tests/space-tariffs-contract.test.ts`.
- [ ] T019 `apps/web/src/api/team.ts` — обгортки RPC; `database.types.ts`/`database.compat.ts`; `dev/mock-supabase.ts`.
- [ ] T020 `TeamSpace.tsx` + `team/tariffs/SpaceShowcase.tsx` (US7) і `team/tariffs/SpaceBlocked.tsx`; не показувати
      «вас видалили» для заблокованого простору (`TeamContext`).
- [ ] T021 `team/tariffs/TariffBanner.tsx` у `WorkspaceShell.tsx` (US5/US6, дія «Написати адміністратору»).
- [ ] T022 `InvitationPanel.tsx` — лічильник місць, недоступність з поясненням, текст `SEATS_FULL`.
- [ ] T023 Оновлювач каталогів — пропозиція «увімкнути знову» при `updaterStoppedByTariff`.
- [ ] T024 `pages/admin/TariffsAdminCard.tsx` у `AdminPage.tsx`: таблиця, фільтр, діалоги видачі/зміни/відкликання,
      журнал, учасники, простори на старому правилі, налаштування; skeleton.
- [ ] T025 i18n uk+en для всього нового; дизайн-гейти (`check-design-tokens`, `check-tailwind-classes`, `verify-styles`,
      `verify-i18n`), web tsc.

## Фаза 8 — Завершення

- [ ] T026 Застосувати міграцію на локальній беті (psql + запис у `schema_migrations`, без `db reset`), підняти веб беті,
      перевірити сценарії quickstart власними кліками; записати `findings.md`.
- [ ] T027 Оновити `docs/` (адмінка: як видати тариф, як вимкнути старе правило) і `supabase/migrations/ROLLBACK.md`.
