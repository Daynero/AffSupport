# Data Model: Опційна публікація відео каталогу в R2

Таблиці стану — `private.*`, RLS увімкнено, `revoke all` від `public, anon, authenticated, service_role`; доступ лише через `security definer` RPC зі `search_path=''`; одна публічна таблиця сигналів для Realtime (лише читання за `view`). Міграція адитивна, але торкається двох наявних речей: nullable `link_kind` у `private.catalog_publication_link_receipts` і заміна `public.service_record_catalog_publication_link` з default-параметром (див. «Квитанція публікації»). Оновлено після аналізу 2026-11-09 (ключ активної версії — відео-джерело, надгробки, cron, last-write-wins, підтвердження політики) і третього проходу 2026-11-10 (квитанція, сигнали, environment, Drive-ідентичності).

## catalog_video_r2_config (singleton)

| Поле                  | Тип         | Правила                                                                                                                                      |
| --------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`             | boolean     | глобальний вимикач; за замовчуванням `false`                                                                                                 |
| `policy_confirmed_at` | timestamptz | `null` → `availability` повертає `POLICY_PENDING`; ставиться явно власником після оновлення політики                                         |
| `part_bytes`          | integer     | 5 МіБ ≤ x ≤ 64 МіБ; за замовчуванням 16 МіБ                                                                                                  |
| `grace_interval`      | interval    | вікно перед видаленням копії без uses; 6 год                                                                                                 |
| `team_quota_bytes`    | bigint      | 5 ГБ (5 000 000 000 байт; рішення власника 2026-11-11, було 50 ГіБ)                                                                          |
| `max_object_bytes`    | bigint      | 2 ГіБ                                                                                                                                        |
| `public_origin`       | text        | HTTPS-домен публічного відео-bucket; БД будує з нього URL копій і звіряє квитанцію; edge відмовляє (`NOT_CONFIGURED`), якщо env-origin інший |
| `max_claim_attempts`  | integer     | 24; після стількох claim копія `failed` з `VIDEO_R2_INTERRUPTED` і надгробком                                                                |

Секрет воркера — чинні vault-записи `wishly_catalog_sync_url` / `wishly_catalog_sync_secret`, ті самі, що читає `private.invoke_catalog_images_worker()` (045); нових секретів не створюється; у таблиці чи журнал секрет не потрапляє.

Environment edge-функцій (не в БД): `CATALOG_VIDEOS_ENABLED`, `R2_CATALOG_VIDEO_STAGING_BUCKET`, `R2_CATALOG_VIDEO_PUBLIC_BUCKET`, `R2_CATALOG_VIDEO_PUBLIC_ORIGIN`, `R2_CATALOG_VIDEO_TARGET_CONFIRMATION`, `R2_CATALOG_VIDEO_ACCESS_KEY_ID`, `R2_CATALOG_VIDEO_SECRET_ACCESS_KEY`; спільні з 045 — `CATALOG_IMAGES_ENVIRONMENT`, `R2_CATALOG_ACCOUNT_ID`, `R2_CATALOG_ZONE_ID`, `R2_CATALOG_PURGE_TOKEN` (R18).

## catalog_video_r2_preferences

Опція каталогу. Ключ: `catalog_material_id`. Булева, last-write-wins.

| Поле                  | Тип         | Правила                                                                             |
| --------------------- | ----------- | ----------------------------------------------------------------------------------- |
| `team_id`             | uuid        | FK `teams`, cascade                                                                 |
| `catalog_material_id` | uuid PK     | матеріал каталогу                                                                   |
| `enabled`             | boolean     | відсутній запис = `false`                                                           |
| `revision`            | bigint      | монотонно зростає при кожному записі; лише для атрибуції/журналу, не для конфліктів |
| `configured_by`       | uuid        | `auth.users`, `set null`                                                            |
| `updated_at`          | timestamptz |                                                                                     |

## catalog_video_r2_copies

Одна R2-копія однієї версії джерела.

| Поле                                     | Тип         | Правила                                                                                             |
| ---------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| `id`                                     | uuid PK     |                                                                                                     |
| `team_id`                                | uuid        | FK `teams`, cascade (надгробок записується тригером до видалення)                                   |
| `source_material_id`                     | uuid        | матеріал-джерело (Drive); для каталогу з варіантами — `output_material_id` варіанта                 |
| `requested_by_catalog`                   | uuid        | який каталог запланував копію (для сигналу/стану до першого use); `set null` при видаленні каталогу |
| `source_version`                         | text        | `strict-v1:…`, ідентичність версії з `catalogPublicationSourceIdentity`                             |
| `object_key`                             | text unique | випадковий непрозорий `v/<hex32>.mp4`, видається один раз                                           |
| `state`                                  | text        | `planned`, `uploading`, `verifying`, `ready`, `retiring`, `deleted`, `failed`                       |
| `size_bytes`                             | bigint      | з Drive; `> 0`, `≤ max_object_bytes`                                                                |
| `source_md5`                             | text        | Drive `md5Checksum` на момент планування, для повної звірки, коли вона можлива                      |
| `full_hash_verified`                     | boolean     | `true`, якщо повний MD5 звірено; інакше межа доказу явна в діагностиці                              |
| `part_bytes`                             | integer     | зафіксований при створенні                                                                          |
| `upload_id`                              | text        | multipart, зберігається до завершення/abort                                                         |
| `lease_token`, `lease_until`, `attempts` |             | fence/renew як у 045                                                                                |
| `last_error`                             | text        | закритий набір кодів (див. контракт)                                                                |
| `ready_at`, `retire_after`, `deleted_at` | timestamptz |                                                                                                     |

Унікальність: `unique (team_id, source_version) where state not in ('deleted','failed')` — ідемпотентність (FR-007). Індекси: `(state, retire_after)`, `(lease_until) where state in ('uploading','verifying')`, `(team_id, state)` для квоти.

**Переходи**: `planned → uploading → verifying → ready → retiring → deleted`; `uploading|verifying → failed` (повтор створює нову спробу тієї ж копії або нову копію після `failed`); `ready → retiring` лише коли немає uses і незавершеної публікації; `retiring → ready`, якщо з'явився новий use до видалення.

**Тригер** `before delete`: якщо `state <> 'deleted'` і є `object_key` — вставити рядок у `catalog_video_r2_purges` (надгробок). Так каскад від `teams`/матеріалів ніколи не лишає об'єкта без запису.

## catalog_video_r2_parts

| Поле          | Тип     | Правила                                                                                                             |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `copy_id`     | uuid    | FK cascade                                                                                                          |
| `part_number` | integer | `1..10000`                                                                                                          |
| `size_bytes`  | integer |                                                                                                                     |
| `sha256`      | text    | hex64                                                                                                               |
| `etag`        | text    |                                                                                                                     |
| `verified_by` | text    | `provider_checksum` (R2 підтвердив `x-amz-checksum-sha256`) або `readback` (Range-readback частини й власна звірка) |

PK `(copy_id, part_number)`. Копія переходить у `verifying` лише коли набір частин суцільний і сума розмірів = `size_bytes`.

## catalog_video_r2_uses

На яку копію каталог підтверджено для кожного відео-джерела (активна версія, FR-009).

| Поле                  | Тип         | Правила                                                       |
| --------------------- | ----------- | ------------------------------------------------------------- |
| `catalog_material_id` | uuid        | матеріал каталогу                                             |
| `source_material_id`  | uuid        | відео-джерело (для варіантів — `output_material_id` варіанта) |
| `copy_id`             | uuid        | FK `copies`                                                   |
| `confirmed_at`        | timestamptz | після запису каталогу й підтвердження доступності             |

PK `(catalog_material_id, source_material_id)`. `confirm_use(p_catalog, p_link_kind, p_uses[])` **замінює весь набір** uses каталогу в одній транзакції: рядки для джерел, яких немає в підтвердженому наборі, видаляються; підтвердження з `link_kind='drive'` (після вимкнення опції) видаляє всі uses каталогу. Копії, що лишились без uses, ставляться на `retiring` тут же. Остаточне видалення матеріалу каталогу каскадно прибирає uses → відповідні копії підхоплює `retire_orphans` у sweep. Кошик (`trashed_at`), зняття з автооновлення і паузи uses не чіпають.

## team_catalog_video_r2_signals (public, Realtime)

Одна на каталог; дзеркало стану для UI, бо Realtime не бачить `private.*` (R17). RLS: `select` за `private.can(team_id,'view',auth.uid())`; `insert/update/delete` — лише з security-definer RPC.

| Поле                        | Тип         | Правила                                                                        |
| --------------------------- | ----------- | ------------------------------------------------------------------------------ |
| `team_id`                   | uuid        | FK `teams`, cascade                                                            |
| `catalog_material_id`       | uuid PK     | матеріал каталогу                                                              |
| `enabled`                   | boolean     | дзеркало `preferences`                                                         |
| `link_kind`                 | text        | `drive` \| `r2` — на яке посилання каталог підтверджено останнім `confirm_use` |
| `copy_state`                | text        | стан активної/найновішої копії або `null`                                      |
| `reason`                    | text        | закритий код причини fallback або `null`                                       |
| `last_successful_update_at` | timestamptz |                                                                                |
| `updated_at`                | timestamptz |                                                                                |

Оновлюють: `set_preference`, `reserve_copy`, `mark_ready`, невдачі копії, `confirm_use`, `begin_retire`. `GET /catalogs/:id/state` читає її ж; `useTeamRealtime.ts` підписується з фільтром `team_id`.

## Квитанція публікації (наявна, змінюється)

`private.catalog_publication_link_receipts` (`20261207176000`) отримує nullable `link_kind text check (link_kind in ('drive','r2'))`; `null` читається як `drive`. `public.service_record_catalog_publication_link(p_job,p_worker,p_material,p_source_version,p_url,p_link_kind text default 'drive')` **замінює** чинну функцію: для `drive` — правило форми URL і звірка з `fileId` джерела дослівно як сьогодні; для `r2` — `p_url` має дорівнювати `https://<videoOrigin>/v/<object_key>` копії зі `state='ready'`, `source_material_id=p_material`, `source_version=p_source_version`, `team_id` job, при `preferences.enabled=true` для каталогу job; інакше `SOURCE_CHANGED`. Перевірка `previous.url<>p_url → SOURCE_CHANGED` у межах job лишається. Старі виклики з п'ятьма аргументами працюють без змін (сумісність для плану релізу).

