# Contract: екрани простору в агенті

## Можливість

`packages/shared/src/release.ts`: `AGENT_TOOL_CONTRACTS.teamRestitchSources: 1`.
Не додається до `WEB_TOOL_REQUIREMENTS`. Веб читає з `/api/health.toolContracts`
через `restitchSourcesSupported(contracts)` у shared (як `teamPosterFrameSupported`).

## Опції делегата `restitch` (наявний `process` у `TeamAgentDownloadRequest` і в claim)

```ts
{
  tool: 'restitch',
  defaults: TeamRestitchDefaults,      // як і сьогодні; +sourceMode
  prepared?: MaterialRestitchPrep | null,
  screens?: RestitchScreen[]           // нове; відсутнє або [] = legacy-шлях через бібліотеку
}

interface RestitchScreen {
  slot: 'start' | 'end';
  materialId: string;
  checksum: string;                    // md5 hex з каталогу
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  fileName: string;                    // для розширення і логів
  sizeBytes: number;
  transfer?: { transferUrl: string; grant: TeamTransferGrant } | null;  // null = лише кеш
}
```

Парсер `parseRestitchScreens(unknown)` у `packages/shared/src/team/restitch.ts`,
строгий: невалідний запис → увесь масив відкидається з `RESTITCH_SCREENS_INVALID`.

## Поведінка агента (`apps/agent/src/team-bridge/screen-cache.ts`)

1. Для кожного `screen`: шукати `TeamScreens/<materialId>-<checksum>.<ext>`.
   Є і `probeImage` OK → використати, оновити `lastUsedAt`.
2. Немає → якщо є `transfer`, тягнути наявним `TeamTransferClient` у temp,
   перевірити `sourceChecksum === checksum` (інакше `RESTITCH_SCREEN_FETCH_FAILED`),
   `probeImage`, `rename` у кеш.
3. Перенесення не вдалось, а кеш є → використати кеш, warning у лог.
   Ні кешу, ні `transfer` → `RESTITCH_SCREEN_UNAVAILABLE`; перенесення не
   вдалось і кешу немає (включно з ENOSPC, temp-файл прибрано) →
   `RESTITCH_SCREEN_FETCH_FAILED`; перенесене зображення анімоване (`probeImage`
   показує кадрів > 1) або не проходить probe → `RESTITCH_SCREEN_UNSUPPORTED`,
   у кеші нічого не лишається.
4. `spaceScreens` будується **з цих шляхів**, не з `ImageEmbeddingSettings`;
   `defaults.fitMode/durations/toggles` як і раніше. Коли `screens` відсутні,
   поведінка старого коду без змін (legacy).
5. Орієнтація: `stitcher/exif.ts` повертає `{ transpose?: 0..3, hflip?, vflip? }`
   для файлу; `imageAdaptationFilter` отримує префікс фільтра. Рішення про
   шлях (autorotate ffmpeg 7.1.1 або ffprobe-тег) фіксується першою задачею.
6. Прибирання за data-model.md при старті й після доставки; журнал
   `[screen-cache] evicted n`.

## Що лишається для legacy

- `POST /api/team/restitch-images/:slot/:id` і `ensureRestitchImages` працюють
  до релізу C; потім роут видаляється разом із `imageEmbedding` імпортом
  командних картинок.

## Тести

- `tests/agent-screen-cache.test.ts`: cache hit без мережі, miss з переносом,
  mismatch checksum, fallback на кеш при збої мережі, прибирання за віком і
  за лімітом, ніколи не торкається `Images/`.
- `tests/stitch-exif.test.ts`: фікстури JPEG з Orientation 1/3/6/8 → очікуваний
  фільтр; WebP без тега → без фільтра.
- `tests/stitch-integration.test.ts` (skipIf без ffmpeg): доставка зі `screens`
  з кешу дає обидва екрани; повернуте фото виходить прямим.
