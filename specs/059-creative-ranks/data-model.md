# Data model — 059 Ранги креативів

Одна міграція `supabase/migrations/2026121718xxxx_creative_ranks.sql` (номер — наступний вільний на момент
коміту). Усі функції — `security definer`, `set search_path = ''`, повні імена. Бізнес-помилки —
`PT409` (конфлікт) або `42501` (немає права), ніколи не `40001` (інцидент 2026-11-17).

## `public.team_creative_launch_events` — журнал (append-only)

| Колонка                 | Тип                                     | Примітка                                                                                  |
| ----------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------- |
| `id`                    | bigint identity PK                      |                                                                                           |
| `team_id`               | uuid not null → teams on delete cascade |                                                                                           |
| `material_id`           | uuid not null                           | креатив (відео). Без FK на `team_materials`: журнал переживає жорстке видалення матеріалу |
| `source_kind`           | text not null                           | `launch` або `catalog`; бекфіл позначається окремо `backfilled`                           |
| `source_id`             | uuid not null                           | launch id або catalog material id                                                         |
| `occurred_at`           | timestamptz not null                    | час успіху / створення каталогу                                                           |
| `counted`               | boolean not null                        | чи дала подія +1 у проєкцію                                                               |
| `absorbed_by_launch_id` | uuid null                               | каталог, поглинутий Launch-ом (R3)                                                        |
| `backfilled`            | boolean not null default false          | подія з бекфілу (R5)                                                                      |
| `created_at`            | timestamptz default now()               |                                                                                           |

Обмеження: `unique (team_id, source_kind, source_id)`; `check (source_kind in ('launch','catalog'))`;
`check (absorbed_by_launch_id is null or source_kind = 'catalog')`.
Індекси: `(team_id, material_id, occurred_at desc)` для діагностики.
Доступ: RLS on, `revoke all` від anon/authenticated; читання лише через CLI (analytics RO роль: `grant select`)
і RPC.

## `public.team_creative_ranks` — проєкція

| Колонка                  | Тип                                                   | Примітка                                                         |
| ------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------- |
| `team_id`, `material_id` | uuid, PK разом                                        |                                                                  |
| `launch_count`           | integer not null default 0, ≥ 0                       | лише зростає                                                     |
| `rank_credit`            | integer not null default 0, ≥ 0                       | рахунок ліги; зростає з `counted`-подіями, падає лише пониженням |
| `last_launched_at`       | timestamptz null                                      | max(occurred_at) усіх подій, включно з поглинутими               |
| `demoted_at`             | timestamptz null                                      |                                                                  |
| `demoted_by`             | uuid null → auth.users on delete set null             |                                                                  |
| `demote_reason`          | text null check in (`disappointed`, `never_launched`) |                                                                  |
| `demote_request_key`     | text null                                             | ідемпотентність останнього пониження                             |
| `version`                | bigint not null default 1                             | CAS для пониження, +1 на кожну зміну                             |
| `updated_at`             | timestamptz not null default now()                    |                                                                  |

Доступ: RLS on, `revoke all`; читання — RPC `list_creative_ranks`; запис — лише тригери й RPC пониження.

## Правила переходів

```text
launch succeeded (перший для launch) ─┬─ revision має каталог C з непоглинутою подією catalog
                                      │     → C.absorbed_by_launch_id = launch; launch.counted = false
                                      └─ інакше → launch.counted = true
catalog inserted ─┬─ C уже в ревізії Launch з зарахованою подією launch → counted = false, absorbed
                  └─ інакше → counted = true
revision catalog attached (C до ревізії Launch L) ─ L уже зарахований, подія C непоглинута, той самий креатив
                  → C.absorbed_by_launch_id = L, counted = false, проєкція −1 (перегенерація = той самий запуск)
launch succeeded  → також поглинаються каталоги всіх інших ревізій L (скасована перша спроба)
counted = true   → launch_count += 1, rank_credit += 1
будь-яка подія   → last_launched_at = greatest(last_launched_at, occurred_at), version += 1
поглинання C     → якщо C.counted був true, а launch.counted = false — проєкція не змінюється (+1 уже є)
demote(target_credit, reason) → rank_credit = target_credit (< поточного), demoted_* , version += 1
```

## Ліга і свіжість (`apps/web/src/team/ranks/creativeRanks.ts`, не в БД)

```text
CREATIVE_RANK_LEAGUES   = wax 0 · bronze 1 · silver 5 · gold 12 · diamond 25   (за rank_credit)
CREATIVE_RANK_FRESHNESS = fresh ≤ 14 д · dusty ≤ 60 д · cobweb > 60 д          (за last_launched_at)
reason disappointed   → target = поріг ліги на одну нижче поточної
reason never_launched → target = 0 (Віск)
```

Креатив без рядка проєкції = `wax`, `fresh`, `launch_count = 0`, без дати.
