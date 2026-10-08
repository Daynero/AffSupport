# Data Model: Картинки ре-стітчу з простору замість сервера

## Нова таблиця `public.team_restitch_sources`

| Колонка         | Тип                                                  | Примітка                                                                                                                |
| --------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `team_id`       | uuid, FK `teams(id)` on delete cascade               |                                                                                                                         |
| `user_id`       | uuid null, FK `auth.users(id)` on delete cascade     | `null` = пул простору; інакше особистий пул учасника                                                                    |
| `slot`          | text check in (`start`,`end`)                        |                                                                                                                         |
| `material_id`   | uuid null, FK `team_materials(id)` on delete cascade | файл-зображення або папка; `null` лише поки джерело `pending`                                                           |
| `drive_file_id` | text null                                            | Drive id папки, ще не проіндексованої каталогом; при наступному `list`/`draw` резолвиться в `material_id` і обнуляється |
| `kind`          | text check in (`file`,`folder`)                      | перевіряється при записі проти `team_materials.kind`/`category`; для `drive_file_id` лише `folder`                      |
| `sort_order`    | integer                                              | порядок додавання                                                                                                       |
| `added_by`      | uuid null, FK `auth.users(id)` on delete set null    |                                                                                                                         |
| `added_at`      | timestamptz default now()                            |                                                                                                                         |

Check: рівно одне з `material_id`/`drive_file_id` не null.
Унікальність: `(team_id, slot, coalesce(material_id::text, drive_file_id), coalesce(user_id, '00000000-0000-0000-0000-000000000000'))`.
RLS увімкнено; `revoke all`; `grant select (team_id, user_id, slot, material_id, kind, sort_order)`
to authenticated під політикою «учасник команди з `view`»; запис лише через функції.

## Зміни наявних таблиць

- `team_restitch_defaults` і `team_member_restitch_preferences`:
  `+ source_mode text not null default 'legacy' check in ('legacy','drive')`.
  Колонки `start_image_ids`/`end_image_ids` лишаються як legacy; у режимі
  `drive` вони порожні і ніким не читаються.
- `configured` для режиму `drive` більше не похідне від uuid[]: функція
  запису ставить `configured = true`, а **ефективна** налаштованість
  обчислюється на читанні (див. стани).

## Обчислювані сутності (не зберігаються)

**Ефективний набір** (`private.restitch_pool_images(p_team, p_user, p_slot)`):
рекурсивно розгортає папки-джерела (`lifecycle='active'`), бере матеріали з
`category='image'`, `lifecycle='active'`, `mime_type in ('image/png','image/jpeg','image/webp')`,
`size_bytes between 1 and 52428800`, розширення імені в (`png`,`jpg`,`jpeg`,`webp`),
`checksum is not null`; `distinct on (checksum)` зі стабільним порядком
`(name, id)`; `limit 500`.

**Джерело з доступністю** (`list_restitch_sources`): кожне джерело +
`availability`:

| Значення       | Коли                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------- |
| `available`    | `lifecycle='active'` і (папка, або файл придатний)                                          |
| `trashed`      | `lifecycle='trashed'`                                                                       |
| `missing`      | `lifecycle='missing'`, `missing_reason='removed'`                                           |
| `out_of_root`  | `lifecycle='missing'`, `missing_reason='out_of_root'`                                       |
| `unsupported`  | файл активний, але не проходить фільтр формату/розміру                                      |
| `pending`      | джерело записане за `drive_file_id`, каталог його ще не проіндексував                       |
| `disconnected` | підключення простору не в стані `connected`; усі джерела, стан пулу `empty` з цією причиною |

Для папки додатково `image_count` (придатних у піддереві) і `skipped`
jsonb `{format: n, size: n, animated: n}`. `animated` на сервері визначається за
`mime_type` (`image/gif`, `image/apng`); анімований WebP/APNG з «нерухомим» mime
відсікає агент при перенесенні (кадрів > 1) з кодом `RESTITCH_SCREEN_UNSUPPORTED`,
після чого робиться одна повторна спроба вибору.

**Стан пулу** (підсумок у відповіді `list_*` і `draw_*`):

| Стан         | Умова                                                             |
| ------------ | ----------------------------------------------------------------- |
| `ready`      | ефективний набір ≥ 1 і всі джерела `available`                    |
| `partial`    | набір ≥ 1, є джерела не `available`                               |
| `empty`      | набір = 0                                                         |
| `over_limit` | джерела дають > 500; прапорець поряд зі станом                    |
| `legacy`     | `source_mode='legacy'` і uuid[] непорожні → «потребує перевибору» |

Ефективна налаштованість простору = `operation='unstitch'` або хоч один
увімкнений слот у стані `ready`/`partial`.

## Вибір (`draw`)

Повертає `screens: [{ slot, materialId, checksum, name, mimeType, sizeBytes, driveVersion }]`
по одному на увімкнений слот (`order by random() limit 1` по унікальних
`checksum`) плюс `pool: { start: state, end: state }`. Порожній слот → без
запису в `screens`; якщо жоден увімкнений слот не дав картинки і
`operation <> 'unstitch'` → помилка `RESTITCH_POOL_EMPTY`.

## Кеш агента (локальна копія)

Тека `<ApplicationSupport>/TeamScreens/`. Файл `<materialId>-<md5>.<ext>`,
поряд `index.json` `{ entries: { "<materialId>-<md5>": { lastUsedAt, teamId, sizeBytes } } }`.
Запис: temp у тій самій теці + `rename`; верифікація `probeImage` (кодек ∈
png/mjpeg/webp, розмір ≤ 50 МБ) перед `rename`. Прибирання при старті агента й
після кожної доставки: записи, яких немає в останньому `screens`-наборі цього
простору **і** `lastUsedAt` старше 30 днів, або коли файлів у теці > 500 на
простір (LRU). Ніколи не чіпає `Images/`.

## Переходи стану налаштувань простору

```
legacy (uuid[] непорожні) ──save з пулами──▶ drive
legacy ──«перенести старі»──▶ drive (папка Soty/Re-stitch images/<slot> як джерело)
drive ──всі джерела недоступні──▶ drive/empty  (читання; без запису)
drive/empty ──джерело повернулось──▶ drive/ready (читання; без запису)
```

## Коди помилок (додаються в `team_contract_seed` і `apps/web/src/team/errors.ts`)

| Код                            | Де          | Сенс                                                                  |
| ------------------------------ | ----------- | --------------------------------------------------------------------- |
| `RESTITCH_POOL_EMPTY`          | draw, claim | жоден увімкнений слот не дав картинки                                 |
| `RESTITCH_SOURCE_FORBIDDEN`    | draw/grant  | немає права `download` на матеріали простору                          |
| `RESTITCH_SOURCES_INVALID`     | set         | не зображення/не папка, чужий простір, зайвий `kind`                  |
| `RESTITCH_SOURCES_TOO_MANY`    | set         | > 500 джерел у запиті                                                 |
| `RESTITCH_CLIENT_OUTDATED`     | claim       | вкладка без `restitchContractVersion ≥ 2` при `drive`-пулі            |
| `RESTITCH_SCREEN_UNAVAILABLE`  | агент       | у `screens` немає ні гранта, ні кешу                                  |
| `RESTITCH_SCREEN_FETCH_FAILED` | агент       | перенесення не вдалось і кешу немає (включно з браком місця на диску) |
| `RESTITCH_SCREEN_UNSUPPORTED`  | агент       | перенесене зображення анімоване або не проходить `probeImage`         |
