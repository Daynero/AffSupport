# Модель даних 057 (редакція 2026-11-27)

Лише дизайн. Усі зміни адитивні: нові таблиці й колонки, `DROP NOT NULL` там, де сказано
(дозволено `scripts/check-migrations-additive.mjs`). Байти — `bigint`, у JSON — десятковий
рядок. Мітки часу міграцій призначаються під час імплементації — після найбільшої на цільовій
гілці (на `beta` зараз `20261224390000`). На беті вже лежать чужі версії з незлитих гілок,
тому перед вибором треба перевірити `supabase_migrations.schema_migrations`.

Рішення, з яких випливає модель, — [research.md](research.md) R1–R12.

**Огорожа прибирання.** Таблиця потрапляє в інвентар `private.task_cleanup_reference_tables()`
(`supabase/migrations/20261206139980_recovery_retirement_receipts.sql:30`), якщо виконується
будь-яка з умов:

- ім'я починається з `team_`, `launch_` чи `catalog_`;
- є FK на `team_materials`;
- є колонка json або jsonb.

Така таблиця мусить отримати тригер `task_cleanup_reference_fence` → `private.guard_task_cleanup_reference()`
у тій самій міграції (зразок: `supabase/migrations/20261223100000_ai_credits.sql:82`). Інакше
прибирання вкладень вимикається для всієї бази. Колонка «Огорожа» нижче каже, чи потрібен тригер.

## M1 — пілот

### Зміни наявних таблиць

| Таблиця                 | Зміна                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `teams`                 | `storage_backend text not null default 'drive'` (`drive`/`r2`), `storage_pilot boolean not null default false`, `content_revision bigint not null default 0`, `access_epoch bigint not null default 0`, `storage_root_material_id uuid` (корінь R2-простору). Backend після створення не змінюється (тригер).                                         |
| `team_materials`        | `DROP NOT NULL` на `connection_id`, `drive_file_id`. Нові `space_object_id uuid` (FK `space_objects`) і `material_revision bigint not null default 0`. `CHECK`: Drive-рядок має `connection_id` і `drive_file_id`; R2-рядок — папка, або має `space_object_id`, або є стрічкою каталогу. Для R2 `parent_folder_id` = uuid батьківської папки текстом. |
| `team_product_catalogs` | `feed_id text unique` (128 біт, base32), `feed_revision bigint`, `feed_written_at timestamptz`. Для R2-каталогу `sheet_url` = публічна адреса стрічки (https, тож наявна перевірка проходить), Google Sheet не створюється.                                                                                                                           |

Інваріанти:

- У R2-простору немає рядка `team_drive_connections`. Через це `catalog-sync` його не бере.
- Дерево без циклів. Батько належить тому самому простору й теж R2.
- Перейменування й перенос — лише рядок у БД. Байти й адреси не змінюються.
- `material_revision` зростає з кожною зміною. Мутація з чужою ревізією отримує `REVISION_CONFLICT` (FR-040).
- `content_revision` простору зростає з кожною фіксацією, видаленням і готовністю похідної (кеш, R8).
- `access_epoch` зростає з кожним видаленням учасника, зміною ролі чи відкликанням (R4).

### Нові таблиці

