# План реалізації: тарифи на простір

**Специфікація**: [spec.md](./spec.md) · **Гілка**: `beta` (робота в основній лінії, як 026–033)

## Підсумок

Доступ до простору перестає залежати від «у просторі є учасник-адмін» і починає залежати від тарифу власника. Тариф —
запис про період у базі; каталог тарифів — дані. Уся перевірка — у Postgres (одна функція стану, через яку проходять
`private.can`, лобі, запрошення й фонові воркери). Веб лише показує стан, який повертає сервер. Листи — новий edge
function `tariff-notices` на тому ж Resend, що й запрошення; запускається з cron без нового секрету.

## Технічний контекст

- **Стек**: Postgres (Supabase) + PL/pgSQL, Deno edge functions, React 19 + HeroUI v3 (інвентар `components/ui`), shared
  TypeScript (`packages/shared`), vitest + PGlite (`tests/support/team-db.ts`).
- **Обмеження**: секрети не записуємо (повторно використовуємо `wishly_catalog_sync_secret` і похідну URL, як
  `private.catalog_updater_endpoint`); жодних `db reset`; слабка машина — тести по одному файлу, single-worker.
- **Сумісність**: стара веб-збірка має працювати з новою базою (сигнатури наявних RPC не ламаємо; `can_access_team_workspace`
  лишається boolean; нові поля — лише додаткові).
- **Час**: строк — `ends_on date`; кінець = початок наступної доби за `Europe/Kyiv`; пільга = +3 доби. Уся арифметика — у SQL.

## Рішення (research)

- **R1 — одна функція стану.** `private.space_tariff_state(p_team uuid)` повертає рядок: `state`
  (`active|expiring|grace|blocked|legacy|none`), `plan_code`, `seats_total`, `seats_used`, `ends_at`, `grace_until`,
  `days_left`, `features text[]`, `tariff_id`. Усе інше читає її, тож немає двох способів порахувати «скільки лишилось».
- **R2 — прив'язка тарифу до простору.** Тариф має `team_id` (nullable). Видача на пошту власника, який має рівно один
  власний активний простір, прив'язує одразу; без простору — прив'язується при `create_team`; кілька власних просторів
  (старі) — адміністратор вибирає простір у діалозі видачі.
- **R3 — пошта без акаунта.** `owner_email citext` + `owner_id uuid null`. Збіг — за підтвердженою поштою
  (`private.team_confirmed_email`). `owner_id` заповнюється ліниво першим викликом `get_my_space_access()`; тригер на
  `auth.users` не чіпаємо.
- **R4 — старе правило паралельно.** Налаштування `legacy_rule_enabled` (за замовчуванням `true`). Доступ =
  `tariff in (active, expiring, grace)` **або** (`legacy_rule_enabled` **і** старе правило). Тести, що спираються на
  «власник = адмін», лишаються зеленими без змін.
- **R5 — місця.** `seats_used = активні учасники + pending-запрошення, що не прострочені`. Перевірка в `create_invitation`,
  `resend_invitation` (лише якщо запрошення вже прострочене), `accept_invitation` (активні учасники ≤ місць),
  `service_direct_add_registered_member`. Новий код помилки `SEATS_FULL` (додати в `TEAM_ERROR_CODES`). Простори лише на
  старому правилі зберігають наявну межу 50.
- **R6 — блокування фону.** Фільтр «простір доступний» у: `service_open_catalog_updater_rounds` і claim оновлювача,
  `private.claim_catalog_sync_jobs` і `private.invoke_catalog_sync_worker`, `service_claim_preview_warm`; ручні resync-RPC
  (`request_team_catalog_resync`, `request_team_folder_resync`) отримують явну перевірку. Підготовка копій і операції
  агента вже йдуть через `private.can` — закриваються автоматично. Плюс періодичний `private.apply_tariff_blocks()`: для
  заблокованих просторів зупиняє оновлювач (`state='stopped'`, `stopped_by_tariff_at=now()`, `retire_restitch_spares`).
- **R7 — відновлення.** Продовження/нова видача відкриває одразу (стан рахується на льоту). Оновлювач не вмикається сам;
  `stopped_by_tariff_at` лишається, і власник бачить пропозицію «увімкнути знову»; увімкнення його скидає.
