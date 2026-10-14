# План реалізації: тарифи на простір

**Специфікація**: [spec.md](./spec.md) · **Гілка**: `beta`

## Підсумок

Доступ до простору залежить від тарифу простору (або внутрішнього статусу простору адміністратора, або старого правила,
доки воно ввімкнене). Тариф — запис про період; каталог тарифів — дані. Перевірка — у Postgres: дешева SQL-функція
`private.team_workspace_allowed`, через яку проходять `private.can`, `private.team_role`, лобі, запрошення й фонові claim-и.
Стан для людей рахує `private.space_tariff_state`. Листи — edge function `tariff-notices` на тому ж Resend, що й запрошення,
запускається cron-ом без нового секрету.

## Технічний контекст

- Postgres (Supabase) + PL/pgSQL, Deno edge functions, React 19 + HeroUI v3 (`components/ui`), `packages/shared`,
  vitest + PGlite (`tests/support/team-db.ts` — застосовує всі міграції за іменем).
- Секрети не записуємо: URL edge function — похідна від `wishly_catalog_sync_url` (як `private.catalog_updater_endpoint`),
  секрет — `wishly_catalog_sync_secret` / `CATALOG_SYNC_SECRET`, заголовок `x-catalog-sync-secret`.
- Стара веб-збірка працює з новою базою: сигнатури й типи наявних RPC не змінюються (`list_my_teams`,
  `can_access_team_workspace` — ті самі); нове — лише нові RPC і нові необов'язкові поля.
- `citext` пишемо як `extensions.citext`. Часовий пояс `Europe/Kyiv` (перевірити наявність у PGlite; запасний — `Europe/Kiev`).

## Рішення