| Таблиця                         | Поля й обмеження                                                                                                                                                                                                                                                                                                                                                  | Стани                                                                                           | Огорожа       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------- |
| `storage_r2_pilots`             | `user_id` pk → auth.users, `max_space_bytes bigint not null`, `added_by`, `added_at`, `removed_at`. RLS увімкнено, гранти відкликано, як у `release_testers`                                                                                                                                                                                                      | активний / знятий (знятий не видаляє простори)                                                  | ні            |
| `space_objects`                 | `id`, `team_id`, `content_id text` (SHA-256 від версії, розміру частини, довжини й ETag (MD5) частин від R2, R3), `sha256 text` (повний хеш від клієнта, довідково), `byte_size`, `content_type`, `r2_key`, медіафакти (`duration_ms`, `width`, `height`; `codec`, `fps` — після агента), `created_at`. Унікальність (`team_id`, `content_id`) серед непрочищених | `committed` → `purge_pending` → `purged` (фіксація доведена ETag частин від R2 і `Content-MD5`) | ні            |
| `space_object_refs`             | pk (`object_id`, `owner_kind`, `owner_id`), `team_id`, `category`, `counted boolean`. `owner_kind`: `material`, `task_attachment`, `process_output`, `derivative`                                                                                                                                                                                                 | рядок є — посилання живе                                                                        | ні            |
| `space_storage_usage`           | pk (`team_id`, `category`), `bytes`, `objects`, `shared_bytes`, `revision`. Категорії: `materials`, `catalogs`, `process`, `attachments`, `versions`, `trash`                                                                                                                                                                                                     | лише інкременти з тригерів                                                                      | ні            |
| `space_storage_reservations`    | `id`, `team_id`, `operation_id` unique, `bytes`, `purpose` (`upload`, `process_output`, `catalog_generation`), `expires_at`, `created_by`                                                                                                                                                                                                                         | `reserved` → `committed` / `released`; `uncertain` до звірки                                    | ні            |
| `space_uploads`                 | `id`, `team_id`, `reservation_id`, `declared_content_id`, `declared_bytes`, заявлені похідні — рядки `space_upload_derivatives`, `name`, `content_type`, `parent_material_id` (FK `team_materials`), `r2_upload_id`, `staging_key`, `ingress` (`explorer`, `agent_output`, `inbox`, `mobile`, `share_target`), `actor_id`, `idempotency_key` unique               | `open` → `completing` → `committed`; `aborted`, `expired`, `rejected`                           | так (FK)      |
| `space_upload_derivatives`      | pk (`upload_id`, `variant`), `content_type`, `bytes`, `width`, `height`, `staging_key`                                                                                                                                                                                                                                                                            | `declared` → `accepted` / `rejected`                                                            | ні            |
| `space_derivative_jobs`         | pk (`object_id`, `recipe_version`), `team_id`, `reason` (`browser_unsupported`, `missing_media_facts`, `client_skipped`), `claimed_by_device`, `lease_until`, `attempts`, `error_code`. Лише добір агентом: те, що зробив клієнт під час завантаження, сюди не потрапляє                                                                                          | `pending_agent` → `claimed` → `ready` / `unsupported` / `failed` (обмежені повтори)             | ні            |
| `space_object_purges`           | `object_id` pk, `team_id`, `r2_key`, `due_at`, `reason` (`trash_expired`, `trash_emptied`, `catalog_deleted`, `space_deleted`, `orphan`), `attempts`                                                                                                                                                                                                              | `due` → `deleted` / `failed`                                                                    | ні            |
| `space_storage_reconciliations` | `id`, `team_id` (null — весь bucket), `started_at`, `finished_at`, `listed`, `ledger`, `orphans_found`, `orphans_deleted`, `missing`                                                                                                                                                                                                                              | `running` → `done` / `failed`                                                                   | ні            |
| `team_space_storage_signals`    | `id`, `team_id`, `kind` (`content`, `usage`, `derivative`), `folder_id`, `revision`, `created_at`. У публікації `supabase_realtime`, RLS як у `team_catalog_video_r2_signals`                                                                                                                                                                                     | лише вставка, прибирання старших за добу                                                        | так (`team_`) |
| `private.space_storage_journal` | `operation_id`, `attempt`, `stage`, `outcome`, `code`, `bytes`, `team_id`, `ingress`, `client` (web/agent і версія), `occurred_at`. Без імен, шляхів і ключів                                                                                                                                                                                                     | лише вставка, 90 діб                                                                            | ні            |

**Ідентичність вмісту** (R3, редакція 2026-11-28). R2 не перевіряє `x-amz-checksum-sha256`
на `UploadPart` (501 у кваліфікації 050), тому `content_id` стоїть на ETag частин — MD5, який
R2 рахує з отриманих байтів. Сервер перераховує `content_id` з ETag від `ListParts`, а не від
клієнта. Дедуплікація лише в межах одного простору: унікальність (`team_id`, `content_id`).
Залишковий ризик — колізія MD5 з вибраним префіксом від учасника, що вже має право
завантаження в тому самому просторі; межа та сама, що у F25.

### Облік пам'яті

- **Що рахується** (FR-047): кожен об'єкт рахується раз на простір. Категорію визначає перше
  посилання за пріоритетом: `materials` > `catalogs` > `process` > `attachments` > `versions`
  > `trash`. Якщо посилань кілька, байти потрапляють і в `shared_bytes`.
- **Що не рахується:** посилання `derivative` (`counted=false`) — мініатюри, постери й прев'ю
  провідника, які Soty відтворить сама — і незафіксовані завантаження. Опубліковані медіа
  каталогу (варіації, постери й картинки в стрічці) — це не похідні провідника, вони
  рахуються в `catalogs` (US9.1, FR-047).
  Останні показує сегмент «Резервується» — це сума `space_storage_reservations` у стані
  `reserved`.
- **Каталоги 050/045** (FR-050). Тригери на `private.catalog_video_r2_copies` (стани
  `planned`…`retiring`, ті самі, що в `private.catalog_video_r2_team_used_bytes`) і на
  `private.catalog_image_storage` додають і віднімають байти в категорії `catalogs` для
  R2-простору.
  - Картинки пулу (`private.catalog_global_images`) рахуються в кожному просторі, що їх
    використовує, раз і з позначкою «спільне».
  - Мініатюри Drive (`team-thumbnail-cache`, «Soty Cache») до R2-простору не належать: там
    мініатюри — це похідні з `space_objects`.
- **Місткість.** `private.space_capacity_bytes(team)`: у пілоті — `max_space_bytes` власника
  з `storage_r2_pilots`; у M3 — `space_tariffs.storage_bytes + extra_storage_bytes`.
- **Резервування** (FR-017). `admit-upload` бере блокування простору в порядку team → material.
  Перевірка: `used + reserved + declared ≤ capacity`, інакше `STORAGE_QUOTA_EXCEEDED`.
  Протерміноване резервування з відкритим multipart звільняється лише після звірки (`uncertain`).
