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

- [x] T021 (2026-10-11: див. findings.md) Застосувати міграцію на беті (psql + `schema_migrations`), підняти веб беті, пройти сценарії власними кліками;
      `findings.md`.
- [x] T022 (docs/ADMIN-TARIFFS.md; ROLLBACK.md — у міграціях) `docs/ADMIN-TARIFFS.md` (як видати, продовжити, перевести простори, вимкнути старе правило),
      `supabase/migrations/ROLLBACK.md`.

## Фаза 5 — автоматичне відновлення (umbrella milestones; актуалізація 2026-10-20)

- [x] T023 Уточнити contracts/data-model для US6.6: snapshot активних процесів, причина паузи, індивідуальні інтервали,
      ручне вимкнення, checkpoints, часткове відновлення, межі 60 с / 5 хв та залежності Drive/агента.
- [x] T024 Додати спочатку failing DB/regression тести: renewal без браузера, два renewal, pause/renew race,
      disabled catalog, змінені права, expired dependencies, старий worker та відсутність дубльованих побічних дій.
- [x] T025 Реалізувати додатковою міграцією серверне автоматичне відновлення на чинному переході доступу;
      зберегти інтервали, одноразовий catch-up та bounded scheduling. Вимкнене/скасоване вручну не відновлювати.
- [x] T026 Узгодити автоматичне відновлення sync, restitch, preview/cleanup та незавершеної агентної роботи;
      перевірити checkpoint, актуальні права й результат до retry, не перезапускати завершене/скасоване.
- [x] T027 Замінити нормальний ручний UpdaterResumeNotice на правдивий стан автоматичного/часткового відновлення;
      зберегти попередження про зупинку, додати uk/en тексти та UI регресії.
- [x] T028 Розширити typed signals, code map/capability inventory та read-only diagnosis відновлення;
      довести terminal і delivery, missing/delayed signals, безпечні bounded retries та приватність.
- [x] T029 Виконати single-worker регресії, npm run verify та оновити docs/ADMIN-TARIFFS.md. Релізні LIFE/LOAD і exact-SHA packaged beta винесені в T044 за прямим рішенням власника.

## Фаза 6 — виконувані інкременти, 2026-10-20

T001–T022 зберігають історію. Рішення власника нижче відділяє завершення розробки від відкладеної релізної кампанії.
Канон повного виконання: [036 T024–T048](../036-production-acceptance/tasks.md).

- [x] T030 Оновити `specs/034-space-tariffs/plan.md`, `research.md`, `data-model.md`, `contracts/recovery.md`, `quickstart.md` за HEAD; звірити 036 ownership, поточні calendar/profile/lease seams. (T023)
- [x] T031 [US6] Додати failing regressions у `tests/space-tariffs-sql.test.ts`: automatic no-browser undo/renewal, expiry до cron, повторний renewal без нового run, manual disabled та per-catalog calendar preservation. (FR-009/010, T024)
- [x] T032 [US6] Реалізувати recurring capture-before-renewal, lock/recheck та idempotent restore у `supabase/migrations/20261205100000_tariff_catalog_recovery.sql`; compatibility RPC, rollback у `supabase/migrations/ROLLBACK.md`; довести T031 та двосесійні recurring regressions у `tests/tariff-catalog-recovery-postgres.test.ts`. (T025, інкремент 1)
- [x] T033 [US6] Реалізувати повні WorkspacePause/PauseItem/RecoveryItem, generation/epoch, one-off receipts, durable queue failures і concurrency у файлах 036 T024–T032/T041/T047; синхронізувати `specs/034-space-tariffs/data-model.md`. (T024–T026)
- [x] T034 [US6] Реалізувати scoped Edge enrollment/delegation/worker, платформне credential storage, agent journal/executor та capability за 036 T026–T027/T033–T040 у `supabase/functions/team-recovery/`, `apps/agent/src/team-bridge/recovery-*.ts`, `apps/agent/src/platform/`; перевірити source/rights/output receipts. (T026)
- [x] T035 [US6] Реалізувати projection і truthful UI/warnings за 036 T041–T044 у `apps/web/src/team/tariffs/UpdaterResumeNotice.tsx`, shared DTO, i18n та `tests/tariff-recovery-ui.test.tsx`; не позначати restored schedule як completed process. (T027)
- [x] T036 [US6] Реалізувати typed recovery diagnostics, read-only investigate/inspect/audit і retention за 036 T045–T047 у `scripts/analytics/`, `packages/shared/src/team/analytics.ts`, `tests/analytics-tariff-recovery.test.ts`. (T028)
- [x] T037 Виконати targeted single-worker тести інкремента 1, записати реальні результати й межі у `specs/034-space-tariffs/findings.md`; повні T029/036 acceptance не закривати цим прогоном.
- [x] T038 Виконати development builds/verify, local DB type generation та оновити ADMIN-TARIFFS/findings. Релізні LIFE/LOAD і exact-SHA beta перенесені до T044; вони не виконані й не позначені PASS. (T029)