- **R1 Стан.** `private.space_tariff_state(p_team uuid, p_at timestamptz default now())` → `state`
  (`internal|legacy|active|expiring|grace|blocked|none`), `tariff_id`, `plan_code`, `seats_total`, `seats_used`, `ends_on`,
  `ends_at`, `grace_until`, `days_left`. `ends_at = private.kyiv_day_end(ends_on)`, `grace_until = kyiv_day_end(ends_on+3)`,
  `days_left = ends_on - (p_at at time zone 'Europe/Kyiv')::date`. `expiring` — `days_left ≤ 3`. Відкликано
  (`revoked_at ≤ p_at`) → `blocked`. Порядок: `internal` (власник у `admin_users`) → тариф діє/після строку →
  `legacy` (правило ввімкнене й виконується) → `blocked` (є прив'язаний тариф, що минув чи відкликаний) → `none`.
  Стан `legacy` має пріоритет над `expiring/grace` для попереджень (US2.2): якщо старе правило ввімкнене й виконується,
  попереджень немає.
- **R2 Шлюз.** `private.team_workspace_allowed(p_team)` — `language sql stable`, лише індексні пошуки: команда активна і
  (власник — адмін; або є тариф з `team_id`, не відкликаний, `now() < kyiv_day_end(ends_on+3)`; або налаштування
  `legacy_rule_enabled` і є активний учасник-адмін). `private.team_role` повертає `null`, якщо простір недоступний (одна
  точка для всіх функцій на `team_role`); `leave_team` і `delete_draft_team` перевіряють членство напряму й лишаються.
- **R3 Власник і прив'язка.** `space_tariffs.owner_email extensions.citext`, `owner_id uuid null`, `claimed_at`.
  `private.claim_space_tariffs(user)` ставить `owner_id` для рядків з `owner_id is null and claimed_at is null`, де пошта
  збігається з `private.team_confirmed_email(user)`. Викликається з `get_my_space_access`, `can_access_team_workspace`,
  `create_team`. Видалення профілю власника (`owner_id` → set null тригером) — відкликає тариф. Прив'язка до простору
  (`team_id`) — явно: адмін вибирає простір у діалозі видачі (підставлено, якщо власний простір один); без простору —
  `create_team` прив'язує перший чинний неприв'язаний тариф власника.
- **R4 Унікальність.** `unique(team_id) where revoked_at is null and team_id is not null`; неприв'язаний чинний тариф —
  не більше одного на пошту (`unique(lower(owner_email)) where revoked_at is null and team_id is null`).
- **R5 Місця.** `private.team_seats_total(team)` (базові + додаткові з тарифу; внутрішній чи лише legacy — 50),
  `private.team_seats_used(team)` = активні учасники без `admin_users` + `team_invitations` `state='pending' and
expires_at > now()`. Перевірки (`SEATS_FULL`): `create_invitation`; `resend_invitation` лише коли `expires_at <= now()`;
  `accept_invitation` — активні учасники (без адмінів) `< seats_total` (поточне запрошення не рахуємо; рядок команди вже
  блокується); `service_direct_add_registered_member`. Запрошувати можна, якщо `invites_allowed or seats_total > 1`.
  `admin_grant_space_tariff` і `admin_update_space_tariff` відмовляють `SEATS_IN_USE`, якщо місць менше за зайняті;
  `admin_preview_space_tariff` повертає зайнятих і рекомендовані додаткові місця.
- **R6 Фон.** Фільтр `private.team_workspace_allowed` у: `service_open_catalog_updater_rounds`,
  `private.claim_catalog_updater_items`, `private.claim_catalog_sync_jobs` (+ `private.invoke_catalog_sync_worker`),
  `service_claim_preview_warm`, `service_claim_archive_inspections`, `service_claim_retired_restitch_copies`,
  `service_claim_orphan_cleanups`; `sweep_catalog_sync_orphans` пропускає недоступні простори. Ручні resync —
  через `team_role` (R2). Restitch-claim і операції агента — через `private.can`.
- **R7 Пауза оновлювача.** `team_catalog_updater_items.paused_interval interval` + `team_catalog_updaters.paused_by_tariff_at`.
  `private.apply_tariff_pauses()` (cron кожні 10 хв, а також при відкликанні «зараз»): для недоступних просторів переносить
  `update_interval → paused_interval`, ставить `update_interval = null`, `paused_by_tariff_at = now()`, викликає
  `private.sync_catalog_updater`. Копії не видаляються. `resume_team_catalog_updater(p_team)` (керування оновлювачем,
  простір доступний): повертає інтервали, `next_run_at = now()`, скидає позначку. `set_team_catalog_update_interval` і
  `run_team_catalog_update_now` теж скидають позначку для свого каталогу.
- **R8 Відновлення синхронізації.** Перехід недоступний → доступний (видача/продовження/скасування відкликання) ставить
  одну звірку `service_enqueue_catalog_reconciliation` для підключення простору.
- **R9 Попередження.** `space_tariff_notices (tariff_id, kind, period_end, state pending|sent|failed|superseded|skipped)`.
  Види: `warn_3d`, `warn_1d`, `grace`, `blocked`, `granted`, `renewed`, `member_nudge`. `private.queue_tariff_notices(p_at)`
  (cron щогодини): для тарифів зі станом не `legacy/internal` створює лише актуальний вид для поточного `ends_on`
  (`unique(tariff_id, kind, period_end)`), старіші непослані того ж строку → `superseded`. `granted/renewed` — з адмін-RPC
  за прапорцем «Повідомити листом». `member_nudge` — `request_space_owner_nudge(team)`, не частіше разу на добу на простір.
  `service_claim_tariff_notices(p_limit)` повторно звіряє `period_end = ends_on` і стан (інакше `superseded`), повертає
  отримувача (пошта власника, мова з профілю), назву простору, дати, тариф, контакт, `updaterRunning`.
  `service_finish_tariff_notice(id, sent, error)` — до 3 спроб. `private.invoke_tariff_notices()` — `net.http_post` при
  наявності pending.
- **R10 Доступ для вебу.** `get_my_space_access()` → `{ mode: workspace|blocked|showcase, canCreate, teams:[{teamId, name,
role, accessState, ownerName}], invitations:[{token?, teamName, inviterName, role}], tariffs:[…для простору/без
простору], banner, toast, showcase:{plans, contact, request, email} }`. `blocked` — лише якщо в людини є простір із
  прив'язаним тарифом, що минув чи відкликаний; інакше `showcase`. `list_my_teams` не змінюється (недоступні простори з
  нього зникають) — новий веб бере призупинені простори з `get_my_space_access.teams`.
- **R11 Заявки.** `team_workspace_waitlist` + `plan_interest`, `channel`, `last_contact_at`, `handled_at`, `admin_note`.
  `join_team_workspace_waitlist(p_plan text default null, p_channel text default null)` — нова сигнатура поруч зі старою
  (стара викликає нову).
- **R12 Передача власності.** `transfer_ownership` → `TARIFF_BOUND`, якщо на простір прив'язано чинний тариф.
- **R13 Каталог.** `tariff_plans(code, name_uk, name_en, summary_uk, summary_en, base_seats, invites_allowed,
extra_seats_allowed, max_extra_seats, billing_period, highlight, features, showcase, sort_order, active)`; seed solo/lead.
  `space_tariffs.source in ('manual','trial')`, `external_ref`, `note`.
- **R14 Налаштування.** `tariff_settings(admin_telegram, admin_email, legacy_rule_enabled)`; Telegram — `^[A-Za-z0-9_]{5,32}$`,
  пошта — валідна; зміни — у `tariff_settings_events`.
- **R15 Нові коди помилок** у `TEAM_ERROR_CODES`: `SEATS_FULL`, `SEATS_IN_USE`, `SPACE_BLOCKED`, `TARIFF_BOUND`,
  `LEGACY_SPACES_REMAIN`, `TARIFF_DATE_INVALID`.

