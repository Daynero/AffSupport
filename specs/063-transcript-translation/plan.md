# Implementation Plan: Переклад транскриптів через Claude

**Branch**: `063-transcript-translation` | **Date**: 2026-11-21 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/063-transcript-translation/spec.md`

## Summary

Переклад готового транскрипту (відео простору або текст локального транскрибатора) на обрану мову через Claude API. Виклик іде лише з сервера, з функції Supabase `transcript-translate`. Текст ріжеться на шматки по сегментах, шматки перекладаються паралельно моделлю Claude Haiku 5.5 (`effort: high`, структурована відповідь, повний транскрипт як контекст). Відмову один раз повторює Claude Sonnet 5.5.

Результат зберігається в `private.transcript_translations`, по сегменту на сегмент. Ліміт 10 хв на день (9 000 знаків; 900 знаків = 1 хв) атомарно резервується в спільному механізмі `private.ai_allowance_*` і повертається при будь-якій невдачі. Кожен виклик моделі пишеться в спільний облік витрат `private.ai_usage_events`.

Прогрес іде одним потоковим запитом `watch` (NDJSON). Сервер сам стежить за рядком перекладу, тож закрите й відкрите знову вікно просто перепідписується.

Агент не змінюється. Фіча доставляється вебом і бекендом (швидкий шлях next), без нової версії агента.

## Technical Context

**Language/Version**: TypeScript 5 (strict, ESM NodeNext) у web/shared; Deno (Supabase Edge Runtime) у функціях; PostgreSQL 17 (Supabase) у міграціях.

**Primary Dependencies**: `npm:@anthropic-ai/sdk@1.6.0` (лише у функції, через тонкий адаптер); React 18 + HeroUI v3 інвентар `apps/web/src/components/ui/`; `@video-compressor/shared` (dist імпортується функціями).

**Storage**: Supabase Postgres, схема `private`. Таблиці: `transcript_translations`, `ai_feature_allowances`, `ai_allowance_reservations`, `ai_usage_events`. Доступ клієнта — лише через `security definer` RPC.

**Testing**: vitest single-worker (`--pool=forks --poolOptions.forks.singleFork=true`): чисті модулі shared, `handler.ts` функції з підробленим Claude-клієнтом, компоненти web (Testing Library); SQL-контракт — тести, що читають міграції, і pgTAP у `supabase/tests/database/`; `npm run verify` перед комітом.

**Target Platform**: веб (Cloudflare Pages, next.soty.pp.ua), Supabase Edge Functions; агент macOS/Windows — без змін.

**Project Type**: web app + backend functions (монорепо).

**Performance Goals**: двохвилинний креатив (≈ 1 800 знаків) перекладено ≤ 30 с у 90% (SC-001); збережений переклад відкривається ≤ 1 с (SC-005).

**Constraints**: ключ лише в секретах функцій (FR-040); текст простору читається сервером (FR-041); без нової клієнтської періодичності опитування (Конституція VI); жодного тексту транскрипту в обліку й аналітиці; вартість ≤ $0,02 на повний денний ліміт (SC-006).

**Scale/Scope**: ~30 активних користувачів × ≤ 9 000 знаків на день; до ~10 шматків на переклад; 4 міграції, 1 нова функція, 2 спільні модулі функцій, ~6 компонентів web, правки 4 наявних поверхонь.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Принцип | Як дотримано | Стан |
| --- | --- | --- |
| I. Типізовані контракти, перевірка на межі | Цільові мови, одиниці, відбиток, парсери RPC/потоку — у `packages/shared/src/transcript-translation.ts`. Тіло запиту функції й відповіді моделі — `unknown` → парсер `{ok,value}\|{ok,error}`. Стани — літеральні об'єднання. | ✅ |
| II. Одне джерело контракту релізу | `AGENT_API_VERSION`, `release.ts`, маніфест не чіпаються. `packages/shared/dist` перебудовується перед функціями й тестами. | ✅ |
| III. Безпека й найменші права | Нові таблиці в `private`, RLS + `revoke all`. Читання через `security definer` з `set search_path = ''` і `private.can(...,'view',...)`. Запис лише через `service_role`. Ключ — секрет функцій, ніде в трекнутих файлах. | ✅ |
| IV. Дочірні процеси | Агент не змінюється. | ✅ н/з |
| V. HTTP і помилки | Функція відповідає спільним конвертом `{ok,value}\|{ok:false,error:{code,retryable}}`. Коди — закритий список `TEAM_TRANSLATION_ERROR_CODES` + `STATUS_BY_CODE` + сід у `team_error_codes`. | ✅ |
| VI. Фронтенд | Контроли з інвентарю (`Tabs`, `Popover`, `Progress`, `DropdownMenu`, `Button`/`IconButton`, `Alert`), токени. Виклик через типізовану обгортку `apps/web/src/translation/api.ts`. Події через `analytics.track`. **Прогрес**: один довгий запит `watch`, сервер стежить за рядком; клієнт не опитує періодично. Повторне читання — лише на reconnect/повернення вкладки, як дозволяє VI. | ✅ (обґрунтування в research R6) |

Порушень немає. Таблиця Complexity Tracking порожня.

## Project Structure

### Documentation (this feature)

```text
specs/063-transcript-translation/
├── spec.md
├── plan.md              # цей файл
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── edge-function.md # transcript-translate: start / watch
│   ├── database.md      # таблиці, RPC, сервісні функції
│   ├── claude.md        # спільний клієнт моделі, промпт, облік
│   └── ui.md            # поверхні, стани, тексти
├── checklists/requirements.md
└── tasks.md             # $speckit-tasks
```

### Source Code (repository root)

```text
packages/shared/src/
├── transcript-translation.ts      # мови, одиниці, нормалізація, відбиток, парсери
└── index.ts                       # реекспорт
packages/shared/src/team/transport.ts  # TEAM_TRANSLATION_ERROR_CODES

