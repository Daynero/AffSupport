# Data Model: 062

## Shared-типи (`packages/shared/src/team/launches.ts`)

```ts
// межа товарів — наявна CATALOG_PRODUCT_COUNT_MAX = 400 (packages/shared/src/team/catalog-video-set.ts)
export const CATALOG_ID_PREFIX_MAX = 40;

export type LaunchCreativeKind = 'video' | 'image';

export interface LaunchCreative {
  materialId: string;      // UUID team_materials
  alias: string;           // ^[A-Za-z0-9_-]{1,160}$ — префікс ID (обрізаний до 40) і назви
  copies: number;          // ≥1; сума = catalog.productCount
  pinned: number | null;   // null = автоматичний; число = порядок ручного редагування (більше = новіше)
}

export interface LaunchConfig {
  // ...наявні поля
  materialId: string;      // = creatives[0].materialId (дзеркало)
  creativeAlias: string;   // = creatives[0].alias (дзеркало)
  creativeKind?: LaunchCreativeKind;   // відсутнє у старих → з sources.materialType
  creatives?: LaunchCreative[];        // відсутнє у старих → [перший] з copies = productCount
}

export interface LaunchCatalogConfig {
  // ...наявні поля
  videoVariationCount?: number; // загальна кількість; k ≤ V ≤ N з перезашивкою
}
```

**Правила валідації** (`validation.ts`, `parseLaunchConfig`, одна типізована причина):

| Правило | Код |
|---|---|
| 1 ≤ k ≤ 400 (межа товарів) | `CREATIVES_LIMIT` |
| усі креативи одного `creativeKind`, категорія матеріалу відповідає | `CREATIVES_MIXED` |
| `materialId` унікальні | `CREATIVE_DUPLICATE` |
| `sum(copies) = productCount`, `copies ≥ 1`, `productCount ≥ k` | `DISTRIBUTION_INVALID` |
| з перезашивкою `k ≤ V ≤ N`; без — `V = 1` | `VARIATIONS_RANGE` |
| `creativeKind='image'` ⇒ `restitchEnabled=false` (`copyVideoToR2` = R2 посилань зображень, розклад дозволено) | `INVALID_INPUT` |
| сховані дії менеджера (research R27) над k>1 відео або image | `MULTI_CREATIVE_UNSUPPORTED` |
| `method='other'` ⇒ k = 1 | `CREATIVES_LIMIT` |
| `materialId === creatives[0].materialId`, `creativeAlias === creatives[0].alias` | `INVALID_INPUT` |

**`LaunchSources`**: + `materials: Array<{materialId, type, version, checksum, driveFileId}>` у порядку креативів; поля першого (`materialType`, `materialVersion`…) лишаються.

**`LaunchSummary`**: + `creativeCount: number`, `creativeKind`.

## План каталогу (edge, JSON у чекпойнтах)

```ts
interface CatalogCreativeSegment {
  ordinal: number;            // 0..k-1
  materialId: string;
  alias: string;
  kind: LaunchCreativeKind;
  rowStart: number;
  rowCount: number;           // = copies
  variantCount: number;       // відео: з distributeVariations; image: 0
  setId: string | null;       // відео з перезашивкою
  childRequestIds: string[];  // довжина = variantCount при перезашивці
}
interface CatalogInitialVideoPlanV2 extends CatalogInitialVideoPlan {
  segments: CatalogCreativeSegment[]; // setId (старе поле) = segments[0].setId
}
```

Інваріанти: сегменти суцільні й упорядковані; `Σ rowCount = recipeRowIds.length = productCount`.

## Snapshot каталогу (`team_product_catalogs.settings_snapshot`)

