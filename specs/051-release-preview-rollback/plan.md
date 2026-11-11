# Implementation Plan: Тестова версія на окремому посиланні, розкатка перевіреного і відкат

**Branch**: `051-release-preview-rollback` | **Date**: 2026-11-11 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/051-release-preview-rollback/spec.md`

## Summary

Обидва наявні шляхи релізу (раннер повного релізу і `release:web`) зараз закінчуються
`scripts/deploy-web.mjs`, який кладе бандл на прод (`--branch main` проєкту `wishly-app`).
Фіча вставляє між «зібрано й перевірено автоматикою» і «бачать усі» ручну перевірку
власника:

1. `deploy-web.mjs` за замовчуванням кладе бандл на гілку `next` того самого
   Cloudflare-проєкту. Адреса `https://next.soty.pp.ua` — проксований CNAME на
   `next.wishly-app.pages.dev`. Кожна нова збірка замінює попередню за тією ж адресою.
2. Бандл (разом із підписаним `stable.json` кандидата) архівується в одному місці на
   машині релізу, незалежно від воркдерева раннера: `~/Library/Application Support/Soty/release-channel`.
3. `npm run release:channel -- promote` перевіряє, що `next` віддає саме заархівований
   бандл, і завантажує ті самі байти на прод. Cloudflare вже має всі файли з `next`, тож
   завантаження миттєве, а «отруєння» кешу модулів при цьому менш імовірне.
4. `release:channel -- rollback` повертає на прод попередній розкочений бандл з архіву,
   разом із його `stable.json`. Отже канал агента теж повертається. Встановлений новіший
   агент на macOS поступається старішому при заміні застосунку на місці (наявний механізм
   C21). Сайт тепер пропонує «повернутися на стабільну версію», якщо встановлений агент
   новіший за стабільний канал.
5. `release:channel -- cancel` повертає `next` на поточний прод-бандл.
6. Агент, Edge Functions, повернення з Drive OAuth і вхід приймають `next.soty.pp.ua` як
   другу адресу того самого проду. Веб визначає адресу сайту й канал агента з власного
   origin, тому один і той самий бандл коректно працює на обох адресах.
7. На `next` працюють лише тестери: адміни і явний список `release_testers`, яким керує
   адмінка.
8. CI (`verify-all`) блокує нові міграції, що не лише додають. Явно позначене прибирання
   (`-- soty:cleanup`) йде наявним шляхом workspace cutover.

Фіча вмикає сама себе першим релізом, що її містить. Міграція, функції й новий агент
приходять через `backend_apply` і публікацію; лише після цього `next` повноцінно працює з
бекендом і агентом. Разові зовнішні налаштування (DNS, Supabase Redirect URLs, referrer
ключа Picker) робляться вже зараз і нічого на проді не змінюють.

## Technical Context

**Language/Version**: Node 22 ESM-скрипти (`scripts/`), TypeScript 5 (web/agent/shared), Deno (Supabase Edge Functions), PostgreSQL 17 (міграції)

**Primary Dependencies**: wrangler 4.112.0 (`pages deploy --branch`), наявні `scripts/lib/release/*`, `scripts/lib/web-rollback.mjs`, `scripts/lib/release/migration-compat.mjs`, HeroUI v3 (адмінка й банер)

**Storage**: локальний каталог стану каналу (JSON + JSONL + архів бандлів, mode 0700/0600); таблиця `public.release_testers`

**Testing**: vitest single-worker у `tests/`; PGlite для SQL; dry-run деплою через інжектований uploader; реальний прогін на `next.soty.pp.ua` через Chrome

**Target Platform**: машина релізу macOS; користувачі macOS arm64/x64 і Windows x64

**Project Type**: монорепо (web + agent + shared + supabase + release scripts)

**Performance Goals**: promote і rollback ≤ 5 хв (зазвичай < 1 хв, бо файли вже в проєкті)

**Constraints**: слабка машина (одна важка дія, `nice`), без запису секретів, без автоматичного відкату міграцій, прод змінюється лише явною командою власника

**Scale/Scope**: ≤ 2 тестери, 24 акаунти, 1 кандидат одночасно

## Constitution Check