## catalog_video_r2_purges (надгробки)

Без FK на `teams` чи `copies` — переживає будь-який каскад.

| Поле         | Тип         | Правила                                                                                      |
| ------------ | ----------- | -------------------------------------------------------------------------------------------- |
| `id`         | uuid PK     |                                                                                              |
| `team_ref`   | uuid        | копія `team_id`, не FK                                                                       |
| `copy_ref`   | uuid        | копія `copies.id`, не FK                                                                     |
| `object_key` | text        | що видаляти                                                                                  |
| `reason`     | text        | `replaced`, `disabled`, `source_removed`, `catalog_deleted`, `team_deleted`, `failed_upload` |
| `attempts`   | integer     |                                                                                              |
| `purged_at`  | timestamptz | `null` поки об'єкт і CDN не очищено                                                          |
| `last_error` | text        | закритий набір                                                                               |

Індекс `(purged_at) where purged_at is null`. Sweep обробляє обмежену кількість за виклик, повторює при невідомому результаті; успіх = об'єкт відсутній (404 на HEAD) і purge прийнято.

## Квота (похідне)

`sum(size_bytes)` по `copies` у станах `uploading|verifying|ready|retiring` на `team_id`. Перевірка квоти і резервування — атомарно при створенні копії (`reserve_copy`).

