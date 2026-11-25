# Задачі 073 · Файли виходять із Soty без метаданих

[Вимоги](spec.md) · [План](plan.md) · [Знахідки](findings.md). Vitest — single-worker.

## Фаза 1 · Інвентар і правила

- [x] T001 Інвентар усіх шляхів виходу файлів назовні (вебзастосунок, агент, shared, Edge-функції, R2-воркер доставки). — Таблиця «шлях → було → стало» у [findings.md](findings.md).
- [x] T002 Визначити «повністю» для відео й картинок, рішення щодо орієнтації й ICC. — [spec.md](spec.md), розділ «Що „повністю“ означає».

## Фаза 2 · Спільна утиліта

- [x] T003 `packages/shared/src/media-metadata.ts`: JPEG/PNG/WebP/GIF (перескладання), ISO-BMFF (латки на місці: `udta`/`meta`/`uuid` → `free`, дати, `hdlr`, `compressorname`, `vendor`, не-AV доріжки й їхні семпли, SEI x264/x265 зокрема в `hvcC`), HEIF (EXIF/XMP-елементи за `iloc`). Латки не перекриваються.
- [x] T004 `planIsoBmffMetadataPatchesRemote`, `applyMediaMetadataPatchesToWindow`, `mediaMetadataPatchesInWindow` — для копіювання частинами.
- [x] T005 Тести `tests/media-metadata-strip.test.ts`: синтетичні JPEG/PNG/WebP/GIF; справжні MP4/MOV/HEVC/JPEG/PNG від FFmpeg — теги порожні (ffprobe), підписи кодерів зникли, орієнтація на місці, декодовані кадри/семпли з тим самим MD5.

## Фаза 3 · Скачування (US1, US2)

- [x] T006 Контракт агента `teamCleanDelivery: 1`, `cleanDeliverySupported()`; веб відмовляє старому агенту в чистому скачуванні медіа (`AGENT_UPDATE_REQUIRED`).
- [x] T007 `apps/agent/src/files/strip-metadata.ts` (`stripMetadataInPlace`); `download.ts` чистить збережений файл, якщо не `metadata: 'keep'`; невдача — файл прибрано, `METADATA_STRIP_FAILED`. Маршрут `/api/team/download` приймає `metadata`.
- [x] T008 `web/team/materials/download-material.ts` — одні двері: браузер чистить ≤ 32 МіБ сам, чого не вміє — через агента; «оригінал» — пряме посилання. Переведено `useMaterialActions`, `useExplorerFileOps` (картка/панель), `TaskAttachmentTile`, `LibraryShareActions`.
- [x] T009 Дія `downloadWithMetadata` «Завантажити з метаданими» в реєстрі (лише меню, для картинок і відео), обробник у `MaterialActionHost`, тексти uk/en; повідомлення `teamErrorMetadataStripFailed`.
- [x] T010 Тести: `tests/team-download-clean.test.ts` (агент: чисто за замовчуванням, `keep` — оригінал, невдача — нічого не збережено), `tests/team-file-operations.test.tsx` (меню «з метаданими»: браузер без fetch, агент з `metadata: 'original'`), оновлено `creative-library-tasks` і аналітику скачування.

## Фаза 4 · Те, що робить Soty (US3)

- [x] T011 `stitcher/pipeline.ts`: очищення після `verifyOutput` — усі входи перезашивки.
- [x] T012 `team-bridge/process.ts`: очищення результату після `authorize`, перед `uploadResult`; розмір перечитується.
- [x] T013 `queue/queue.ts`: локальний компресор латає результат, коли «Витерти метадані» ввімкнено.
- [x] T014 `landing/metadata.ts`: пропущені/невдалі файли лендингу — спершу спільна утиліта (FFmpeg-копія лишала JPEG APP1).

## Фаза 5 · Каталоги (US4)

- [x] T015 `_shared/catalog-image-optimization.ts`: повне очищення картинок каталогу (R2-картинки запусків, пул, глобальні). Тести оптимізатора оновлено (EXIF/IPTC фікстури тепер зникають, JFIF першим).
- [x] T016 `catalog-video-r2/worker.ts`: латки на кожну частину; у перевірці залатані ділянки підміняються байтами з Drive → MD5 джерела. Тести: публічна копія без `udta` з тим самим MD5-доказом; частини, вивантажені до 073, перевіряються; підмінена частина — `VIDEO_R2_CHECKSUM_MISMATCH`.

## Фаза 6 · Перевірка

- [x] T017 Гейти: prettier/eslint на змінених, `tsc` агента й вебу (поза чужими незакоміченими файлами 071), пов'язані тести.
- [x] T018 Бета в Chrome: «Завантажити» → ffprobe порожній (без `encoder`, `handler_name`), розмір той самий, 658 змінених байтів; «Завантажити з метаданими» → оригінал (`encoder=Lavf58.45.100`, `VideoHandler`). Свої файли з `~/Downloads` прибрано.

## Фаза 7 · Масове скачування (US5) і Safari (US6)

- [x] T022 Агент: `saveInto` у `/api/team/download` — тека `Завантаження/Soty/<назва>` (санітизована, з резервною `Movies`/`Videos`, якщо macOS не дає Downloads); відповідь `destination` — для решти пачки.
- [x] T023 Черга агента (`useAgentQueue`): інструмент `download` з `deliver: { saveInto, metadata }`, прогрес передачі, зупинка забирає решту локальної пачки, підсумкові тости «Скачано файлів».
- [x] T024 `useSelectionDownload` + `ExplorerSelection`: «Скачати (N)» на панелі, «Скачати з метаданими (N)» у «⋯»; без Soty — браузер по одному з тостом-прогресом; > 32 МіБ — підрахунок і «Відкрити Soty» (`LocalAppDialog`); теки — пропуск з поясненням. Працює і в провіднику, і в результатах пошуку (один компонент).
- [x] T025 Safari: `browser-download.ts` — `fetchForDownload` + `saveBytesAsDownload` (blob, без `target`), `handoffBrowserDownload` без `_blank`; усі браузерні скачування через blob.
- [x] T026 Тести: `tests/team-selection-download.test.tsx` (послідовність без агента, чисто/оригінал, підрахунок > 32 МіБ і кнопка, черга з `saveInto`, старий агент → браузер), `tests/browser-download-isolation.test.ts` (без `_blank`, blob відпускається), `tests/team-download-clean.test.ts` (`saveInto` не виходить за `Downloads/Soty`).

## Відкрите

- [ ] T019 Публічне посилання на оригінал у Drive (каталог без R2 і без перезашивки, «Скопіювати посилання») — потрібна чиста копія на Drive або R2 за замовчуванням. Див. findings «Що лишилось».
- [ ] T020 Повний реліз агента (контракт `teamCleanDelivery`) + бекенд-план (`catalog-video-r2`, `catalog-images`, `catalog-global-images`, `drive-ops`). До релізу агента на next скачування медіа > 32 МіБ зі старим Soty просить оновлення.
- [ ] T021 Наявні R2-об'єкти (картинки й відео, опубліковані до 073) лишаються з метаданими, доки їх не переопублікують.