## Залежності та independent checks

T030 → T031 → T032 → T037; далі T033 → T034 → T035/T036 → T038.
US1–US5/US7: чинні T001–T022 регресії; US6: independent tests у quickstart + 036 LIFE.
T035 й T036 можна паралелити після стабілізації DTO/серверних lifecycle stages; до того виконання послідовне.
MVP інкремента 1 — automatic recurring restore без браузера; це не production-ready повна US6.6.

### Реалізація наступного інкремента — 2026-10-20

T033/T034/T036 завершені як реалізація: код, локальні регресії та живий broker/native/Drive → CLI proof. Релізний proof mapping 036 відкладений власником.

- T033: durable pause/items, one-off actor/round, epoch, generation, dependency dispatcher, queue failure receipts.
- T034: scoped delegation Edge/native executor, credential storage, durable journal, claim replay, operation fences.
  Live Windows виключено власником (T039). Drive output receipt і staged restart/cancel/concurrency acceptance відстежуються окремо.
- T035: shared projection, автоматичний стан/причини, explicit retry, capability/settings, browser/native ownership.
  UI 6/6 + browser ownership 3/3; queued не оголошується completed.
- T036: restricted view і read-only investigate/inspect/sync/audit; невідома доставка лишається blind spot.
  Producer→CLI proof на local beta виконано; зовнішній delivery лишається unknown. Релізна LIFE/LOAD кампанія відкладена.
- T038: production не змінювався; exact-SHA acceptance не можна підмінити dirty-tree unit tests.

## Phase 7: Convergence

- [x] T039 За прямим рішенням власника від 2026-10-20 виключити live Windows acceptance з completion 034; зберегти Windows implementation/automated contracts, не називати виключений кейс PASS; синхронізувати plan/spec і recovery mapping 036. (plan: acceptance scope, partial)
- [x] T040 Перевірити й виправити старі worker finalize/cleanup fences та broker→native process happy path, terminal/output receipts без повторної обробки; додати regressions для фактичних прогалин. (FR-009/FR-010/US6.6, partial, HIGH)
- [x] T041 Виконати локальні no-browser/restart/dependency/partial lifecycle і bounded mass-renewal сценарії на migrated PostgreSQL + native agent; перевірити read-only diagnosis, штатно згенерувати локальні DB types, зберегти evidence та межі спостереження. (US6.6/SC-004, partial, HIGH)
- [x] T042 Зібрати актуальний web, усунути bundle-budget failure без підняття ratchet, перевірити збереження artwork/UI structural styles, виконати повний verify та потрібні builds. (Constitution I/VI, plan: verification, partial)
- [x] T043 Оновити findings/ADMIN-TARIFFS та закрити виконані 034 milestones за фактичними доказами; зафіксувати відкладення final packaged beta до релізу за рішенням власника; не комітити чужу роботу автоматично й не змішувати feature completion з незалежною загальнорелізною кампанією 036. (T029/T038, partial)

## Підсумок поточного обсягу — 2026-10-20

Розробка 034 та звичайні перевірки завершені. `npm run verify`: 14/14 gates, 6257 tests,
17 opt-in/platform skips, 0 failures. Окремий actual PostgreSQL/Vault proof: 5/5 до останнього
посилення preflight fences; нові fences перевірені повним migration-chain SQL suite та 40 targeted tests.
Живий local-beta broker/native/Keychain/Drive та restricted CLI proof збережені в evidence.
Часткові source_changed/unknown delivery показані чесно, а не як повний успіх.

- [ ] T044 [DEFERRED_BY_OWNER — RELEASE ONLY] Перед релізом виконати релізні gates,
      packaged beta на чистому точному commit та повну LIFE/LOAD кампанію 036.
      Пряма вказівка власника: «релізні то перевірки тільки не роби то вже перед релізом потім».
      Цей пункт не входить у поточний обсяг завершення розробки. Live Windows виключено окремо в T039.

**034 CLOSED — 2026-10-20.** Розробку прийнято та закрито за прямою вказівкою власника «коміть пуш закривай спєку». T044 зберігає відкладені релізні перевірки; його відкритий прапорець не означає незавершену реалізацію 034.