- **Видалення** (FR-048). Коли зникає останнє посилання, об'єкт іде в `space_object_purges`.
  - Через 30 днів — для матеріалу в кошику.
  - Одразу — для очищеного кошика, каталогу й простору.
  - `space-storage-sweeper` видаляє об'єкт з R2 і ставить `purged`. Повтор безпечний.

### Похідні від клієнта (research.md R5)

- **Хто робить.** Похідні оголошуються в `admit-upload` і вантажаться частинами того самого
  коміту. Робить їх браузер з локального файлу або агент для своїх файлів.
- **Перевірка при `complete-upload`.** Сервер перевіряє кожну похідну:
  - тип за першими байтами (WebP або JPEG);
  - байти в межах ліміту варіанта з `packages/shared/src/team/space-storage.ts`;
  - розміри із заголовка зображення збігаються із заявленими.

  Невалідна похідна відкидається, а оригінал фіксується. Тоді матеріал отримує
  `thumbnail_state='pending'` і рядок у `space_derivative_jobs`.

- **Повтор.** Якщо для `content_id` похідні вже є, клієнт їх не робить, а сервер нічого не
  чекає (FR-038).
- **Добір агентом.** Агент будь-якого учасника з доступом, коли онлайн, бере `pending_agent`
  через `service_claim_space_derivative_jobs` і пише похідні з контрольними сумами.
- **Чого не буде.** Серверного рендерингу немає, тож немає й черги, що чекає сервер.

### Ключі R2 (bucket `soty-spaces-{env}`)

`soty-spaces-beta`: стандартна юрисдикція, підказка EEUR (T001, 2026-11-28). Юрисдикцію для
проду треба вирішити до T062: план хоче EU.

| Ключ                                         | Що                                                           | Життя                                                          |
| -------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| `t/{team}/u/{upload_id}`                     | staging (зарезервовано; оригінали вантажаться одразу в `o/`) | незавершений multipart скасовується через 1 добу (весь bucket) |
| `t/{team}/o/{content_id}`                    | оригінал, результат обробки, вкладення                       | доки є посилання                                               |
| `t/{team}/d/{content_id}/{recipe}/{variant}` | мініатюри, постер, прев'ю                                    | разом з оригіналом                                             |

Стрічки каталогів лежать окремо, у публічному `soty-catalog-videos-{env}-public` під ключем
`feeds/{feed_id}.csv`.

## M2 — входи й паритет

| Таблиця             | Поля                                                                                                                                                                                 | Стани                            | Огорожа  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | -------- |
| `space_share_links` | `id`, `team_id`, `material_id` (FK `team_materials`), `token_hash`, `mode` (`view`, `download`), `expires_at`, `revoked_at`, `created_by`, `requests`, `bytes_served`, `bytes_limit` | `active` → `expired` / `revoked` | так (FK) |

«Вхідні» не мають серверної таблиці. Цільова папка й журнал файлів живуть в агенті. Кожен
файл іде через `space_uploads` з `ingress='inbox'` і `idempotency_key` = `content_id` + шлях відносно
папки. Тому повтор після сну чи обриву не дає дубля (SC-015).

## M3 — загальний запуск

| Таблиця / зміна           | Поля                                                                                                                        | Огорожа |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------- |
| `storage_launch_policy`   | singleton: `t0_at`, `archive_at` (= T0 + 60×24 год), `activated_by`, `activated_at`. Продовження лише вперед, з аудитом     | ні      |
| `storage_launch_events`   | аудит активації й продовжень: хто, коли, стара й нова дата, причина                                                         | ні      |
| `storage_archive_notices` | (`team_id`, `user_id`, `offset_days` ∈ 30/14/7/1/0), `sent_at`, `result` — за зразком `space_tariff_notices`                | ні      |
| `space_tariffs`           | + `storage_bytes bigint not null default 15000000000`, `extra_storage_bytes bigint not null default 0` (кратно 10^10)       | —       |
| `space_object_replicas`   | `object_id`, `provider` (`b2`), `version_id`, `verified_at`, `lock_until`, стан `queued` → `copying` → `verified`; `failed` | ні      |
| `space_restore_points`    | за [contracts/recovery.md](contracts/recovery.md)                                                                           | ні      |

Правило архіву: `private.space_is_archived(team)` = `storage_backend='drive'` і
`now() ≥ storage_launch_policy.archive_at`. Його викликає `private.can` для записувальних
можливостей. Читання, пошук, прев'ю, скачування й експорт фінансів не зачеплені. Вихід,
прибирання учасника й відкликання доступу дозволені ([contracts/legacy-policy.md](contracts/legacy-policy.md)).

## Чого в моделі більше немає

Відкладено разом із тарифною моделлю ([pricing.md](pricing.md), FR-015/018/019/022):
`billing_organizations`, `organization_plan_versions`, `organization_grants`, `organization_seats`.

Знято рішенням про відмову від переносу (FR-055): `workspace_migrations`,
`migration_manifest_entries`, `legacy_cutoff_inventory`, `workspace_storage_bindings`
з епохами авторитету, таблиці-двійники `workspace_materials` та `workspace_object_versions`.