- **R8 — попередження.** `private.queue_tariff_notices()` (cron щогодини) створює рядки `space_tariff_notices` з унікальністю
  `(tariff_id, kind, period_end)` — продовження змінює `period_end`, тож старі попередження не дублюються й не
  надсилаються за новий строк. Потім — `net.http_post` на `tariff-notices` з тим самим секретом воркерів. Edge function
  бере pending-листи через service-RPC, шле Resend, позначає `sent/failed` (до 3 спроб). Банер не залежить від листа:
  він приходить з `get_my_space_access()`.
- **R9 — лобі й заблокований простір.** `list_my_teams` повертає й заблоковані простори з полем `access_state`, щоб веб
  показав екран «доступ призупинено», а не «вас видалили». Зміна типу повернення — `drop function` + `create`.
- **R10 — вітрина.** `get_my_space_access()` повертає `mode`: `workspace` (є доступний простір або можна створити),
  `blocked` (є простори, усі заблоковані), `showcase` (нічого немає). Для `showcase` — каталог тарифів з `showcase=true`,
  контакт адміністратора, чи людина в списку очікування, її пошта.
- **R11 — `profiles.plan`.** Наявне поле `free|pro|team` не використовується для доступу; не чіпаємо й не плутаємо з тарифами.
  Слово «entitlement» зайняте токеном агента — у коді тарифів не вживаємо.
- **R12 — масштабування (US8).** `tariff_plans` — каталог (код, назви, базові місця, запрошення, докупівля, можливості,
  порядок, вітрина, активний). `space_tariffs.source` (`manual` зараз). Майбутня оплата додасть джерело й процес видачі,
  а не нову перевірку доступу.

## Модель даних

```
public.tariff_plans (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{1,31}$'),
  name_uk text not null, name_en text not null,
  summary_uk text not null, summary_en text not null,
  base_seats int not null check (base_seats between 1 and 500),
  invites_allowed boolean not null,
  extra_seats_allowed boolean not null,
  features text[] not null default '{}',
  showcase boolean not null default true,
  sort_order int not null default 0,
  active boolean not null default true
)  -- seed: solo (1, false, true), lead (3, true, true)

public.space_tariffs (
  id uuid pk default gen_random_uuid(),
  owner_email citext not null,
  owner_id uuid null references profiles(id) on delete set null,
  team_id uuid null references teams(id) on delete set null,
  plan_code text not null references tariff_plans(code),
  extra_seats int not null default 0 check (extra_seats between 0 and 500),
  starts_at timestamptz not null default now(),
  ends_on date not null,
  revoked_at timestamptz null,
  source text not null default 'manual' check (source in ('manual')),
  granted_by uuid not null, created_at, updated_at
)
unique (lower(owner_email)) where revoked_at is null      -- один чинний тариф на власника
unique (team_id) where revoked_at is null and team_id is not null

public.space_tariff_events (id, tariff_id, actor_id, kind, before jsonb, after jsonb, created_at)
public.space_tariff_notices (id, tariff_id, kind check in ('warn_3d','warn_1d','grace','blocked'),
  period_end date, state check in ('pending','sent','failed'), attempts int, last_error text,
  created_at, sent_at, unique (tariff_id, kind, period_end))
public.tariff_settings (id boolean pk default true check (id), admin_contact text, legacy_rule_enabled boolean default true)
alter table team_catalog_updaters add column stopped_by_tariff_at timestamptz
```

Усі таблиці: RLS увімкнено й примусово, `revoke all` від `anon, authenticated`; читання й запис — лише через функції.

## Контракти (RPC)

Клієнт (authenticated):

- `get_my_space_access() → jsonb` — `{ mode, canCreate, teams:[{teamId, name, role, accessState}], tariff: {planCode,
planName, state, endsOn, endsAt, graceUntil, daysLeft, seatsTotal, seatsUsed, invitesAllowed} | null, banner:
{kind, endsAt, graceUntil, updaterRunning} | null, showcase: {plans:[…], adminContact, waitlisted, email} | null }`.
  Банер — лише власнику для `warn_3d|warn_1d|grace`; `blocked` — усім учасникам.