| Принцип | Як дотримано |
|---|---|
| I. Типізовані контракти на межі | Стан каналу валідується при читанні; `PREVIEW_SITE_ORIGIN` — константа в `release.ts`, а не рядок у скриптах |
| II. Одне джерело правди релізу | `PREVIEW_SITE_ORIGIN` живе в `release.ts` поруч із `PRODUCTION_SITE_ORIGIN`. Підписаний `stable.json` кандидата не перепідписується при розкатці: на прод іде той самий файл. Production binding лишається закріпленим; preview-поля похідні й перевіряються на непересічність для sandbox |
| III. Безпека | Друга адреса додається лише до прод-конфігурації, а не як wildcard. Повернення з Drive OAuth іде лише на origin зі списку дозволених. Доступ до `next` закритий за `is_release_tester()` (security definer, лише власний рядок) |
| IV. Дочірні процеси | Деплой іде тим самим `spawnSync` wrangler без shell, під спільним web-release lock |
| V. HTTP/помилки | Нові відмови мають коди `CHANNEL_*`, як `ROLLBACK_*` |
| VI. Фронтенд | Банер, гейт і секція адмінки з компонентів `components/ui`, лише токени |
| Workflow gates | Нова перевірка міграцій — гейт у `verify-all`, а не окрема інструкція. `deploy:web` лишає всі попередні перевірки; змінюється лише адресат |

Порушень немає. Ризик: зміна семантики `deploy:web`, бо тепер прод оновлюється лише через
`promote`. Це задокументовано в `docs/PRODUCTION.md` і `AGENTS.md`.

## Project Structure

### Documentation (this feature)

```text
specs/051-release-preview-rollback/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── release-channel-cli.md
│   └── origins.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/shared/src/release.ts            # PREVIEW_SITE_ORIGIN, PREVIEW_BRANCH, isSotySiteOrigin()
apps/web/src/lib/config.ts                # siteChannel(), runtime siteUrl для next
apps/web/src/release-manifest.ts          # same-origin manifest, статус ahead_of_stable
apps/web/src/components/NextChannelBadge.tsx
apps/web/src/components/ReleaseTesterGate.tsx
apps/web/src/components/ReleaseUpdateNotice.tsx   # пропозиція повернутись на стабільну
apps/web/src/pages/admin/ReleaseTestersSection.tsx
apps/agent/src/config.ts                  # allowedOrigins + preview
apps/agent/src/server/app.ts              # /pair повертає на дозволений origin
supabase/migrations/2026111…_release_testers.sql
supabase/functions/_shared/cors.ts        # preview origin для прод-конфігурації
supabase/functions/drive-oauth-callback/  # повернення на збережений дозволений origin
scripts/lib/release/bindings.mjs          # previewSiteOrigin, previewBranch
scripts/lib/release-channel/state.mjs     # каталог стану, читання/запис, lock
scripts/lib/release-channel/operations.mjs# publish-record, promote, rollback, cancel, adopt, status
scripts/release-channel.mjs               # CLI
scripts/deploy-web.mjs                    # --channel=next (default) | production (лише з promote/rollback)
scripts/rollback-web.mjs                  # делегує release-channel rollback
scripts/verify-live-smoke.mjs             # --channel=next
scripts/lib/release/step-adapter.mjs      # live_verify проти next
scripts/check-migrations-additive.mjs     # гейт CI
scripts/verify-all.mjs                    # реєстрація гейта
docs/RELEASE-CHANNEL.md                   # для власника, простою мовою
docs/PRODUCTION.md, AGENTS.md             # оновлений порядок
tests/release-channel-*.test.ts, tests/check-migrations-additive.test.ts, tests/site-channel.test.ts, …
```

**Structure Decision**: нового пакета немає. Механіка каналу — модуль у
`scripts/lib/release-channel/` поруч із наявними `web-rollback.mjs` і `web-only-lock.mjs`,
з якими він ділить lock і архів.

## Complexity Tracking

| Відхилення | Навіщо | Чому простіше не годиться |
|---|---|---|
| Каталог стану поза репозиторієм | Раннер деплоїть із тимчасових воркдерев; історія в кожному з них розпорошена, тому `rollback:web` ніколи не мав попередньої версії під рукою | Тримати стан у `release/automation` конкретної копії означає, що promote з іншої копії не бачить кандидата |
| Друга адреса в агенті й функціях | Тестова версія мусить працювати з прод-бекендом і прод-агентом | Окремий бекенд для тесту не перевіряє реліз на справжніх даних, а саме цього хоче власник |
