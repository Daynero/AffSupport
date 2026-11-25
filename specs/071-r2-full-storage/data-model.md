# Data Model: 071 Повний переїзд сховища на R2

Нові таблиці лежать у `public` з RLS `enable` + `force`, як усі team-таблиці (Факт: `team-workspace.test.sql` це перевіряє). Конфіг і службові таблиці лежать у `private`.

## Зміни наявних таблиць

### `public.teams`

| Стовпець | Тип | Правило |
| --- | --- | --- |
| `storage_backend` | `text not null default 'drive'` | `check in ('drive','r2')`; переходить тільки `drive → r2` (тригер відхиляє зворотну зміну, код `STORAGE_BACKEND_IRREVERSIBLE`) |
| `storage_quota_bytes_override` | `bigint null` | ручна квота простору; `null` означає «норма × учасники» |

Новий простір отримує `r2`, коли `private.storage_r2_config.new_spaces_on_r2 = true`.

### `public.team_drive_connections`

- `drive_kind` дозволяє ще `'soty_r2'`.
- `credential_id` стає `null`-able; `check ((drive_kind = 'soty_r2') = (credential_id is null))`.
- Для `soty_r2`: `root_folder_id = 'r2root_' || team_id`, `root_folder_name = 'Soty'`.
- Одна `soty_r2`-підключка на простір (`unique (team_id) where drive_kind = 'soty_r2'`).

### `public.team_materials`

| Стовпець | Тип | Правило |
| --- | --- | --- |
| `storage_object_id` | `uuid null references team_storage_objects(id)` | обов'язковий для `kind='file'` у `soty_r2`-підключенні; `null` для папок і для Drive |
| `lifecycle` | розширено | `check in ('active','trashed','missing','archived_drive')` |

- Для R2: `drive_file_id = 'r2_' || gen_random_uuid()`, `parent_folder_id` — `drive_file_id` батьківської папки або `root_folder_id`.
- `drive_version` для R2 = `storage_object_id::text` активної версії (так наявні перевірки «версія змінилась» працюють без змін).
- `checksum` для R2 = SHA-256 hex.
- Пошук, теги, GEO, мова, оффер, транскрипт, `preview_state` — без змін.

### `public.team_product_catalogs`

| Стовпець | Тип | Правило |
| --- | --- | --- |
| `feed_object_key` | `text null` | `f/<32 hex>.csv` у медіабакеті |
| `feed_url` | `text null` | повний публічний URL; незмінний після створення |
| `feed_etag` | `text null` | ETag останнього запису (для `If-Match`) |
| `feed_revision` | `bigint not null default 0` | +1 на кожен запис |
| `feed_published_at` | `timestamptz null` | |
| `feed_source_confirmed_at` | `timestamptz null` | учасник позначив «URL підключено в Meta» |

Для R2-каталогу Sheets-стовпці (id таблиці, посилання) лишаються `null`. Для каталогу, перенесеного переходом, вони зберігаються для історії.

## Нові таблиці

### `public.team_storage_objects`

| Стовпець | Тип | Правило |
| --- | --- | --- |
| `id` | `uuid pk` | |
| `team_id` | `uuid not null references teams on delete cascade` | тригер `before delete` ставить tombstone (`reason='team_deleted'`) на кожен `ready`-об'єкт; tombstones без FK переживають каскад (як 050) |
| `bucket` | `text not null` | `'media' \| 'private'` (FR-002) |
| `object_key` | `text not null unique` | за FR-003: `v/`, `i/`, `t/`, `f/` у `media`, `p/` у `private`, далі 32 hex з CSPRNG; `check` на формат і відповідність `bucket` |
| `public_url` | `text null` | для `media`: `<media origin>/<object_key>`; незмінний; `null` для `private` |
| `class` | `text not null` | `'original' \| 'derived'` |
| `role` | `text null` | для `derived`: `'thumbnail' \| 'poster' \| 'landing_render' \| 'restitch_screen' \| 'restitch_copy' \| 'catalog_image'` |
| `usage_category` | `text not null` | категорія смуги FR-028a: `'video' \| 'catalog_versions' \| 'images' \| 'files' \| 'system'`; виводиться на фіналізації з `bucket`, `class`, `role` і типу; кошик рахується за `lifecycle` матеріалу, а не цим полем |
| `parent_object_id` | `uuid null references team_storage_objects` | для похідних |
| `size_bytes` | `bigint not null check (size_bytes >= 0)` | після фіналізації |
| `content_type` | `text not null` | визначений за вмістом |
| `sha256` | `text null` | hex, 64 символи |
| `state` | `text not null` | `'uploading' \| 'ready' \| 'tombstoned' \| 'deleted'` |
| `created_by` | `uuid not null` | |
| `created_at`, `ready_at` | `timestamptz` | |

