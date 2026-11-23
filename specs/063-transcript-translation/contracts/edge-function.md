# Contract: функція `transcript-translate`

`POST /functions/v1/transcript-translate`, `Authorization: Bearer <JWT користувача>`. `verify_jwt = false` у `config.toml`: функція сама перевіряє JWT через `authorizeCaller`, як інші функції простору. CORS — `_shared/cors.ts`.

## start

Тіло:

```jsonc
// простір
{ "action": "start", "targetLanguage": "es-MX",
  "source": { "scope": "team_video", "teamId": "<uuid>", "videoId": "<uuid>" } }
// транскрибатор
{ "action": "start", "targetLanguage": "uk",
  "source": { "scope": "personal", "documentKey": "<job id>",
              "sourceLanguage": "tr" | null, "segments": ["…", "…"] } }
```

Правила:
- `targetLanguage` ∈ `TRANSLATION_TARGET_LANGUAGES`. Збіг з мовою оригіналу → `INVALID_INPUT`.
- `team_video`: сервер викликає `public.list_video_text_variants` клієнтом користувача (його права). Береться оригінал із `ingestState='full'` і `!truncated`, інакше `TRANSLATION_SOURCE_UNAVAILABLE`. Сегменти — непорожні рядки тексту.
- `personal`: 1…4000 сегментів, кожен ≤ 4 000 знаків, тіло ≤ 1 МіБ.
- Сервер нормалізує сегменти, рахує одиниці й відбиток (`packages/shared` dist), потім викликає `private.transcript_translation_begin`.

Відповідь `200`:

```json
{ "ok": true, "value": { "translationId": "<uuid>", "status": "processing" | "completed", "reused": true | false,
  "units": 2700, "allowance": { "limitUnits": 9000, "usedUnits": 3600, "resetsAt": "2026-11-22T00:00:00+02:00" } } }
```

- `reused: true` — переклад того самого тексту на ту саму мову вже готовий (`completed`) або вже виконується (`processing`). Нічого не списано.
- `processing` + `reused: false` — створено нову спробу. Робота триває у фоні (`EdgeRuntime.waitUntil`).

Помилки (конверт `{ok:false,error:{code,retryable,details?}}`):

| code | HTTP | retryable | details |
| --- | --- | --- | --- |
| `AUTH_REQUIRED` | 401 | false | |
| `PERMISSION_DENIED` | 403 | false | |
| `INVALID_INPUT` | 400 | false | |
| `TRANSLATION_SOURCE_UNAVAILABLE` | 409 | false | |
| `TRANSLATION_ALLOWANCE_EXCEEDED` | 429 | false | `{ neededUnits, usedUnits, limitUnits, resetsAt }` |
| `TRANSLATION_UNAVAILABLE` | 503 | true | немає ключа / провайдера |

## watch

Тіло: `{ "action": "watch", "translationId": "<uuid>" }`.

Право на читання перевіряє `public.get_transcript_translation(p_id)` клієнтом користувача. Чужий або неіснуючий id → `404 NOT_FOUND`.

Відповідь `200`, `Content-Type: application/x-ndjson`, `Cache-Control: no-store`. Рядки:

```jsonc
{"type":"progress","status":"processing","completedSegments":12,"totalSegments":25}
{"type":"done","translation":{ /* TranscriptTranslation, див. data-model */ }}
{"type":"failed","code":"TRANSLATION_REFUSED"}
```

- Сервер читає рядок раз на 750 мс, `progress` шле лише при зміні і обов'язково першим.
- Потік закривається після `done`/`failed` або через 330 с (тоді клієнт перепідписується, якщо вкладка видима).
- Стан `processing`, старший за 5 хв, сервер одразу закриває як `failed` / `TRANSLATION_TIMEOUT`, з поверненням резерву.

## Фонова робота

1. Розбити на шматки ≤ 1 500 знаків, паралельно ≤ 3 (див. [claude.md](claude.md)).
2. Після кожного шматка — `private.transcript_translation_progress(id, completed)`.
3. Кінець:
   - успіх → `private.transcript_translation_complete(id, segments, model)`;
   - відмова після фолбеку → `_fail(id,'TRANSLATION_REFUSED')`;
   - мережа або 5xx після повторів SDK → `TRANSLATION_UNAVAILABLE`;
   - невідповідь схемі або кількості двічі → `TRANSLATION_FAILED`;
   - загальний бюджет 240 с → `TRANSLATION_TIMEOUT`.
4. Кожен виклик моделі → `private.ai_usage_record(...)`.
