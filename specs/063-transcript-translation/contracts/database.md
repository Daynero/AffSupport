# Contract: база даних

Усі функції `security definer`, `set search_path = ''`, повністю кваліфіковані імена.

## Клієнтські (grant execute to authenticated)

### `public.ai_allowance_status(p_feature text) returns jsonb`

```json
{ "feature": "transcript_translation", "limitUnits": 9000, "usedUnits": 3600,
  "day": "2026-11-21", "resetsAt": "2026-11-22T00:00:00+02:00" }
```

Для `auth.uid()`. `resetsAt` — наступна північ за Києвом як ISO з поясом. Невідома функція → `INVALID_INPUT`, без користувача → `AUTH_REQUIRED`.

### `public.list_video_translations(p_team uuid, p_video uuid) returns jsonb`

`private.can(p_team,'view',auth.uid())`, інакше `PERMISSION_DENIED`. Повертає `{ "translations": TranscriptTranslation[] }`:
- для кожної мови — найновіший `completed` (з сегментами);
- плюс кожен свіжий `processing` (без сегментів, з прогресом);
- плюс найновіший `failed`, новіший за останній `completed`/`processing`, **лише якщо його запустив поточний користувач** (без сегментів, з `failureCode`): чужа невдала спроба не є станом відео для інших учасників.

### `public.list_personal_translations(p_document_key text, p_fingerprint text) returns jsonb`

Той самий набір для `owner_id = auth.uid()` і (`document_key = p_document_key` або `source_fingerprint = p_fingerprint`).

### `public.get_transcript_translation(p_id uuid) returns jsonb`

Один рядок, якщо користувач має право: `team_video` → `can view`; `personal` → власник. Інакше `NOT_FOUND`. `processing`, старший за 5 хв, тут же закривається як `TRANSLATION_TIMEOUT` (через `private.transcript_translation_expire`).

`TranscriptTranslation` (camelCase):

```json
{ "id": "…", "scope": "team_video", "targetLanguage": "uk", "sourceLanguage": "tr",
  "sourceFingerprint": "v1:…", "status": "completed", "failureCode": null,
  "segments": ["…"], "totalSegments": 25, "completedSegments": 25, "units": 1841,
  "model": "claude-haiku-5-5", "createdAt": "…", "completedAt": "…" }
```

## Сервісні (grant execute to service_role only)

| Функція | Дія |
| --- | --- |
| `private.transcript_translation_begin(p_scope, p_team, p_video, p_owner, p_document_key, p_fingerprint, p_source_language, p_target_language, p_total_segments, p_units, p_requested_by) returns jsonb` | Під advisory-замком користувача й функції: закрити прострочені `processing` цієї області; якщо є `completed`/`processing` з тим самим відбитком і мовою — повернути його (`reused`); інакше резерв (виняток `TRANSLATION_ALLOWANCE_EXCEEDED` з деталями) і вставка `processing`. Повертає `{id,status,reused,allowance}`. |
| `private.transcript_translation_progress(p_id, p_completed)` | `completed_segments = greatest(current, p_completed)` лише для `processing`. |
| `private.transcript_translation_complete(p_id, p_segments text[], p_model)` | Перевірка довжини. `completed`, резерв → `spent`, видалення старих `completed` тієї ж області й мови. Ідемпотентна. |
| `private.transcript_translation_fail(p_id, p_code)` | `failed`, резерв → `released`. Ідемпотентна. Не чіпає `completed`. |
| `private.ai_allowance_reserve(p_user, p_feature, p_units) returns uuid` | Загальний резерв для інших функцій (FR-045). |
| `private.ai_allowance_settle(p_reservation, p_spent boolean)` | Загальне врегулювання. |
| `private.ai_usage_record(p_feature, p_user, p_subject, p_model, p_outcome, p_stop_reason, p_input, p_output, p_cache_read, p_cache_write, p_cost_micro_usd, p_duration_ms)` | Запис обліку. |

## Аналітика (grant select to wishly_analytics_ro)

- `public.analytics_ai_usage_daily`: `day` (UTC), `feature`, `model`, `outcome`, `calls`, `input_tokens`, `output_tokens`, `cost_micro_usd`, `users`.
- `public.analytics_transcript_translations`: `id`, `scope`, `target_language`, `status`, `failure_code`, `units`, `total_segments`, `model`, `requested_by`, `created_at`, `completed_at`, `duration_ms`. Без сегментів і без відбитка.

## Коди помилок

`TEAM_TRANSLATION_ERROR_CODES = ['TRANSLATION_ALLOWANCE_EXCEEDED','TRANSLATION_SOURCE_UNAVAILABLE','TRANSLATION_UNAVAILABLE','TRANSLATION_REFUSED','TRANSLATION_FAILED','TRANSLATION_TIMEOUT']` — у `transport.ts`, `STATUS_BY_CODE` (429, 409, 503, 422, 502, 504) і сід `20261222112000_translation_error_codes.sql`.
