# Contract: агент і сховище R2

Агент ніколи не отримує ключів R2 і не знає назви бакета. Він працює з URL і сесіями, які видає сервер. Типи живуть у `packages/shared/src/team/transport.ts` (Факт: там уже лежать типи транспорту), версія протоколу піднімається в одному джерелі правди (конституція II).

## Вхід

Задача обробки (компресія, рестітч, рендер лендингу) отримує:

```ts
interface AgentStorageInput {
  materialId: string;
  backend: 'drive' | 'r2';
  url: string;          // presigned GET (r2) або наявний /range (drive)
  expiresAt: string;
  sizeBytes: number;
  sha256?: string;
}
```

Якщо `expiresAt` мине до кінця читання, агент викликає `POST storage-ops/read-urls` з `purpose='agent_input'` і продовжує з поточного зсуву через `Range`. Перезапуск задачі не потрібен.

## Вихід

1. `POST storage-ops/uploads/start` з `source='agent'`, `purpose={kind:'process_output', operationId}` або `{kind:'overwrite', ...}`.
2. Для кожної частини `POST /uploads/:id/parts` → `PUT <url>` з тілом частини, зберегти `ETag`.
3. `POST /uploads/:id/finalize` з усіма `ETag` і SHA-256 усього файлу.
4. Постер: `POST /derived/start` з `role='poster'` → один `PUT`.

Розрив мережі: агент тримає локальний журнал `{sessionId, parts}` і після перезапуску продовжує з першої частини без `ETag` (як resumable-сесія Google зараз).

## Сумісність

- Сервер для простору `r2` відхиляє задачу агента з версією протоколу нижче 071 кодом `AGENT_UPDATE_REQUIRED`; web показує «оновіть Soty на комп'ютері».
- Агент нової версії на Drive-просторі працює як раніше (`backend='drive'`).
- Маршрути агента `/process/output/start|finalize|quiesced` на Drive-просторі лишаються до етапу F.
