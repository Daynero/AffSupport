# RPC contracts — 059

Обидві функції: `security definer`, `set search_path = ''`, `grant execute … to authenticated`,
відповіді — jsonb, розбирані на клієнті guard-ами з `apps/web/src/team/ranks/creativeRanks.ts` (без `as`).

## `public.list_creative_ranks(p_team uuid, p_materials uuid[]) returns jsonb`

- Право: `private.can(p_team,'view')`, інакше `PERMISSION_DENIED` (42501).
- `p_materials`: 1…500 унікальних id, інакше `INVALID_INPUT` (22023).
- Повертає лише креативи, що мають рядок проєкції:

```json
[{ "materialId": "uuid", "launchCount": 74, "rankCredit": 74,
   "lastLaunchedAt": "2026-11-16T09:12:00Z", "version": 81,
   "demotion": null | { "reason": "disappointed" | "never_launched", "at": "ISO" } }]
```

Відсутній id = без рангу, без запусків. `demoted_by` не віддається.

## `public.demote_creative_rank(p_team uuid, p_material uuid, p_reason text, p_target_credit integer, p_expected_version bigint, p_request_key text) returns jsonb`

- Право: `private.team_role(p_team, auth.uid()) = 'owner'`, інакше `PERMISSION_DENIED` (42501).
- `p_reason` ∈ `disappointed | never_launched`; `p_request_key` 8…200 символів; інакше `INVALID_INPUT` (22023).
- Немає рядка проєкції → `RANK_NOT_LOWER` (PT409) — без рангу понижувати нікуди.
- `p_request_key` = збережений `demote_request_key` → повертає поточний стан (ідемпотентний повтор).
- `version <> p_expected_version` → `RANK_CONFLICT` (PT409) з актуальним станом у `detail`.
- `p_target_credit < 0` або `>= rank_credit` → `RANK_NOT_LOWER` (PT409).
- Успіх: `rank_credit = p_target_credit`, `demoted_*`, `version + 1`, подія `creative_rank` у
  `team_catalog_events`; повертає той самий об'єкт, що й `list_creative_ranks` для одного id.

## `public.promote_creative_rank(p_team uuid, p_material uuid, p_target_credit integer, p_expected_version bigint, p_request_key text) returns jsonb`

Виправлення помилкового пониження (FR-010a).

- Право: лише `owner`, інакше `PERMISSION_DENIED` (42501); `p_request_key` 8…200, інакше `INVALID_INPUT` (22023).
- Немає рядка проєкції → `RANK_NOT_HIGHER` (PT409).
- `p_request_key` = збережений `promote_request_key` → поточний стан (ідемпотентний повтор).
- `version <> p_expected_version` → `RANK_CONFLICT` (PT409) з актуальним станом у `detail`.
- `p_target_credit <= rank_credit` або `> launch_count` → `RANK_NOT_HIGHER` (PT409): вище запусків — ніколи.
- Успіх: `rank_credit = p_target_credit`, `promoted_at/by/request_key`, `version + 1`, подія `creative_rank`.
  Ціль рахує клієнт (`promotionTarget`): поріг наступної ліги, а для ліги, заробленої запусками, — `launch_count`.

## Тригери (внутрішній контракт)

- `team_launch_generations` AFTER UPDATE OF state, deferred → `private.credit_launch_rank()`.
- `team_product_catalogs` AFTER INSERT, deferred → `private.credit_catalog_rank()`.
- Обидва викликають `private.apply_creative_rank_event(team, material, kind, source, occurred_at)`,
  яка реалізує поглинання (research R3) і пише `team_catalog_events('creative_rank')`.
- Жодних винятків назовні: зарахування не має права зламати публікацію Launch чи створення каталогу,
  тому відсутній креатив (видалений матеріал, порожній `materialId`) — тихий пропуск, а не помилка.
