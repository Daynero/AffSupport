# Contract: спільний клієнт Claude (`supabase/functions/_shared/claude*.ts`)

## Межа

`claude.ts` чистий, без `npm:`-імпортів, тестується у vitest.

```ts
export type ClaudeModel = 'claude-haiku-5-5' | 'claude-sonnet-5-5';
export interface ClaudeRequest {
  model: ClaudeModel; effort: 'low' | 'medium' | 'high';
  system: string; user: string; schema: Record<string, unknown>; maxTokens: number;
}
export interface ClaudeRawResult {           // те, що віддає адаптер
  stopReason: string | null; text: string | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
export interface ClaudeClient { create(request: ClaudeRequest, signal: AbortSignal): Promise<ClaudeRawResult>; }
export type StructuredOutcome =
  | { ok: true; value: unknown; model: ClaudeModel; usage: Usage; costMicroUsd: number }
  | { ok: false; reason: 'refused' | 'unavailable' | 'invalid_output' | 'truncated'; model: ClaudeModel; usage: Usage; costMicroUsd: number };
export function callStructured(client, request, { signal, record }): Promise<StructuredOutcome>;
export function costMicroUsd(model, usage): number;   // таблиця цін нижче
```

`record` — колбек, що пише `ai_usage_events` (outcome `completed|refused|failed`). Його викликають на кожну спробу, навіть невдалу.

Помилки адаптера:
- мережа, 429, 5xx (після вбудованих повторів SDK) → `unavailable`;
- 400/401/403 → `unavailable` + журнал функції з HTTP-кодом, без тіла;
- `stop_reason: 'refusal'` → `refused`;
- `max_tokens` → `truncated`;
- JSON не відповідає схемі → `invalid_output`.

`claude-sdk.ts` (лише в `index.ts`): `new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 })`. Виклик — `client.messages.stream({ model, max_tokens, system, messages:[{role:'user',content:user}], output_config:{ effort, format:{ type:'json_schema', schema } } }).finalMessage()`. Без `temperature`, без `thinking`: adaptive типово, сумісне з обома моделями.

## Ціни (мікродолари за токен = $/MTok)

| Модель | input | output | cache read | cache write 5m |
| --- | --- | --- | --- | --- |
| `claude-haiku-5-5` | 0.10 | 0.50 | 0.01 | 0.125 |
| `claude-sonnet-5-5` | 2 | 10 | 0.10 | 2.5 |

Джерело — офіційна сторінка цін 2026-11-21. Вартість округлюється вгору до цілого мікродолара на виклик.

## Промпт перекладу

System (стабільний, однаковий для всіх запитів):

```text
You translate a video transcript into {{target}} for a reader who does not speak the source language. The translation is shown next to the original transcript so the reader can understand exactly what the video says; it is for reading and review, not for publishing.
Rules:
- Translate faithfully and completely into natural {{target}}. Do not summarize, comment, soften, add or omit anything.
- The transcript is given as numbered lines. Translate only the requested lines, one output string per line, in the same order.
- Keep personal names exactly as spelled in the source when the target language uses the same script; when it uses another script, transliterate them by how they are pronounced in the source language. Keep numbers, units and brand names as in the source.
- Reply with JSON only: {"translations": [ ... ]}.
```

`{{target}}` — англійська назва й код (`Spanish (Mexico) (es-MX)`). Цільова мова стоїть у system, тому кеш промпту діє в межах однієї мови.

User:

```text
Source language: {{source or "unknown — detect it"}}.
Full transcript for context:
<transcript>
1. …
2. …
</transcript>
Translate lines {{from}}–{{to}} ({{count}} lines).
```

Schema: `{ type:'object', properties:{ translations:{ type:'array', items:{ type:'string' } } }, required:['translations'], additionalProperties:false }`. Кількість елементів перевіряється після відповіді.

## Політика шматка

1. Haiku 5.5, `high`, `maxTokens` = 16 000.
2. `invalid_output` або невідповідна кількість → один повтор Haiku.
3. `refused` → один запит Sonnet 5.5, `low`. Повторна відмова → `TRANSLATION_REFUSED` для всієї спроби, решта шматків скасовується.
4. `unavailable` → `TRANSLATION_UNAVAILABLE`.
5. `truncated` → шматок ділиться навпіл один раз (≥ 2 сегменти), інакше `TRANSLATION_FAILED`.