Переходи станів: `uploading → ready` (фіналізація), `uploading → deleted` (скасування; без tombstone, бо об'єкта немає або є лише частини), `ready → tombstoned → deleted`. Інших переходів немає; `tombstoned → ready` тільки адміністративним відновленням до `not_before`.

Зайнято простором: `sum(size_bytes) where state = 'ready'` плюс активні резерви. Підтримується лічильником у `team_storage_usage` (тригер), а не `sum` на кожен запит.

### `public.team_storage_usage`

`team_id pk`, `ready_bytes bigint`, `reserved_bytes bigint`, `object_count integer`, `bytes_by_category jsonb` (`{video, catalog_versions, images, files, trash, system}`, сума = `ready_bytes`), `updated_at`. Оновлюється тригерами на `team_storage_objects` і `team_storage_upload_sessions`. Нічні звірки перераховують з нуля й пишуть розбіжність в аналітику.

### `public.team_storage_upload_sessions`

| Стовпець | Тип | Правило |
| --- | --- | --- |
| `id` | `uuid pk` | |
| `team_id`, `object_id` | | об'єкт у стані `uploading` |
| `r2_upload_id` | `text not null` | ідентифікатор multipart |
| `declared_bytes` | `bigint not null` | резерв квоти |
| `part_bytes` | `integer not null` | 16 МБ за замовчуванням |
| `parts_total` | `integer not null` | |
| `parts_done` | `jsonb not null default '[]'` | `[{n, etag, size}]` |
| `source` | `text not null` | `'browser' \| 'agent' \| 'import'` |
| `purpose` | `jsonb not null` | куди потрапить результат: нова папка/матеріал, вкладення завдання, overwrite матеріалу, вихід процесу |
| `owner_user_id` | `uuid not null` | |
| `expires_at` | `timestamptz not null` | 24 години від старту |
| `state` | `text not null` | `'open' \| 'finalizing' \| 'done' \| 'aborted' \| 'expired'` |

### `private.storage_tombstones`

| Стовпець | Тип | Правило |
| --- | --- | --- |
| `object_key` | `text pk` | без FK: переживає каскади (як tombstones 050) |
| `team_id` | `uuid not null` | без FK |
| `bucket` | `text not null` | `'media' \| 'private'`; для `media` робітник після `DeleteObject` очищає CDN за URL |
| `reason` | `text not null` | `'trash_expired' \| 'user_purge' \| 'overwrite' \| 'team_deleted' \| 'upload_aborted' \| 'derived_orphan'` |
| `not_before` | `timestamptz not null` | `created + 7 days` (для `upload_aborted` — `now()`) |
| `paused` | `boolean not null default false` | запобіжник FR-021 |
| `lease_until`, `attempts`, `last_error` | | робітник |
| `deleted_at` | `timestamptz null` | |

### `public.team_storage_object_uses`

Хто тримає медіаоб'єкт живим (FR-019a). `object_id`, `team_id`, `holder_kind` (`'catalog_feed'`), `holder_id` (каталог), `created_at`; `primary key (object_id, holder_kind, holder_id)`. Запис фіда в одній транзакції замінює набір uses каталогу на набір URL, що реально є у фіді. Tombstone на об'єкт ставиться тільки коли (матеріал видалено назавжди) і (uses порожній). Перманентне видалення каталогу видаляє його uses і ставить tombstone на фід.

### `public.team_storage_catalog_footprint` (view)

На каталог: `catalog_id`, `versions_count`, `held_bytes` (усі об'єкти з uses каталогу), `exclusive_bytes` (тільки цей каталог тримає, і об'єкт не є матеріалом бібліотеки; FR-028b), `last_published_at`. Читається екраном «Сховище» з RLS простору.

### `public.team_share_links`

`token_hash text pk` (SHA-256 токена; сам токен не зберігається), `team_id`, `material_id`, `created_by`, `expires_at` (7 днів), `revoked_at`, `last_used_at`, `use_count`.

### `public.team_storage_cutover_runs`

| Стовпець | Тип | Правило |
| --- | --- | --- |
| `id` | `uuid pk` | |
| `team_id` | `uuid not null unique` | один перехід на простір |
| `scheduled_for` | `timestamptz not null` | дата з банера |
| `state` | `text not null` | `'scheduled' \| 'running' \| 'completed' \| 'failed'` |
| `steps` | `jsonb not null default '{}'` | `{step: {done_at, detail}}` для кроків FR-024 |
| `created_by` | `uuid not null` | адміністратор Soty |
| `error_code` | `text null` | |

### `private.storage_r2_config`

Один рядок: `enabled boolean default false`, `policy_confirmed_at timestamptz null`, `new_spaces_on_r2 boolean default false`, `per_member_quota_bytes bigint default 16106127360` (15 ГіБ), `max_object_bytes bigint default 5368709120`, `part_bytes integer default 16777216`, `trash_days integer default 30`, `tombstone_grace interval default '7 days'`, `share_link_ttl interval default '7 days'`, `mass_delete_objects integer default 1000`, `mass_delete_bytes bigint default 53687091200`.

Фіча видима, тільки коли `enabled` і `policy_confirmed_at is not null` **і** серверний runtime-конфіг R2 бібліотеки пройшов `TARGET_CONFIRMATION` (як 045/050).

## Квота

```
quota(team) = coalesce(storage_quota_bytes_override,
                       per_member_quota_bytes * active_member_count(team))
admit(upload) = ready_bytes + reserved_bytes + declared_bytes <= quota(team)
```

Матеріали в кошику (`lifecycle='trashed'`, об'єкт `ready`) враховуються. `tombstoned` не враховуються.

## Коди помилок (додаються до `team_error_codes`)

`STORAGE_DISABLED`, `STORAGE_QUOTA_EXCEEDED`, `STORAGE_OBJECT_TOO_LARGE`, `STORAGE_UPLOAD_EXPIRED`, `STORAGE_UPLOAD_MISMATCH` (розмір або SHA-256), `STORAGE_CONTENT_REJECTED`, `STORAGE_UNAVAILABLE`, `STORAGE_BACKEND_IRREVERSIBLE`, `STORAGE_DELETION_PAUSED`, `STORAGE_CUTOVER_IN_PROGRESS`, `AGENT_UPDATE_REQUIRED`, `SHARE_LINK_EXPIRED`, `CATALOG_FEED_CONFLICT`.
