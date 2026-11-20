# Contract: SQL RPC і edge-кроки

Усі функції — `security definer`, `set search_path = ''`, повністю кваліфіковані імена, доступ `service_role` (edge) або перевірка членства (клієнтські).

## Змінені

| RPC | Зміна |
|---|---|
| `save_launch_draft` | перевіряє `creatives` (UUID, ≤10, унікальні, `creativeKind`), дзеркало першого |
| `service_launch_sources` / `get_launch_sources` | + `materials[]` у порядку креативів, кожен з `type/version/checksum/driveFileId`; відмова, якщо категорія ≠ `creativeKind` |
| `service_accept_launch_catalog_video_generation` | приймає `plan.segments`; для кожного відео-сегмента з перезашивкою — `service_accept_catalog_video_set`; вставляє `launch_catalog_video_segments`; reuse готового набору лише при k=1 |
| `service_accept_catalog_video_set` | пошук за `(intent, source)`; джерело має бути серед сегментів інтенту |
| `service_wait_launch_catalog_video` | готовність = усі набори сегментів; повертає `failedOrdinal` |
| `service_initial_catalog_video_outputs` | без змін; edge викликає по разу на сегмент |
| реєстрація цілі публікації (`169000:571-577`) | k>1 або image → ціль `creatives` + сегменти |
| заміна відео, перевірка посилань, `randomLinkVariation`, `refreshImages`, `grow` (+ `restitch` для зображень) | ціль `creatives` → `MULTI_CREATIVE_UNSUPPORTED` |
| гілка update `catalog_video_sets` | `unique(update_attempt_id, source_material_id)`; джерело — відео-сегмент цілі (R28) |
| лінія публікації (`service_catalog_publication_cells_context`, задачі) | сегменти цілі `creatives`: Z для відео, H для зображень (R26) |
| `service_complete_catalog_update` | snapshot від edge уже містить ключі креативів (R20) |
| ланцюжок `get_launch` (`get_launch_before_started_at`, тіло з `20261207177000`) (прогрес) | агрегат прогресу по наборах (сума готових варіацій / сума запитаних) |
| `list_launches_pre_assignment` | + `creativeCount`, `creativeKind`; `videoGeneration` — агрегат |
| `pendingCatalogName` / резерв назви | `<stem першого>+N_v<n>_catalog` |
| `credit_launch_rank`, `backfill_creative_ranks`, `absorb_launch_catalog` | кредит кожному креативу (R13) |
| `catalog_nonvideo_update_context` | рядки й сегменти цілі `creatives` (без росту) |
| `prepareCatalogClaims` (edge) / claim RPC | для `_catalogCreativeKind='image'` — без `refresh_images` |

## Нові

```sql
retry_launch_catalog_video_segment(p_generation uuid, p_ordinal int) returns jsonb
  -- перевідкриває лише невдалий набір сегмента; перевірка членства/прав як у retry_launch_restitch

service_reserve_launch_creative_image(p_team uuid, p_material uuid, p_version text, p_checksum text, p_attempt uuid)
  returns jsonb  -- {state:'ready', id, url} | {state:'reserved', id, objectKey}
service_commit_launch_creative_image(p_id uuid, p_attempt uuid, p_url text, p_mime text, p_size int) returns jsonb
service_fail_launch_creative_image(p_id uuid, p_attempt uuid, p_code text) returns void
service_confirm_launch_creative_image_uses(p_catalog uuid, p_images uuid[]) returns void
service_sweep_launch_creative_images(p_limit int) returns setof (id uuid, object_key text)
service_mark_launch_creative_image_purged(p_id uuid) returns void
```

## Edge-крок `creativeImages` (`catalog-durable.ts`)

Чекпойнт `creativeImage_<ordinal>` = `{id, url}`. Повтор після втрати відповіді читає чекпойнт; резервація ідемпотентна за `(team, material, version, checksum)`. Ключ — `c1/<uuid>`. Помилки: `CREATIVE_IMAGE_FORMAT` (не JPEG/PNG/WebP, < 500 px), `CREATIVE_IMAGE_TOO_LARGE`, `SOURCE_CHANGED`, `PUBLIC_READ_UNVERIFIED` (повторюваний).
