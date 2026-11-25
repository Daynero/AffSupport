# План 073 · Файли виходять із Soty без метаданих

[Вимоги](spec.md) · [Задачі](tasks.md) · [Знахідки](findings.md)

## Технічний контекст

TypeScript strict. Спільний модуль у `packages/shared` (без залежностей, `Uint8Array`), який імпортують вебзастосунок, агент (Node) і Edge-функції (Deno, через `packages/shared/dist`). Агент має FFmpeg для ремуксу «чужих» контейнерів. Тести — Vitest single-worker; справжні файли генерує FFmpeg у `describeRequiring(ffmpegBinaries, …)`.

## Де байти виходять назовні і де їх чистити

| Шлях | Хто рухає байти | Точка очищення |
| --- | --- | --- |
| «Завантажити» ≤ 32 МіБ | браузер з `drive-transfer/range` | `web/team/materials/download-material.ts` → `stripMediaMetadata` перед збереженням Blob |
| «Завантажити» > 32 МіБ, масове, «перезашите», «стиснути й завантажити» | агент `/api/team/download` | `agent/team-bridge/download.ts` — після копіювання в обрану теку, `stripMetadataInPlace` |
| Перезашивка (усі входи: доставка, запуски, варіанти каталогу, нативна, локальна склейка) | `stitcher/pipeline.ts` | після `verifyOutput`, на місці |
| Обробка в простір (компресор, вбудовування, лендинг, перезашивка) | `team-bridge/process.ts` → `transfer.uploadResult` | після `authorize`, перед вивантаженням |
| Локальний компресор | `queue/queue.ts` | після успішного кодування, коли «Витерти метадані» ввімкнено |
| Оптимізатор лендингів (пропущені/невдалі файли) | `landing/metadata.ts` | спершу спільна утиліта, FFmpeg — для решти |
| Картинки каталогу в R2 | `_shared/catalog-image-optimization.ts` | після оптимізації, перед валідацією |
| R2-копія відео каталогу | `catalog-video-r2/worker.ts` | латки на кожну частину; MD5 джерела в перевірці |

## Структура

```
packages/shared/src/media-metadata.ts      правила; stripMediaMetadata, planIsoBmffMetadataPatches(+Remote),
                                            applyMediaMetadataPatches(+ToWindow), isMetadataBearingFileName
packages/shared/src/release.ts             контракт teamCleanDelivery: 1, cleanDeliverySupported()
apps/agent/src/files/strip-metadata.ts     stripMetadataInPlace (латки через fd, картинки через temp+rename, FFmpeg-ремукс)
apps/web/src/team/materials/download-material.ts   одні двері скачування (браузер/агент, чисто/оригінал)
apps/web/src/team/materials/actions.ts     дія downloadWithMetadata («Завантажити з метаданими», лише меню)
```

## Рішення

1. **Латки замість ремуксу для MP4/MOV.** Таблиці семплів тримають абсолютні зсуви; якщо нічого не рухати, досить кількох КБ записів на файлі в гігабайти, і та сама логіка працює в браузері (копія в пам'яті), в агенті (fd) і на сервері (по частинах R2). Ремукс FFmpeg переписав би весь файл, додав би свій `encoder` і не прибрав би підпис x264.
2. **Доріжки, крім відео й звуку, прибираються** (бокс `trak` → `free`, семпли занулено). Креатив — це картинка й звук; таймкод, телеметрія й субтитри-телеметрія — саме те, що видає час і місце.
3. **Браузер чистить сам**, бо він і так тримає ≤ 32 МіБ; агента не будимо для кожної картинки. Чого браузер не вміє (WebM, MKV) — іде через агента, як файл > 32 МіБ.
4. **Старий агент — `AGENT_UPDATE_REQUIRED`**, не «брудний» файл. Контракт `teamCleanDelivery` у `AGENT_TOOL_CONTRACTS`, не у `WEB_TOOL_REQUIREMENTS` (той порівнюється з підписаним `stable.json`).
5. **Перезашивка чиститься в кінці конвеєра**, після `verifyOutput`: латки не змінюють ні розміру, ні кадрів, ні часу кадрів — перевірене і є тим, що піде далі. Так чистими стають усі входи перезашивки разом, і не треба чіпати файли, які зараз змінює інший агент (`native-restitch-controller.ts`, `catalog-variant-closure.ts`, `catalog-video-foreground.ts`, `recovery-worker.ts`, `transfer.ts`).
6. **R2-відео: MD5 лишається MD5 джерела.** Частини вивантажуються залатаними; у перевірці кожна залатана ділянка, що справді містить латку, підміняється байтами з Drive перед MD5. Так доказ «копія зроблена з цього файлу Drive» лишається тим самим рядком у базі, без міграції. Ціна: перевірка MP4/MOV читає з Drive залатані ділянки (один запит на частину, що їх містить); для не-ISO-BMFF перевірка, як і раніше, без Drive.
7. **Компресор**: перемикач «Витерти метадані» лишається (увімкнений за замовчуванням) — це той самий вибір «чисто/оригінал», що й «Завантажити з метаданими», для локального інструмента. Але все, що компресор вивантажує в простір, чиститься завжди (`process.ts`).

## Реліз

Зміни агента (`files/strip-metadata.ts`, `download.ts`, `routes.ts`, `process.ts`, `pipeline.ts`, `queue.ts`, `landing/metadata.ts`) і `packages/shared` → **повний реліз агента**. Edge-функції (`catalog-video-r2`, оптимізатор картинок у `catalog-images`, `catalog-global-images`, `drive-ops`) → бекенд-план. Міграцій немає.