## catalog_video_r2_journal

Стабільний журнал для 031: `seq`, `team_id`, `copy_id`, `attempt_id`, `intent_id`, `catalog_material_id`, `actor_id` (лише для стадії `configured` — хто змінив опцію; це ID, не вміст), `stage`, `code`, `link_kind`, `part_verification` (`provider_checksum`/`readback`), `size_bucket`, `duration_bucket`, `full_hash_verified`, `occurred_at`. Без байтів, імен, шляхів, URL, секретів. Історія змін опції відновлюється з журналу, `preferences` тримає лише останній стан.

## Фоновий запуск

`private.invoke_catalog_video_r2_worker(p_route text)`: читає `vault.decrypted_secrets` `wishly_catalog_sync_url` і `wishly_catalog_sync_secret`, endpoint = `regexp_replace(url, '/catalog-sync/?$', '/catalog-video-r2/worker')`, перевіряє форму endpoint і довжину секрета (≥32), шле `net.http_post` із заголовком `x-catalog-sync-secret` і тілом `{"route": p_route}`; повертає `null`, якщо немає роботи (як 045). `cron.schedule('soty-catalog-video-r2-claim','30 seconds',…)` і `cron.schedule('soty-catalog-video-r2-sweep','*/5 * * * *',…)`. Той самий механізм і ті самі секрети, що в 045 — нічого провізіонити не треба.

## Зв'язки з наявним

- `source_material_id` / `catalog_material_id` → `team_materials`; варіанти → `private.catalog_video_variants.output_material_id`.
- Опція для каталогу Launch — поле `copyVideoToR2` у `LaunchCatalogConfig` (`settings_snapshot` у `public.team_launch_revision_catalogs`); при створенні каталогу запуском воно переноситься в `preferences`.
- Резолвер читає: `preferences` (enabled?), `copies` (ready для `source_version`?), інакше Drive.
- Квитанція посилання публікації (`service_record_catalog_publication_link`) отримує `link_kind` (`drive` | `r2`) у ключі ідентичності — через заміну RPC і nullable-колонку (розділ «Квитанція публікації»).
- Drive-ідентичності ре-стітчу (`team_product_catalogs.current_video_link`/`video_link`, `team_catalog_restitch_copies.shared_link`, `sourceLink` контексту job) R2-URL не отримують ніколи (R20); R2-URL живе лише у квитанції з `link_kind='r2'`, у клітинці каталогу і в `uses`.
- Стани каталогу для FR-012: остаточне видалення матеріалу → каскад uses → `retire_orphans`; кошик (`team_materials.trashed_at`), зняття з автооновлення (видалення рядка `team_catalog_updater_items`), паузи (`paused_by_tariff_at`, stop hold) — без дій, копії зберігаються.
- Право ввімкнення: `private.can(p_team, 'manage_metadata', auth.uid())` — як у `public.set_team_product_catalog_settings`.
