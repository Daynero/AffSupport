# Задачі: тарифи на простір

Вхід: [spec.md](./spec.md), [plan.md](./plan.md). `[P]` — паралельно (інші файли).

## Фаза 1 — База: основа й доступ (P1)

- [x] T001 Міграція `20261130100000_space_tariffs.sql`: таблиці (R13, R14, `space_tariffs`, `space_tariff_events`,
      `tariff_settings_events`, `space_tariff_notices`), колонки заявок (R11), пауза оновлювача (R7); RLS, `revoke all`; seed.
      _Зроблено; `paused_interval` — `text`, як і `update_interval`._
- [x] T002 Функції часу й стану: `private.kyiv_day_end`, `private.space_tariff_state` (R1), місця (R5), прив'язка (R3).
- [x] T003 Шлюз: нові `private.team_workspace_allowed`, `private.team_role`, `can_access_team_workspace` (з прив'язкою),
      тригер відкликання при видаленні профілю. _`list_my_teams` — той самий тип, фільтр через шлюз._
- [x] T004 `create_team` (власник тарифу без простору; прив'язка), `transfer_ownership` (`TARIFF_BOUND`),
      `accept_invitation` (`SPACE_BLOCKED`, місця), `create_invitation`, `resend_invitation`,
      `service_direct_add_registered_member` (місця). _`TARIFF_BOUND` — тригер на `teams.owner_id`; простори без
      чинного тарифу (внутрішні/старе правило) лишаються на старому ліміті 50._
- [x] T005 `get_my_space_access`, `get_team_tariff`, `join_team_workspace_waitlist(p_plan, p_channel)`,
      `request_space_owner_nudge`. _+ `ack_space_tariff_toast`; стара безаргументна сигнатура замінена на версію з
      дефолтами (два перевантаження зробили б виклик без аргументів неоднозначним)._
- [x] T006 Адмін-RPC (контракти плану) з журналом і перевіркою місць. _Історія налаштувань —
      `admin_list_space_tariff_events(null)`._
- [x] T007 Фон: фільтри claim-ів (R6), `apply_tariff_pauses`, `resume_team_catalog_updater`, скидання позначки в
      `set_team_catalog_update_interval` / `run_team_catalog_update_now`, звірка при відновленні (R8), cron.
      _Файл `20261130110000_space_tariffs_background.sql`; запасні копії на паузі не списуються._
- [x] T008 Попередження (R9): черга, service-RPC, `invoke_tariff_notices`, cron. _Файл
      `20261130120000_space_tariff_notices.sql`; після невдачі — 5 хв лізингу до наступної спроби._
- [x] T009 Тести `tests/space-tariffs-sql.test.ts` для T001–T008; прогнати наявні SQL-тести шлюзу/запрошень/оновлювача/
      синхронізації. _39 тестів зелені; усі 37 наявних PGlite-наборів зелені без змін._

## Фаза 2 — Edge (P2)

- [x] T010 [P] `supabase/functions/_shared/email.ts` (відправка Resend), `team-invitations/email.ts` на ньому.
      Зроблено: `sendEmail` повертає `sent` або `failed` з короткою причиною (`not_configured`, `invalid_recipient`,
      `provider_http_<код>`, `provider_response`, `timeout`, `network`), `escapeHtml`/`safePlainText` спільні;
      `sendInvitationEmail` лишив контракт `{state, errorCode}` без змін.
- [x] T011 [P] `supabase/functions/tariff-notices/` (`index.ts`, `handler.ts`, `templates.ts`), `verify_jwt=false`,
      беті — `skipped`; тест `tests/tariff-notices.test.ts`.
      Зроблено: до 5 пачок по 20 за запуск (рядки, повернуті повторно, чекають наступного запуску); поза бетою без
      `RESEND_API_KEY`/`INVITE_EMAIL_FROM` нічого не claim-иться (`DELIVERY_UNAVAILABLE`); непридатний рядок →
      `finish(false, 'invalid_notice')`. Відповідь — `{ ok: true, value: { claimed, sent, skipped, failed } }`, як в
      інших воркерів. Функцію додано в цикл деплою `docs/SUPABASE_SETUP.md`.

## Фаза 3 — Веб (P1/P2)

- [x] T012 [P] `packages/shared/src/team/tariffs.ts` + коди помилок; тест `tests/space-tariffs-contract.test.ts`.
      Зроблено: строгі парсери всіх форм контракту; невідомий `state` → `none` (адмінка — `active`), невідомий `mode`
      виводиться зі списку просторів, невідомий `accessState` → `blocked`; `graceUntil` приймається і датою, і моментом.
      Шість кодів у `TEAM_ERROR_CODES` і тексти в `team/errors.ts`.
- [x] T013 `api/team.ts`, `database.types.ts`, `dev/mock-supabase.ts`.
      Зроблено: `spaceTariffApi` і `adminTariffApi` через нетиповий шов + парсери (`database.types.ts` — DB-агента);
      `teamApi.getMySpaceAccess` з запасним `can_access_team_workspace`; `throwRpc` на `PERMISSION_DENIED`/`SPACE_BLOCKED`
      шле подію повторної перевірки. Мок: адмін з двома тарифами, `localStorage['soty.mock.space-access']` =
      `showcase`/`blocked`.
- [x] T014 `useSpaceAccess`, `SpaceShowcase`, `SpaceBlocked`, `contactAdmin`; `TeamSpace.tsx`, `TeamContext`.
      Зроблено: модалка-шлюз і кнопка пожертви прибрані; вітрина — сторінка, призупинення малюється на тій самій адресі;
      `TeamContext` питає `isTeamPaused` перед «вас видалили». Файли посилань — `contactLinks.ts` +
      `ContactAdminButton.tsx` (на macOS `contactAdmin.ts` і `ContactAdmin.tsx` — один файл). Кнопки «Відкрити папку на
      Диску» немає: посилання на папку для призупиненого простору недоступне (його RPC закриті).
- [x] T015 `TariffBanner` у `WorkspaceShell`, разовий тост продовження, `UpdaterResumeNotice`.
- [x] T016 `InvitationPanel` (лічильник, пояснення), передача власності — пояснення `TARIFF_BOUND`.
      Лічильник і пояснення — лише для станів `active|expiring|grace` (старе правило й внутрішні — без змін, US2).
- [x] T017 `SpaceTariffSection` у налаштуваннях простору.
- [x] T018 `HomePage` — плитка й позначки, без пожертви на шляху до простору.
      Відхилення від тексту спеки: «Простір для команди» → «Простір для спільної роботи», «Команда: ви + 2 людини» →
      «Люди: ви + 2, можна більше» — глосарій (`tests/team-i18n-glossary.test.ts`) забороняє «команд» у будь-якому рядку.
- [x] T019 Адмінка: вкладки, підсумок, таблиця з фільтрами й пошуком, видача (≤3 дії, автодоповнення, попередження про
      відсутній акаунт, підставлені місця), «+1 міс» з відміною, зміна, завершення (сьогодні/зараз), історія, місця,
      заявки, старе правило, налаштування.
- [x] T020 i18n uk+en; гейти дизайну, `verify-i18n`, web tsc.
      Зроблено: ~220 ключів uk/en, старі ключі шлюзу прибрані; події `space_showcase_viewed`, `space_contact_clicked`
      (`feature_identifier`=тариф, `input_method`=канал), `space_tariff_granted` (`source_kind`) + capability
      `team.tariff` у реєстрі. Оновлено наявні тести: шлюз, лобі, адмінка, плитка на головній.

## Фаза 4 — Беta й документи

- [ ] T021 Застосувати міграцію на беті (psql + `schema_migrations`), підняти веб беті, пройти сценарії власними кліками;
      `findings.md`.
- [ ] T022 `docs/ADMIN-TARIFFS.md` (як видати, продовжити, перевести простори, вимкнути старе правило),
      `supabase/migrations/ROLLBACK.md`.