## Контракти адмін-RPC (`is_admin()`)

`admin_list_space_tariffs()`, `admin_preview_space_tariff(p_email, p_team)`, `admin_grant_space_tariff(p_email, p_plan,
p_ends_on, p_extra_seats, p_team, p_note, p_external_ref, p_notify)`, `admin_update_space_tariff(p_id, p_plan, p_ends_on,
p_extra_seats, p_note, p_external_ref)`, `admin_extend_space_tariff(p_id, p_months, p_notify)`,
`admin_end_space_tariff(p_id, p_now boolean)` (відкликання: сьогодні / зараз), `admin_undo_space_tariff_event(p_event)`,
`admin_list_space_tariff_events(p_id)`, `admin_list_tariff_seats(p_team)`, `admin_remove_tariff_member(p_team, p_user)`
(не власника; пише `record_team_audit`), `admin_revoke_tariff_invitation(p_invitation)`, `admin_list_legacy_spaces()`,
`admin_list_owner_spaces(p_email)`, `admin_list_space_requests()`, `admin_mark_space_request(p_user, p_handled, p_note)`,
`admin_get_tariff_settings()`, `admin_set_tariff_settings(p_telegram, p_email, p_legacy_rule_enabled, p_confirm)`,
`admin_list_tariff_plans()`.

## Веб

- `packages/shared/src/team/tariffs.ts` — типи й парсери; коди помилок.
- `api/team.ts` — обгортки; `database.types.ts`, `dev/mock-supabase.ts`.
- `team/tariffs/useSpaceAccess.ts` — опитування `get_my_space_access` (5 с на вітрині/призупиненні, при фокусі, після
  `PERMISSION_DENIED`).
- `team/tariffs/SpaceShowcase.tsx` (сторінка, запрошення зверху, контакт-попап), `SpaceBlocked.tsx`, `TariffBanner.tsx`,
  `contactAdmin.ts` (посилання Telegram/mailto/текст), `SpaceTariffSection.tsx` (налаштування), `UpdaterResumeNotice.tsx`.
- `TeamSpace.tsx` — режими showcase/blocked замість модалки; `TeamContext` не показує «вас видалили» для призупиненого.
- `InvitationPanel.tsx` — лічильник і пояснення замість форми.
- `HomePage.tsx` — нова плитка, позначки власнику, без пожертви на шляху до простору.
- `AdminPage.tsx` — вкладки «Тарифи» | «Аналітика»; `pages/admin/Tariffs*.tsx`.
- i18n uk+en; лише токени й компоненти дизайн-системи.

## Розгортання

Міграція (старе правило ввімкнене → змін для людей немає) → edge functions (`tariff-notices`, `team-invitations`) →
веб → адміністратор переводить простори → вимикає старе правило.

## Тести

`tests/space-tariffs-sql.test.ts` (стан і дати, шлюз і `team_role`, старе правило, внутрішні простори, місця, прив'язка,
`create_team`, передача власності, адмін-RPC і журнал, пауза й відновлення оновлювача, фільтри claim-ів, попередження),
`tests/tariff-notices.test.ts` (edge handler), `tests/space-tariffs-contract.test.ts` (парсери). Наявні SQL-тести мають
лишитися зеленими без змін (старе правило ввімкнене за замовчуванням). UI-тести не пишемо.

## Поправка до R7/R8 — автоматичне відновлення (2026-10-14)

Нове US6.6 supersedes ручне ввімкнення в початковому R7. Поточні RPC та UI описують попередню реалізацію.
Потрібне серверне, ідемпотентне відновлення на переході недоступний → доступний, незалежне від відкритої вкладки;
збереження причини паузи, попереднього активного режиму й кожного інтервалу. Ручне вимкнення/скасування має
перевагу над старим snapshot. Повторне продовження, cron та restart не створюють дубльованих jobs.

Поновлення під час гонки з apply_tariff_pauses має давати стан останнього чинного тарифу; старий worker не
повертає паузу й не публікує неавторизований результат. Використати додаткову міграцію, не переписувати
вже застосовані міграції. Видалити вимогу ручної кнопки в нормальному шляху UI, лишити конкретні дії для
реальних блокерів. Відновлення в чергу ≤60 с, перший актуальний прохід каталогу ≤5 хв за здорових залежностей;
пропущені періоди не відтворюються пачкою. Фонові jobs, незавершені агентні операції та safe checkpoints
потребують окремої перевірки семантики перед реалізацією. Оновити contracts/data-model за результатом планування.

Докази: реальні DB concurrency/regression tests, тест повідомлень UI, read-only diagnosis до доставки результату,
ручні LIFE-021–036 та LOAD-08. Завершені задачі нижче/в tasks.md не доводять готовність цієї поправки.
