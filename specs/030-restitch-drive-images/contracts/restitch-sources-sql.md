# Contract: SQL-функції пулів ре-стітчу

Усі функції `security definer set search_path = ''`, повні імена, `revoke all`
перед `grant`. Імена відповідають інваріанту `supabase/tests/database/team-restitch.test.sql`
(`%restitch%`: grant to `authenticated`, крім `service_%` → `service_role`).

## `public.list_restitch_sources(p_team uuid, p_scope text) returns jsonb`

- Якщо підключення простору не `connected`, кожне джерело має `availability: 'disconnected'`,
  обидва пули `state: 'empty'`.

- `p_scope`: `'owner'` (пул простору) або `'self'` (особистий пул того, хто викликає).
- Право: учасник з `view`. Для `'self'` повертає пули викликача навіть якщо `use_owner=true`.
- Відповідь:

```json
{
  "sourceMode": "drive" | "legacy",
  "legacyImageCount": 0,
  "pools": {
    "start": {
      "state": "ready" | "partial" | "empty",
      "overLimit": false,
      "eligibleCount": 37,
      "sources": [
        { "materialId": "…", "kind": "folder", "name": "Фінальні", "availability": "available",
          "imageCount": 37, "skipped": { "format": 2, "size": 1, "animated": 0 } },
        { "materialId": "…", "kind": "file", "name": "logo.png", "availability": "trashed",
          "imageCount": 0, "skipped": { "format": 0, "size": 0, "animated": 0 } }
      ]
    },
    "end": { … }
  }
}
```

## `public.set_restitch_sources(p_team uuid, p_slot text, p_items jsonb) returns jsonb`

- Лише власник простору (`teams.owner_id = auth.uid()`), інакше `RESTITCH_FORBIDDEN`.
- `p_items`: масив `{ "materialId": uuid } | { "driveFileId": text, "kind": "folder" }`
  (другий варіант для щойно створеної папки перенесення, яку каталог ще не проіндексував;
  зберігається одразу в `drive_file_id`, показується як `pending`; `list` і `draw` при кожному
  виклику резолвлять `drive_file_id` у `material_id`, коли матеріал з'явився в каталозі).
- Перевірки: ≤ 500 елементів (`RESTITCH_SOURCES_TOO_MANY`); кожен матеріал належить
  простору і є або папкою, або `category='image'` (`RESTITCH_SOURCES_INVALID`).
- Замінює пул слоту повністю (як `set_team_product_catalog_image_sources`), ставить
  `team_restitch_defaults.source_mode='drive'`, очищає відповідний uuid[], `configured=true`,
  `updated_by`, `updated_at`. Повертає те, що повернув би `list_restitch_sources(p_team,'owner')`.

## `public.set_member_restitch_sources(p_team uuid, p_slot text, p_items jsonb) returns jsonb`

- Те саме для особистого пулу викликача (рядок `team_member_restitch_preferences`
  створюється за потреби з `use_owner=false`). Право: учасник з `view`.

## `public.draw_restitch_screens(p_team uuid, p_exclude uuid[] default '{}') returns jsonb`

- `p_exclude`: матеріали, які не повертати (одна повторна спроба після збою гранта).
- Право: учасник з `view`. Налаштування — ефективні для викликача
  (`private.effective_restitch_defaults_json`), пули — відповідної області.
- Відповідь:

```json
{
  "sourceMode": "drive",
  "pool": { "start": "ready", "end": "partial" },
  "screens": [
    {
      "slot": "start",
      "materialId": "…",
      "checksum": "md5hex",
      "name": "a.jpg",
      "mimeType": "image/jpeg",
      "sizeBytes": 123456,
      "driveVersion": "17"
    }
  ]
}
```

- `operation='unstitch'` → `screens: []` без помилки. Увімкнені слоти без
  жодної картинки й `operation<>'unstitch'` → `RESTITCH_POOL_EMPTY`.
- Для `sourceMode='legacy'` повертає `{ "sourceMode": "legacy", "screens": [] }`;
  клієнт іде старим шляхом.

## `public.service_draw_restitch_screens(p_team uuid, p_actor uuid, p_exclude uuid[] default '{}') returns jsonb`

- Лише `service_role`. Той самий результат, але завжди для пулу **простору**
  (`user_id is null`) і налаштувань власника, незалежно від `p_actor`;
  `p_actor` лише для аудиту.

## `private.restitch_pool_images(p_team uuid, p_user uuid, p_slot text)`

- Внутрішня, без грантів. Повертає `(material_id, drive_file_id, resource_key, name,
checksum, mime_type, size_bytes, drive_version)` за правилами data-model.md.

## `public.service_defer_restitch_job(p_job uuid, p_lease_token_hash bytea, p_code text, p_interval interval) returns boolean`

- Лише `service_role`. Перевіряє lease як `service_complete_restitch_job`; ставить
  `state='queued'`, `next_attempt_at = clock_timestamp() + p_interval`, `last_error_code = p_code`,
  **не** змінює `attempts`; звільняє lease. Використовується для `RESTITCH_POOL_EMPTY`.

## Міграція, та сама

- `alter table … add column source_mode` на обох таблицях налаштувань.
- `drop policy team_restitch_images_write on storage.objects` (R11, FR-028).
  SELECT-політика лишається.
- `insert into public.team_contract_seed` нові коди (див. data-model.md).
- `private.effective_restitch_defaults_json` додає `sourceMode` у jsonb.
- `ROLLBACK.md`: зворотні кроки, включно з відновленням INSERT-політики.

## Тести

- `tests/team-restitch-sources-sql.test.ts` (PGlite): права, заміна пулу,
  ліміт, відсів форматів/розміру, рекурсія, дедуплікація за `checksum`,
  `availability` для кожного `lifecycle`/`missing_reason`, `legacy`→`drive`.
- `tests/team-restitch-draw-sql.test.ts`: рівномірність по унікальних
  `checksum` (статистично на 1000 викликів), `unstitch`, порожній пул,
  `service_*` завжди бере пул простору.
- `supabase/tests/database/team-restitch.test.sql`: інваріанти імен і грантів
  проходять без змін.
