# Data Model: Переклад транскриптів

Усі таблиці лежать у схемі `private`. На кожній: RLS + `force row level security`, `revoke all` від `public, anon, authenticated, service_role`. Доступ іде через функції, описані в [contracts/database.md](contracts/database.md).

## private.ai_feature_allowances

Денний ліміт функції з моделлю.

| Поле | Тип | Правила |
| --- | --- | --- |
| `feature` | text PK | `^[a-z][a-z0-9_]{2,40}$` |
| `daily_units` | integer not null | `> 0` |
| `updated_at` | timestamptz not null default now() | |

Сід: `('transcript_translation', 9000)`.

## private.ai_allowance_reservations

Резерв ліміту. Використане за день — сума `spent` плюс свіжих `held`.

| Поле | Тип | Правила |
| --- | --- | --- |
| `id` | uuid PK default gen_random_uuid() | |
| `user_id` | uuid not null → auth.users on delete cascade | |
| `feature` | text not null → ai_feature_allowances | |
| `day` | date not null | `private.kyiv_today()` у момент резерву |
| `units` | integer not null | `> 0` |
| `state` | text not null | `held` \| `spent` \| `released` |
| `created_at` | timestamptz not null default now() | |
| `settled_at` | timestamptz | не null для `spent`/`released` |

Індекс `(user_id, feature, day)`. Переходи: `held → spent`, `held → released`. Повторне врегулювання ідемпотентне. `held`, старший за 6 хв, не рахується (вважається повернутим), але зберігає стан для діагностики.

## private.ai_usage_events

Облік кожного виклику моделі. Без тексту.

| Поле | Тип | Правила |
| --- | --- | --- |
| `id` | bigint identity PK | |
| `feature` | text not null | |
| `user_id` | uuid null | on delete set null |
| `subject_id` | uuid null | id перекладу або іншого об'єкта функції |
| `model` | text not null | `^claude-[a-z0-9-]{3,40}$` |
| `outcome` | text not null | `completed` \| `refused` \| `failed` |
| `stop_reason` | text null | ≤ 40 |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | integer not null default 0 | `>= 0` |
| `cost_micro_usd` | bigint not null | `>= 0` |
| `duration_ms` | integer not null | `>= 0` |
| `created_at` | timestamptz not null default now() | індекс `(created_at)`, `(feature, created_at)` |

## private.transcript_translations

| Поле | Тип | Правила |
| --- | --- | --- |
| `id` | uuid PK | |
| `scope` | text not null | `team_video` \| `personal` |
| `team_id` | uuid null → public.teams on delete cascade | not null ⇔ scope=`team_video` |
| `video_id` | uuid null → public.team_materials on delete cascade | not null ⇔ scope=`team_video` |
| `owner_id` | uuid null → auth.users on delete cascade | not null ⇔ scope=`personal` |
| `document_key` | text null | `^[A-Za-z0-9_-]{1,80}$`; not null ⇔ scope=`personal` |
| `source_fingerprint` | text not null | `^v1:[0-9a-f]{64}$` |
| `source_language` | text null | BCP 47 або null |
| `target_language` | text not null | із `TRANSLATION_TARGET_LANGUAGES` (перевірка на межі функції) |
| `status` | text not null | `processing` \| `completed` \| `failed` |
| `failure_code` | text null | not null ⇔ `failed`; `TRANSLATION_REFUSED` \| `TRANSLATION_UNAVAILABLE` \| `TRANSLATION_FAILED` \| `TRANSLATION_TIMEOUT` |
| `segments` | text[] null | not null ⇔ `completed`; довжина = `total_segments` |
| `total_segments` | integer not null | 1…4000 |
| `completed_segments` | integer not null default 0 | 0…total |
| `units` | integer not null | `> 0` |
| `model` | text null | модель, що дала результат (`claude-haiku-5-5`, або `claude-sonnet-5-5`, якщо був фолбек) |
| `reservation_id` | uuid null → ai_allowance_reservations | |
| `requested_by` | uuid not null → auth.users on delete cascade | |
| `created_at`, `updated_at`, `completed_at` | timestamptz | |

Індекси й унікальність:
- `unique (scope_key, target_language, source_fingerprint) where status = 'processing'`, де `scope_key` = `coalesce(video_id::text, owner_id::text || ':' || document_key)` (вираз в індексі);
- те саме `where status = 'completed'`;
- `(team_id, video_id)`, `(owner_id, document_key)`, `(owner_id, source_fingerprint)`.

Тригер `task_cleanup_reference_fence` обов'язковий: є FK на `team_materials`.

### Переходи стану

```text
            begin (резерв held)
                  │
             processing ──progress──► processing
             │        │        │
   complete  │  fail  │  >5 хв │ (читання/наступний begin)
             ▼        ▼        ▼
         completed  failed  failed(TRANSLATION_TIMEOUT)
         (spent)  (released) (released)
```

Після `completed` видаляються старі `completed` тієї ж області й мови з іншим відбитком. `failed` рядки старші за 7 днів прибираються при наступному `begin` тієї ж області.

## Похідні значення (клієнт)

- **Варіант тексту**: `{ kind: 'original' | 'translation', language, segments, status, progress, stale }`. `stale = translation.source_fingerprint !== fingerprint(current original)`.
- **Вартість**: `translationUnits(segments)` зі shared. Для запуску сервер рахує її сам; клієнт показує свій підрахунок, вони збігаються, бо модуль спільний.