- `_catalogCreativeKind: 'video' | 'image'`
- `_catalogCreatives: Array<{ordinal, materialId, alias, kind, imageId?: string, link?: string, linkKind?: 'r2' | 'drive', linkRevision?: number}>` — `link` (поточне посилання креативу для H/Z) оновлює лише лінія публікації при підтвердженому записі; зміна R2-перемикача збільшує `linkRevision`
- `_catalogRowCreatives: number[]` — ordinal креативу для кожного рядка в порядку рядків.

Відсутність ключів = старий каталог: без префікса ID, поведінка без змін.

## SQL — нові таблиці

### `private.launch_catalog_video_segments`

| Колонка | Тип | Обмеження |
|---|---|---|
| generation_id | uuid | FK `team_launch_generations`, частина PK |
| ordinal | int | 0..399, частина PK |
| team_id | uuid | not null |
| material_id | uuid | FK `team_materials` |
| kind | text | `video`/`image` |
| row_start | int | ≥ 0 |
| row_count | int | 1..400 |
| variant_count | int | 0..400 |
| video_set_id | uuid null | FK `catalog_video_sets`, unique коли not null |
| assignment_seed | text | `^[a-f0-9]{64}$` = hex(sha256(plan seed ‖ ':' ‖ ordinal)) |

RLS увімкнено, `revoke all`; доступ лише через `security definer` RPC. Імутабельний після вставки (тригер як у `launch_catalog_video_contexts`). Тригер `task_cleanup_reference_fence`.

### `private.launch_creative_images`

| Колонка | Тип | Обмеження |
|---|---|---|
| id | uuid PK | |
| team_id | uuid | not null |
| material_id | uuid | FK `team_materials` |
| source_version | text | Drive version |
| source_checksum | text | Drive md5 |
| object_key | text | `^c1/[0-9a-f-]{36}$`, unique (форма як `v1/`/`g1/`) |
| mime | text | `image/jpeg`/`image/png` |
| size_bytes | int | ≤ 8 MiB |
| state | text | `reserved → ready → retiring → purged`; `failed` |
| url | text null | https, без query; not null коли `ready` |
| attempt_id | uuid | ідентичність спроби для аналітики |
| retire_after | timestamptz null | |
| unique | | `(team_id, material_id, source_version, source_checksum)` де state in (`reserved`,`ready`,`retiring`) |

### `private.launch_creative_image_uses`

`(image_id, catalog_material_id)` PK; FK на обидва. Порожньо → `retire_after = now + 6 h`. Тригер `task_cleanup_reference_fence` на обох таблицях.

## SQL — змінені обмеження

| Об'єкт | Було | Стає |
|---|---|---|
| `catalog_video_sets` | `unique(catalog_intent_id)` | `unique(catalog_intent_id, source_material_id)` |
| `catalog_video_recipe_references` | `unique(catalog_intent_id)` | `unique(catalog_intent_id, video_set_id)` |
| `team_creative_launch_events` | `unique(team_id, source_kind, source_id)` | `unique(team_id, source_kind, source_id, material_id)` |
| `team_product_catalogs.video_link` | `not null`, `^https://` | nullable; not null, якщо `_catalogCreativeKind ≠ 'image'` |
| `catalog_publication_targets.kind` | `source`, `video_set` | + `creatives` (з `catalog_publication_target_segments`) |

### `private.catalog_publication_target_segments`

`(target_id, ordinal)` PK; `kind` (`video`/`image`), `source_material_id`, `video_set_id` null, `image_id` null (FK `launch_creative_images`), `row_start`, `row_count`. RLS, `revoke all`, fence-тригер. Лише для цілі `kind='creatives'`.

## Переходи стану

- Сегмент відео з перезашивкою: стан = стан його набору (`accepted → preparing → ready | failed | canceled`). Генерація каталогу чекає на всі набори; одна невдача → `partial/failed` з `creativeOrdinal`.
- Зображення: `reserved → ready` (опубліковано й анонімно перевірено) | `failed`(код); `ready → retiring` (немає використань) → `purged` (об'єкт видалено, 404 підтверджено).