supabase/migrations/
├── 20261222110000_ai_allowance_and_usage.sql
├── 20261222111000_transcript_translations.sql
├── 20261222112000_translation_error_codes.sql
└── 20261222113000_ai_usage_analytics.sql
supabase/functions/
├── _shared/claude.ts              # чистий: запит, розбір, відмова, вартість, облік
├── _shared/claude-sdk.ts          # адаптер npm:@anthropic-ai/sdk → ClaudeClient
├── _shared/ai-allowance.ts        # reserve/settle через service-клієнт
└── transcript-translate/
    ├── index.ts                   # Deno.serve, env, клієнти, waitUntil
    ├── handler.ts                 # start/watch (чистий, тестується)
    ├── translate.ts               # шматки, паралельність, повтор, Sonnet-фолбек
    └── fake-provider.ts           # детермінований провайдер для бети/тестів
supabase/config.toml               # [functions.transcript-translate]
config/environments.json, supabase/functions/.env.example  # ANTHROPIC_API_KEY

apps/web/src/translation/
├── api.ts                         # start, watch (NDJSON), list*, allowance
├── useTextVariants.ts             # оригінал + переклади + активні спроби + плавний прогрес
├── TranslateLauncher.tsx          # вибір мови + вартість/залишок або пояснення
├── TextVariantTabs.tsx            # ряд варіантів у вікні перегляду
├── TranslationProgress.tsx        # плашка прогресу
├── TextVariantReader.tsx          # читабельний текст сегментами, dir
├── CopyVariantButton.tsx          # копіювати одразу або з вибором варіанта
└── format.ts                      # хвилини, узгоджене округлення
apps/web/src/team/library/VideoTextActions.tsx   # бічна картка + вікно перегляду простору
apps/web/src/transcription/TranscriptTextModal.tsx, TranscriptionCopyMenu.tsx, ExportMenu.tsx, export.ts
apps/web/src/styles/translation.css               # лише токени
apps/web/src/locales/en.ts, uk.ts                  # ключі textTranslation*
apps/web/src/analytics/events.ts                   # flow_step transcript_translation

scripts/analytics/{queries.ts,code-map.ts,coverage-registry.ts}, scripts/analytics.ts  # команда ai-usage
tests/                             # нові тести (див. tasks.md)
```

**Structure Decision**: новий модуль `apps/web/src/translation/` спільний для простору й транскрибатора. Обидві поверхні лише монтують його компоненти. Серверна частина — одна функція плюс два спільні модулі `_shared/claude*.ts` і `_shared/ai-allowance.ts`, придатні для наступних функцій із моделлю (FR-045).

## Complexity Tracking

Порушень Конституції немає.