- `get_team_tariff(p_team) → jsonb` — стан для простору (учасникам: лише `state`, `seatsTotal`, `seatsUsed`,
  `invitesAllowed`; власнику — усе з R1) + `updaterStoppedByTariff`.
- `can_access_team_workspace() → boolean` — без зміни сигнатури, нова логіка.
- `list_my_teams()` — додає `access_state`.

Адміністратор (`is_admin()`):

- `admin_list_space_tariffs() → setof jsonb` — з `state`, `daysLeft`, `seatsUsed/Total`, власник, простір, джерело.
- `admin_grant_space_tariff(p_email, p_plan, p_ends_on, p_extra_seats, p_team default null) → jsonb`
- `admin_update_space_tariff(p_id, p_plan, p_ends_on, p_extra_seats) → jsonb` — не нижче зайнятих місць (`SEATS_IN_USE`).
- `admin_revoke_space_tariff(p_id) → jsonb`
- `admin_list_space_tariff_events(p_id) → setof jsonb`
- `admin_list_tariff_members(p_team) → setof jsonb`, `admin_remove_tariff_member(p_team, p_user) → boolean`
- `admin_list_legacy_spaces() → setof jsonb` — простори, відкриті лише старим правилом.
- `admin_get_tariff_settings() / admin_set_tariff_settings(p_admin_contact, p_legacy_rule_enabled)` — вимкнення старого
  правила відмовляє, доки є простори лише на ньому (`LEGACY_SPACES_REMAIN`), якщо не передано явне підтвердження.
- `admin_list_tariff_plans()`.

Сервіс (service_role): `service_claim_tariff_notices(p_limit)`, `service_finish_tariff_notice(p_id, p_sent, p_error)`.

Edge function `tariff-notices` (verify_jwt=false, `x-catalog-sync-secret`): бере листи, будує текст (uk+en, як
запрошення), шле через спільний `_shared/email.ts` (винести з `team-invitations/email.ts`), фіксує результат.

## Веб

- `packages/shared/src/team/tariffs.ts` — типи й парсери відповідей (`parseSpaceAccess`, `parseTeamTariff`, `parseAdminTariff`).
- `apps/web/src/api/team.ts` — обгортки RPC.
- `TeamSpace.tsx` — замість модалки «список очікування» — `SpaceShowcase` (US7) для `showcase`, `SpaceBlocked` для `blocked`;
  `MembershipLostNotice` не показується для заблокованого простору.
- `WorkspaceShell.tsx` — `TariffBanner` між шапкою й вкладками (Alert warning/error, дія «Написати адміністратору»).
- `InvitationPanel.tsx` — «Місць: N з M», недоступність із поясненням; `SEATS_FULL` → зрозумілий текст.
- Оновлювач каталогів — пропозиція «увімкнути знову», коли `updaterStoppedByTariff`.
- `AdminPage.tsx` — картка «Тарифи»: таблиця (стан, днів лишилось, місця), фільтр «закінчуються за 3 дні», діалоги
  «Видати», «Змінити», «Відкликати», журнал, учасники тарифу, «Простори на старому правилі», контакт і перемикач.
- i18n uk+en; токени й компоненти лише з дизайн-системи.

## Розгортання

1. Міграція (стара логіка лишається ввімкненою → для всіх нічого не змінюється).
2. Edge function `tariff-notices` + `team-invitations` (спільний email-модуль).
3. Веб.
4. Адміністратор видає тарифи наявним власникам; коли список «на старому правилі» порожній — вимикає старе правило.

## Тести

- `tests/space-tariffs-sql.test.ts` (PGlite): стан і час (Kyiv, пільга, відкликання), доступ і `private.can`, старе
  правило та його вимкнення, місця в запрошеннях/прийнятті/direct-add, `create_team` для власника тарифу, лінива
  прив'язка пошти, `list_my_teams.access_state`, адмін-RPC і журнал, `SEATS_IN_USE`, блокування фону (фільтри claim,
  `apply_tariff_blocks`), черга попереджень без дублів і з урахуванням продовження.
- `tests/tariff-notices.test.ts` — edge handler з підставними залежностями (секрет, відправка, повтори).
- `tests/space-tariffs-contract.test.ts` — парсери shared.
- UI-тести не пишемо (рішення власника); перевірка інтерфейсу — на беті.
