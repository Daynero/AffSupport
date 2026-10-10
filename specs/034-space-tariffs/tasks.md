# Задачі: тарифи на простір

Вхід: [spec.md](./spec.md), [plan.md](./plan.md). `[P]` — паралельно (інші файли).

## Фаза 1 — База: основа й доступ (P1)

- [ ] T001 Міграція `20261130100000_space_tariffs.sql`: таблиці (R13, R14, `space_tariffs`, `space_tariff_events`,
      `tariff_settings_events`, `space_tariff_notices`), колонки заявок (R11), пауза оновлювача (R7); RLS, `revoke all`; seed.
- [ ] T002 Функції часу й стану: `private.kyiv_day_end`, `private.space_tariff_state` (R1), місця (R5), прив'язка (R3).
- [ ] T003 Шлюз: нові `private.team_workspace_allowed`, `private.team_role`, `can_access_team_workspace` (з прив'язкою),
      тригер відкликання при видаленні профілю.
- [ ] T004 `create_team` (власник тарифу без простору; прив'язка), `transfer_ownership` (`TARIFF_BOUND`),
      `accept_invitation` (`SPACE_BLOCKED`, місця), `create_invitation`, `resend_invitation`,
      `service_direct_add_registered_member` (місця).
- [ ] T005 `get_my_space_access`, `get_team_tariff`, `join_team_workspace_waitlist(p_plan, p_channel)`,
      `request_space_owner_nudge`.
- [ ] T006 Адмін-RPC (контракти плану) з журналом і перевіркою місць.
- [ ] T007 Фон: фільтри claim-ів (R6), `apply_tariff_pauses`, `resume_team_catalog_updater`, скидання позначки в
      `set_team_catalog_update_interval` / `run_team_catalog_update_now`, звірка при відновленні (R8), cron.
- [ ] T008 Попередження (R9): черга, service-RPC, `invoke_tariff_notices`, cron.
- [ ] T009 Тести `tests/space-tariffs-sql.test.ts` для T001–T008; прогнати наявні SQL-тести шлюзу/запрошень/оновлювача/
      синхронізації.

## Фаза 2 — Edge (P2)

- [ ] T010 [P] `supabase/functions/_shared/email.ts` (відправка Resend), `team-invitations/email.ts` на ньому.
- [ ] T011 [P] `supabase/functions/tariff-notices/` (`index.ts`, `handler.ts`, `templates.ts`), `verify_jwt=false`,
      беті — `skipped`; тест `tests/tariff-notices.test.ts`.

## Фаза 3 — Веб (P1/P2)

- [ ] T012 [P] `packages/shared/src/team/tariffs.ts` + коди помилок; тест `tests/space-tariffs-contract.test.ts`.
- [ ] T013 `api/team.ts`, `database.types.ts`, `dev/mock-supabase.ts`.
- [ ] T014 `useSpaceAccess`, `SpaceShowcase`, `SpaceBlocked`, `contactAdmin`; `TeamSpace.tsx`, `TeamContext`.
- [ ] T015 `TariffBanner` у `WorkspaceShell`, разовий тост продовження, `UpdaterResumeNotice`.
- [ ] T016 `InvitationPanel` (лічильник, пояснення), передача власності — пояснення `TARIFF_BOUND`.
- [ ] T017 `SpaceTariffSection` у налаштуваннях простору.
- [ ] T018 `HomePage` — плитка й позначки, без пожертви на шляху до простору.
- [ ] T019 Адмінка: вкладки, підсумок, таблиця з фільтрами й пошуком, видача (≤3 дії, автодоповнення, попередження про
      відсутній акаунт, підставлені місця), «+1 міс» з відміною, зміна, завершення (сьогодні/зараз), історія, місця,
      заявки, старе правило, налаштування.
- [ ] T020 i18n uk+en; гейти дизайну, `verify-i18n`, web tsc.

## Фаза 4 — Беta й документи

- [ ] T021 Застосувати міграцію на беті (psql + `schema_migrations`), підняти веб беті, пройти сценарії власними кліками;
      `findings.md`.
- [ ] T022 `docs/ADMIN-TARIFFS.md` (як видати, продовжити, перевести простори, вимкнути старе правило),
      `supabase/migrations/ROLLBACK.md`.
