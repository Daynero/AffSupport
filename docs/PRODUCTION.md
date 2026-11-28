# Soty production checklist

## Перед першим публічним запуском

- [ ] SQL migrations застосовані в порядку з `supabase/migrations/`.
- [ ] RLS увімкнений для `profiles`, `admin_users` і `analytics_events`.
- [ ] Supabase Site URL — `https://soty.pp.ua`.
- [ ] Supabase redirect allowlist містить `https://soty.pp.ua/auth/callback`.
- [ ] Google Authorized JavaScript origins містить `https://soty.pp.ua`.
- [ ] Google Authorized redirect URI точно збігається із Supabase provider callback `https://PROJECT_REF.supabase.co/auth/v1/callback`.
- [ ] Google Data Access містить тільки `openid`, email і basic profile.
- [ ] Google consent-screen назва — **Soty** — збігається з homepage, Privacy Policy і Terms of Use.
- [ ] `soty.pp.ua` підтверджено в Google Search Console тим самим Google-акаунтом, який є Owner або Editor відповідного Cloud project.
- [ ] Виконано checklist із `docs/GOOGLE_OAUTH_VERIFICATION.md`; Drive scopes не додані до identity-only production project.
- [ ] `VITE_PRODUCT_OPERATOR` і `VITE_LEGAL_CONTACT_EMAIL` заповнені реальними значеннями.
- [ ] Власник перевірив Privacy Policy і Terms of Use; це базові тексти, а не юридична консультація.
- [ ] Edge Function `delete-account` розгорнута; `npm run verify:production-config` підтверджує, що вона ACTIVE на production-проєкті.
- [ ] Перший admin доданий UUID-командою з `SUPABASE_SETUP.md`.
- [ ] Реальні credentials відсутні в Git.

## Before you release: beta verification

For the pending Drive-pool re-stitch download fix, also complete
[the re-stitch release handoff](RESTITCH_RELEASE_HANDOFF.md): it requires a new
agent and web release, plus the recorded verification blockers and smoke checks.

Every production package and web deploy now runs `scripts/verify-beta-promotion.mjs`, which refuses
the release unless the commit is contained in the `beta` branch **and** a packaged-beta verification
record exists for that exact revision. Run `npm run beta:package && npm run beta:verify` on the beta
line first. Full workflow in [BETA.md](./BETA.md).

## Web-only mini release (043 MVP)

Use `npm run release:web -- --check` for read-only eligibility, `npm run
beta:verify:web` to verify a new web candidate without rebuilding the sealed beta
agent, and explicit `npm run release:web -- --deploy` to publish it. The new path
keeps production activation, beta containment, web environment/team gates,
`verify-release --mode=final`, signature and published artifact checks. It adds a
fresh exact-input web proof; normal full packaging/promotion is unchanged.

Only committed clean web/static changes qualify by default. Agent/shared/config/lockfile,
function and unknown changes refuse before mutation; DB changes require the explicit
additive DB phase below. A historical actual
package payload seal is required, matched by full beta verification and a fresh
hash/signature check; an old release.json-only record is insufficient. Prepare a
sealed beta once using the canonical BETA workflow if missing. Mini verification
builds only the beta and production web configurations, authenticates for real,
uses enforced entitlement and confirms a completed packaged operation in the new
UI. The full verification record is never rewritten to label old code as new.

The verified production bundle is archived before upload and only those bytes are
published. Live smoke and sequential byte readback must pass before completion.
`npm run release:web -- --report` reads the local outcome; `published_unverified`
or `unknown` is not success. Inspect external state before retrying a lost upload.
Recovery uses archived exact bytes only when binding and local/archive/live signed
channel match, then appends a new history receipt. It cannot restore an older agent
channel or remove data. There is no automatic rollback.

The MVP assumes trusted local source/operator and retains shared writer state
across worktrees; the additive DB phase uses an isolated local rehearsal, while
broader server automation remains deferred. New heavy boundaries check disk/memory/load, use nice 15,
one test worker and bounded heap/native pools. Production action still requires
explicit authorization and current governance/activation evidence. This source
change itself is not ratification or a production GO.

### Additive DB mini phase (043)

For an agent-compatible web change, the explicit DB path supports only nullable
builtin columns without defaults/constraints and plain nonunique btree indexes
over safe builtin scalar columns of ordinary `public` tables. Functions, RLS,
data writes, table creation, destructive SQL, custom types/collations/opclasses,
partition/inheritance and unknown hooks/ledger write effects block. PostgreSQL
17+ is required for the server-enforced whole-transaction deadline. Installers,
agent versions, published assets and the signed update channel stay unchanged.

Configure a dedicated release connection as `SOTY_MINI_DATABASE_URL` through local
secret configuration. It must match the active production binding. Never use the
analytics connection, put credentials in command arguments, or save them in plans
or reports. Existing G0, beta containment and production activation gates apply.

```bash
npm run release:web -- --plan-db
npm run beta:verify:web -- --backend-plan="/absolute/path/from-plan.json"
npm run release:web -- --deploy --backend-plan="/absolute/path/from-plan.json"
npm run release:web -- --report
```

Use the same exact draft path printed by `--plan-db` for verification and deploy.
Planning is read-only against production. Verification uses pinned Supabase CLI
2.117 and an owned one-CPU/512-MiB local disposable PostgreSQL container, copying
schema/role definitions only, without application rows/passwords. It proves the
exact target baseline, official CLI A equals mini A, source-bound official ledger
tuples, and successful next full CLI B. Real beta must already have the exact
planned after-schema, followed by real browser/unchanged packaged-agent acceptance.
The mini command never resets the running beta stack or rebuilds an installer.

The proof binds source/target, exact before/after catalog and migration history,
rehearsal, beta schema, unchanged package and both web bundles. Drift, unsupported
shape or missing real evidence blocks. After authorization and final revalidation,
all approved DDL and official history inserts commit in one bounded transaction;
independent readback confirms commit before the verified web snapshot uploads.
If web publication later fails, the compatible additive schema remains committed.

Until the next full agent release absorbs that baseline, later pure web hotfixes
still use `--plan-db` and the same new draft for verify/deploy. The unchanged agent
tag still predates those migration paths. Zero pending migrations are valid:
adopt the exact already-applied state read-only, without an empty apply or replay.

An unknown DB outcome blocks all web/backend writers across worktrees. Inspect
bounded private reports and plan/session evidence, then run only:

```bash
npm run release:web -- --reconcile-db
```

Reconciliation is read-only and clears uncertainty only after exact committed or
aborted evidence. Missing/changed state or an active owner needs manual inspection.
Never delete the marker, replay uncertain SQL, run a down migration or automate
rollback. Web upload uncertainty uses separate `--reconcile`. A web rollback
restores web bytes only and must remain compatible with the additive schema.

Release diagnosis uses bounded local CLI outcomes/fingerprints; central analytics
does not observe DB commit. Record manual critical beta feature checks and missing
signals explicitly. Implementation is not acceptance evidence or deployment GO.

### Owner-approved Workspace 1.3.0 cutover

For 1.3.0 the owner explicitly requires all Workspace users to use 1.3.0 or newer
and excludes older Workspace clients from compatibility. The exact approval is
recorded in `config/workspace-cutover.json`: only migration
`20261207093000_accounts_destructive_delete.sql`, its SHA-256 and the two named
internal deletion triggers are accepted. Permanent deletion includes financial
history, as confirmed by the current UI. No waitlist announcement email is sent.

The backend plan honestly records `compatibleWithPrevious: false` and carries the
acceptance identity. Planning, plan validation and pre-apply checks revalidate the
tracked approval against the current release and SQL bytes. Any version, target,
SQL or finding drift revokes it. This does not exempt other migrations, beta
rehearsal, source provenance, publication or activation gates. Later releases must
not reuse this acceptance.

## Production build environment

Project: `wishly-app`. Canonical production origin: `https://soty.pp.ua`.

Повний перелік змінних усіх трьох поверхонь — браузерного bundle, Edge Functions
і запакованого агента — живе в `config/environments.json`. Ця таблиця більше не
дублюється в документах: копія прози застаріває мовчки, а реєстр перевіряється
двома гейтами на кожному push. Таблиця вище була саме такою копією і містила
`VITE_DELETE_ACCOUNT_ENABLED`, якої в коді немає вже давно.

Реєстр каже для кожної змінної: на якій поверхні живе, у яких середовищах
обов'язкова, чи секретна, якого формату і що ламається без неї. Значень він не
містить — тільки імена й форму.

```bash
npm run verify:env-registry      # код і реєстр описують той самий набір (офлайн)
npm run verify:production-config # живий проєкт має те, що реєстр вимагає (онлайн)
```

Перший гейт входить у `npm run verify` і в CI. Другий потребує доступу до
production-проєкту, тому виконується у preflight релізного раннера — він читає
Supabase secrets, список задеплоєних Edge Functions, застосовані міграції та
auth-конфігурацію (Site URL, redirect allowlist, Google provider) і блокує реліз
до будь-якої важкої роботи. Значень секретів він не читає: звіряються тільки
імена.

Не додавайте на frontend-хостинг Google Client Secret, Supabase secret/service role key або JWT. Не друкуйте значення environment variables у build logs.

Cloudflare project використовує **Direct Upload**: Cloudflare отримує вже готову папку `dist`, тому Dashboard variables не можуть змінити Vite bundle після build. Для поточного workflow створіть у корені незакомічений `.env.production` зі значеннями для змінних, які реєстр позначає обов'язковими для `production`, або передайте ці самі змінні в CI, де запускається build. `.env.production` уже ігнорується Git.

`git push` сам по собі не оновлює сайт. Чинна release-процедура спочатку відхиляє відсутні variables, localhost origin і privileged Supabase key, а потім перевіряє незмінний Agent artifact:

```bash
npm run deploy:web
```

Команду запускайте тільки після зеленої `npm run verify:release`, чистого commit і доступного versioned Agent release. Скрипт сам відмовиться деплоїти невідповідний release.

### Одна команда замість переліку

```bash
npm run verify           # швидка форма: статика + набір тестів
npm run verify:release   # повна: додає збірки, контракти релізу і тести бази
```

Обидві форми — це один і той самий код і один і той самий формат результату;
`--form` лише обирає перелік гейтів. Успіх друкує щонайбільше двадцять рядків,
провал — сто, з назвою гейта і його ж власним текстом помилки в перших рядках.
Повний результат завжди пишеться в `verification-result.json` (gitignored),
тому нічого не втрачається — його просто не завжди читають.

Після `build:web` форма release окремо перевіряє gzip-бюджети свіжого bundle.
Це обов'язково навіть тоді, коли unit suite вже виміряв попередній `dist` або
позначив тест як пропущений через відсутність зібраних assets.

Перелік гейтів більше не тримають у голові й не переписують по документах: він
живе в `scripts/verify-all.mjs`, і тест стежить, щоб кожен ідентифікатор гейта
належав рівно одній формі.

### Обов'язкові перевірки гілки

Ці чотири джоби з `.github/workflows/verify.yml` мають бути **required checks**
для гілки `main`:

- `static`
- `test-macos`
- `test-windows`
- `build`

Джоба `e2e` навмисно не обов'язкова: вона потребує повної збірки й справжніх
бінарників, а її падіння рідко стосується конкретної зміни. Вона йде на push у
`main` і на pull request з міткою `e2e`.

Налаштування живе в Settings → Branches → Branch protection rules, а не у файлі
репозиторію — тому воно записане тут. Якщо перейменувати джобу у workflow, її
треба перейменувати і в правилі: інакше захист мовчки перестане діяти, бо
required check із неіснуючою назвою не блокує нічого.

Поки командний простір і Google Drive ще не готові, для публікації лише homepage та Google Login
використовуйте `npm run deploy:web:identity`. Вона не декларує готовність Drive; повний
`npm run deploy:web` як і раніше вимагає verified Drive integration.

## Встановлення релізного раннера

Раннер залежить від двох речей, яких він не може зібрати сам, і доки їх немає,
preflight відмовляє — правильно й назавжди:

```bash
npm run release:install
```

Це збирає **пробник ресурсів** із `packaging/release/ResourceProbe.swift` (його
власний коментар завжди казав «built once by the runner installer» — інсталятора
не було) і реєструє **міст ремонту**. Обидва лежать у `release/automation/`, яка
ігнорується: пробник — нативний бінарник однієї архітектури, конфіг моста
називає абсолютний шлях однієї машини. Перед релізом підхопіть змінні:

```bash
set -a; . release/automation/release-runner.env; set +a
```

Міст — це durable-інбокс: збій о третій ночі лягає одним JSON-записом, який
чекає, дивиться на нього хтось чи ні, а відповідь людини повертається раннеру
тим самим протоколом.

```bash
npm run release:bridge -- --list
npm run release:bridge -- --show <jobId>
npm run release:bridge -- --complete <jobId> --status repaired --notes "..."
```

`--status repaired` — твердження про вихідний код, не про гейти: раннер
перезапускає власні перевірки незалежно від того, що там написано.

## Серверні зміни релізу

Міграції й Edge Functions більше не переносяться руками з `SUPABASE_SETUP.md`.
План виводиться з двох фактів, яких ніхто не мусить пам'ятати: чого бракує у
віддаленій історії міграцій і що змінилося в git від попереднього тега релізу.

```bash
npm run release:backend-plan                 # показати план
npm run release:backend-plan -- --out=plan.json
```

Раннер отримує цей файл через `SOTY_RELEASE_BACKEND_PLAN` і виконує його на
кроках `backend_beta` (репетиція) та `backend_apply` (після публікації
артефактів, перед web deploy). Нічого поза планом не застосовується: якщо
віддалений набір pending не збігається з планом точно, реліз зупиняється — так
міграція з чужої гілки не поїде «заодно».

`db push --include-all --yes --skip-vault` застосовує саме перевірений pending-набір,
зокрема пропуски перед пізнішими remote-номерами. Команда виконується один раз на
спробу; одна свіжа історія після неї підтверджує кожну міграцію. Повторна спроба
завжди читає історію заново. Структурована помилка CLI зі stdout потрапляє в
журнал без стороннього виводу та секретів.
CLI виконується асинхронно, тому довга серверна команда не зупиняє оновлення
статусу панелі.

For a server-only change, use `npm run release:backend-plan -- --since=<deployed-sha>
--out=<plan>` followed by `npm run release:backend-apply -- --plan=<plan>` for inspection,
then the same command with `--confirm`. This is the runner's backend adapter with identical
digest, pending-migration, compatibility and receipt checks; it does not rebuild clients or
replace release artifacts. Run the relevant tests and `npm run verify` before applying.
Provider configuration changes still require explicit operator acceptance. The unverified
Drive pilot accepted on 2026-09-30 is documented in `TEAM_WORKSPACE_OPERATIONS.md`.

Дві речі, які план ловить, а людина пропускає:

- **Зміна в `_shared`** — це зміна кожної функції, яка його імпортує, хоча
  жоден файл тих функцій не чіпали. Зараз саме такий випадок: після `v1.1.0`
  змінився `_shared/cors.ts`, тому в план входять усі десять функцій, а не лише
  `catalog-sync`, чиї файли видно в диффі.
- **Міграція, яку не переживе вже випущений клієнт.** Схема їде перед новим
  вебом і задовго до того, як десктоп оновиться, тож `drop column`, перейменування
  чи `set not null` на існуючій колонці ламають користувачів тихо. План
  відмовляється будуватися і цитує сам стейтмент. Зі 112 наявних міграцій
  перевірка позначає три — це реально деструктивні, решта проходить без шуму
  (зокрема `drop function ... create function` — стандартне перевизначення — і
  `alter publication ... drop table`, яке таблицю не чіпає).

`SUPABASE_SETUP.md` лишається довідником про те, що означає кожен секрет і як
підняти проєкт з нуля; він більше не є процедурою релізу.

## Тестове посилання, розкатка й відкат (051) — читати першим

Реліз більше не закінчується на проді. Крок `deploy` раннера і
`release:web -- --deploy` кладуть бандл на **https://next.soty.pp.ua**. Крок
`live_verify` перевіряє next проти маніфесту релізу, а основний сайт перевіряє
як «досі працює на мігрованій базі». Далі:

```bash
npm run release:channel -- status
npm run release:channel -- promote            # перевіряє живий next, нічого не пише
npm run release:channel -- promote --confirm  # лише за командою власника
npm run release:channel -- rollback --confirm # попередня розкочена збірка, разом з агентом
npm run release:channel -- cancel --confirm   # next знову показує прод
```

Promote і rollback не перезбирають нічого. Вони завантажують заархівовані
байти, читають живий сайт без кешу (`index.html` і `stable.json`) і лише
тоді записують стан. Невизначений результат (`CHANNEL_LIVE_MISMATCH`)
перевіряється через `status`, а не повтором навмання. Перед першою
розкаткою один раз виконайте `release:channel -- adopt-live --confirm`, щоб
у відкату була ціль. Повний опис: `docs/RELEASE-CHANNEL.md`.

## Реліз раннером, з нуля (читати першим)

Це послідовність, якою 1.1.1 реально вийшов. Фази нижче по файлу лишаються
описом того, ЩО відбувається всередині кроків, і ручним запасним варіантом.

### 0. Раннер має бути встановлений

```bash
npm run release:install
set -a; . release/automation/release-runner.env; set +a
```

Записує п'ять речей, яких раннер не може зібрати сам і без яких відмовляє ще на
preflight: зонд ресурсів (збирається зі Swift-джерела й одразу запускається на
перевірку), міст ремонту, абсолютний шлях до `gh`, сім перевірених файлів
збірки з `release/inputs-<версія>/` і запакований рантайм для бети. Якщо чогось
бракує — команда падає тут, а не через сорок хвилин посеред релізу.

### 1. Коміт «release: prepare X.Y.Z»

**Версія заморожена в джерелі. Раннер її не підіймає.** Реліз починається з
коміту, який каже, який це реліз; без нього `package:mac` відмовить з
«v<попередня> already exists». Що змінюється (взірець — `git show v1.1.0`):

- `packages/shared/src/release.ts` — `PRODUCT_VERSION`, `BUNDLE_VERSION`,
  `BUILD_NUMBER` (+1);
- `package.json`, `apps/agent/package.json`, `apps/web/package.json`,
  `packages/shared/package.json` — поле `version`, і пін
  `"@video-compressor/shared"` у двох застосунках;
- `package-lock.json` — ті самі версії;
- `apps/web/public/.well-known/wishly/stable.json` — версія, `buildNumber`,
  `buildId`, `publishedAt`, URL артефактів на новий тег, **`sha256` нулями**
  (справжні відбитки запише крок `manifest`), короткий `summary` двома мовами;
- `RELEASE_NOTES.md` — розділ нової версії зверху: його вміст стає тілом релізу
  на GitHub.

Далі `npm run build -w @video-compressor/shared`,
`node scripts/sign-release-manifest.mjs`, і перевірка
`node scripts/verify-release.mjs --mode=contract` має пройти.

### 2. Звідки різати

Якщо реліз — це вершина `main`, ріжте з неї. Якщо в `main` уже є робота, яка в
реліз не йде (паралельна гілка встигла злитись), зробіть гілку `release/X.Y.Z`
від потрібного коміту, покладіть коміт із кроку 1 на неї і поставте `beta` на
той самий коміт. Раннер вимагає, щоб реліз містився в `beta`, і саме `beta` він
просуває далі.

### 3. Намір і запуск

`release/automation/release-intent.json` — `runId` (новий UUID), `sourceSha`,
`version`. **Новий `sourceSha` — новий `runId`.** Той самий `runId` означає
«продовжити», а не «почати наново».

```bash
export SOTY_RELEASE_BACKEND_PLAN=release/automation/backend-plan.json   # якщо є серверні зміни
npm run release -- preflight --intent release/automation/release-intent.json \
  --bindings release/automation/release-bindings.json
npm run release -- start --intent release/automation/release-intent.json
```

`start` віддає роботу відчепленому воркеру й повертається. Стежити — за
журналом, не за терміналом:

```bash
tail -f release/automation/<runId>/journal.ndjson
npm run release -- status <runId>
```

`npm run release:panel:build`, потім `npm run release:panel:watch -- <runId>`
відкривають можливість стежити через локальну панель: перейдіть за надрукованим
одноразовим посиланням протягом хвилини. Поточний етап, підтверджений прогрес і
наступний крок видно відразу; повний перелік і технічні деталі згорнуті.
Панель не запускає реліз і не підтверджує проходження перевірок сама.

Тестовий прогін використовує один worker і за замовчуванням обмежує Node heap
до 2 ГБ на процес; явний `NODE_OPTIONS` зберігається. Тести governor з вигаданими
PID використовують `tests/support/power-governor.ts`: він ізолює читання дерева
процесів і всі сигнали нащадкам від реальної системи та прибирає таймери після тесту.

Опис GitHub Release береться лише з розділу `# v<version>` у `RELEASE_NOTES.md`;
історичні розділи залишаються в репозиторії. Репетиція серверних змін читає
локальну історію міграцій один раз на спробу й перевіряє кожну заплановану
зміну; наступна спроба завжди читає історію заново.

### 4. Коли крок упав

Полагодьте причину і **запустіть `start` з тим самим наміром**. Воркер прочитає
журнал, пропустить зроблене і візьме назад ту саму робочу копію — зібрані dmg і
zip переживають перезапуск, Windows-збірка, яка вже йде, підхоплюється замість
запуску другої. Нічого не перезбирається.

Очікування Windows у кроках `windows_smoke` і `publish` має той самий
бюджет 210 хвилин, що й GitHub watcher, із хвилиною на завершення. Він покриває
60 хвилин перевірки CI, 120 хвилин Windows-збірки й 30 хвилин очікування runner.
Локальний
30-хвилинний ліміт завантаження не обриває віддалену збірку; після перезапуску
раннер підхоплює той самий run.

Код кроків раннер бере з **цієї** робочої копії, а не з коміту релізу. Тому
виправлення самого раннера діють одразу після перезапуску, без нового
`sourceSha`. Виправлення того, що перевіряє CI (тести, воркфлоу), — навпаки:
вони мають бути в коміті, який випускається, бо Linux-ворота викладають саме
його.

Перевірка готового beta-пакета також використовує скрипти поточного раннера,
але читає пакет і локальні ключі та записує exact-SHA доказ у робочій копії
кандидата. Це дозволяє виправити застарілий перевірочний запит без повторного
пакування. Запит entitlement передає ревізію з health; помилка проходить через
прибирання власного тестового процесу. Приватні env-файли в робочій копії —
окремі копії з правами 0600, а не посилання за її межі.

### 5. Що реліз рухає

|                |                                                                         |
| -------------- | ----------------------------------------------------------------------- |
| тег `vX.Y.Z`   | коміт, з якого зібрані інсталятори                                      |
| `beta`         | на крок далі: коміт `release: record X.Y.Z artifact digests`            |
| GitHub release | dmg із локальної збірки, exe з CI                                       |
| прод           | міграції й функції з `backend-plan.json`, кожна з квитанцією до і після |
| Cloudflare     | зібраний бандл + той самий підписаний `stable.json`                     |

Після релізу в `main` зливається **`beta`**, а не `release/X.Y.Z`: інакше в
репозиторій потраплять нульові відбитки замість справжніх.

### Чого не буде в репозиторії

`VITE_GOOGLE_PICKER_API_KEY` і `VITE_GOOGLE_PROJECT_NUMBER` — змінні репозиторію
на GitHub (Settings → Secrets and variables → Actions → Variables). Не секрети:
обидва компілюються у видимий бандл. Але репозиторій публічний, а ключ Google у
публічному репозиторії збирають сканери. Без них Windows-збірка зупиняється з
названою причиною.

### Гострі краї, які ще не зняті

- Зонд, який перестав відповідати зовсім (усі сигнали `null`), не рахується як
  збій вибірки — очікування може не скінчитись. Ознака: `resource_wait` з
  `RESOURCE_SIGNAL_UNKNOWN`, що повторюється довше за хвилину.
- `gh workflow run --ref main` бере опис воркфлоу з `main`, а не з коміту
  релізу: правки воркфлоу мають потрапити в `main` до запуску.
- `npm run rollback:web` тепер делегує `release:channel -- rollback` (051).

## Реліз на дві платформи

### Canonical agent runbook

The deterministic runner is invoked as `npm run release -- <command>`. It
persists accepted work and reports `queued`, `reconciling`, `blocked` or
`completed`; accepted never means completed. Its read-only preflight rejects
invalid bindings or unavailable probe/bridge dependencies before heavy work.
It has no model dependency for normal flow. Do not use it for production until
G0 ratification and real sandbox acceptance evidence exist; neither has a
bypass flag.

Установка раннера (один раз на машину, не під час релізу) — `npm run
release:install`, див. розділ вище. Історично це робилось так:

```bash
node scripts/package-release-runner.mjs --build "$PWD/release/automation/probe"
```

Це збирає закріплений `arm64-apple-macos13` зонд ресурсів і записує
`ResourceProbe.provenance.json` з digest виконуваного файлу та джерела. Реліз
ніколи не компілює зонд: відсутній або невідповідний зонд — це
`PROBE_UNAVAILABLE`, і жоден важкий крок не стартує. Шлях і digest передаються
раннеру через `SOTY_RELEASE_PROBE` та `SOTY_RELEASE_PROBE_DIGEST`.

Під раннером важкі межі проходять допуск: гейти `verify-all`, пакування
(`package-mac.sh`, `package-beta-mac.sh`, `package-dmg.sh`) і кроки реєстру
чекають на єдиний слот через `scripts/release-admit.mjs`. Поза раннером
(`SOTY_RELEASE_ADMIT_SOCKET` не задано) поведінка цих команд не змінюється.

Один прохід виглядає так:

```bash
node scripts/release-runner.mjs preflight --intent <intent.json> --bindings <bindings.json>
node scripts/release-runner.mjs start --intent <intent.json>
node scripts/release-runner.mjs status <run-id>     # де воно зараз
node scripts/release-runner.mjs resume <run-id>     # після перерви або поломки
node scripts/release-runner.mjs report <run-id>     # що вийшло
```

`start` віддає роботу супервізованому воркеру й повертається; реліз переживає
закритий термінал. Воркер проходить пʼятнадцять кроків реєстру, які виконують
рівно ті команди, що наведені у фазах нижче, через
`scripts/lib/release/step-adapter.mjs`. Кожен важкий крок спершу чекає на
ресурсний допуск, кожен запис у журнал робиться ДО ефекту, тож перерване
виконання продовжується з того місця, де спинилось, і жоден ефект не
повторюється. `SOTY_RELEASE_DRY_RUN=1` проганяє послідовність, не торкаючись
нічого поза цією машиною.

Фази нижче лишаються канонічним описом того, ЩО відбувається, і ручним
запасним варіантом. Не виконуйте їх паралельно з раннером.

Валідація релізу розділена за фазами (конституція 2.0.0):
`node scripts/verify-release.mjs --mode=contract|candidate|final`. `contract` —
лише внутрішня узгодженість (це те, що виконує агрегатор на PR); `candidate` —
чисте дерево і ще не існуючий тег; `final` — тег на origin вказує на релізний
комміт, а пізніший web-комміт допускається лише як manifest-only нащадок.
Типовий режим — `final`, невідомий режим падає до будь-якої роботи. Прапорці
`--package`/`--deploy` лишаються синонімами candidate/final.

Це єдина дозволена production-процедура. Один `<release-sha>` породжує обидва
бінарні артефакти; пізніший `<manifest-sha>` лише підписує їх і деплоїть web.
Не перебудовуйте артефакти після manifest-only commit.

Перед початком задайте `<version>` без `v` (наприклад, `1.0.3`) і не змінюйте її
посеред релізу. Важкі локальні команди запускайте послідовно через `nice -n 15`.

На машині з обмеженими ресурсами додайте `SOTY_VERIFY_SERIAL=1` до середовища
перед `npm run verify:release`. Це виконує всі ті самі гейти по одному, з тим
самим форматом результату, без одночасних компіляторів. `nice` задає пріоритет,
але не обмежує CPU; перевіряйте навантаження та памʼять між важкими кроками.

#### Phase 1 — freeze and exact-SHA beta gate

1. Змініть версію тільки в `packages/shared/src/release.ts`, виконайте штатні
   перевірки, закомітьте всі заплановані зміни та push у `main`.
2. Зафіксуйте SHA: `release_sha=$(git rev-parse HEAD)`. Робоче дерево має бути
   чистим.
3. Синхронізуйте beta з цим самим SHA:

   ```bash
   git push origin main:beta
   git fetch origin beta
   git branch -f beta origin/beta
   ```

4. Створіть promotion record саме для `<release-sha>`:

   ```bash
   nice -n 15 npm run beta:package
   nice -n 15 npm run beta:verify
   nice -n 15 npm run release:check
   ```

`release:check` навмисно відновлює production bundle після beta packaging, щоб
release-gate перевірив саме production output, а не beta bundle. Якщо HEAD змінився після цього кроку, gate застарів: синхронізуйте `beta` і
повторіть `beta:package` та `beta:verify`. Не копіюйте старий promotion record.

#### Phase 2 — build immutable artifacts

Завантажте production environment без виведення секретів:

```bash
set -a
source apps/web/.env.production
source config/production.env
set +a
```

`package:mac` також вимагає схвалені portable inputs у `NODE_BINARY`,
`FFMPEG_BINARY`, `FFPROBE_BINARY`, `FFMPEG_SOURCE_ARCHIVE`,
`X264_SOURCE_ARCHIVE`, `WHISPER_BINARY` і `WHISPER_VAD_MODEL`. Використовуйте
лише вже перевірені файли поза майбутнім `release/Soty.app`: пакувальник видаляє
цю директорію на старті. Не завантажуйте випадкові заміни і не генеруйте ключі.

```bash
nice -n 15 npm run package:mac
nice -n 15 npm run package:dmg
# Supply independently verified Intel inputs / target-specific browser, then:
nice -n 15 npm run package:mac -- --arch=x64
nice -n 15 npm run package:dmg -- --arch=x64
(cd release && shasum -a 256 -c Soty-v<version>-macOS-arm64.zip.sha256)
(cd release && shasum -a 256 -c Soty-v<version>-macOS-arm64.dmg.sha256)
(cd release/x64 && shasum -a 256 -c Soty-v<version>-macOS-x64.dmg.sha256)
node scripts/verify-macos-release-trust.mjs release/Soty-v<version>-macOS-arm64.dmg
node scripts/verify-macos-release-trust.mjs release/x64/Soty-v<version>-macOS-x64.dmg --arch=x64
```

Windows спершу проходить build-only gate. Команда `gh workflow run` повертає не
run id, тому знайдіть щойно створений run через `gh run list`, а потім стежте за
ним компактним watcher'ом:

```bash
gh workflow run release-windows.yml --ref main -f publish=false
gh run list --workflow release-windows.yml --branch main --limit 3
npm run release:watch -- <run-id>
```

Не створюйте tag, доки цей run не завершився успішно. Не використовуйте
`gh run watch`: він повторює великий лог і марнує контекст.

#### Phase 3 — publish the same artifacts

Створіть GitHub Release на `<release-sha>` і прикріпіть DMG:

```bash
gh release create v<version> release/Soty-v<version>-macOS-arm64.dmg \
  release/x64/Soty-v<version>-macOS-x64.dmg \
  --target <release-sha> --title "Soty <version>" --notes-file RELEASE_NOTES.md
gh release view v<version> --json isDraft,assets,targetCommitish,url
```

Дочекайтеся `isDraft: false` і завершеного upload. Далі publish workflow є
єдиним дозволеним джерелом Windows installer:

```bash
gh workflow run release-windows.yml --ref main -f publish=true
gh run list --workflow release-windows.yml --branch main --limit 3
npm run release:watch -- <run-id>
```

Не завантажуйте `.exe` вручну. Publish-run повторно збирає і smoke-тестує пакет,
тому для manifest треба скачати саме опубліковані bytes, а не artifact з
build-only run:

```bash
mkdir -p release/windows/download-<version>
gh release download v<version> --pattern 'Soty-v<version>-Windows-x64.exe' \
  --dir release/windows/download-<version>
```

#### Phase 4 — sign, commit, deploy

Приватний ключ release manifest залишається тільки на maintainer Mac:

```bash
node scripts/sign-release-manifest.mjs \
  --dmg release/Soty-v<version>-macOS-arm64.dmg --platform macos-arm64
node scripts/sign-release-manifest.mjs \
  --dmg release/x64/Soty-v<version>-macOS-x64.dmg --platform macos-x64
node scripts/sign-release-manifest.mjs \
  --dmg release/windows/download-<version>/Soty-v<version>-Windows-x64.exe \
  --platform windows-x64
node scripts/verify-release.mjs
node scripts/verify-published-release.mjs
```

Закомітьте тільки підписаний manifest і push у `main` та `beta`. Це створює
`<manifest-sha>`, тому перед deploy обов'язково повторіть exact-SHA beta gate,
але **не** перебудовуйте вже опубліковані production artifacts:

```bash
git push origin main
git push origin main:beta
nice -n 15 npm run beta:package
nice -n 15 npm run beta:verify
git fetch origin tag v<version>
git rev-list -n 1 v<version> # має дорівнювати <release-sha>
nice -n 15 npm run deploy:web
```

Завершення означає одночасно: release не draft; DMG і EXE мають стан uploaded;
tag вказує на `<release-sha>`; `main` і `beta` вказують на `<manifest-sha>`;
live `https://soty.pp.ua/.well-known/wishly/stable.json` містить нову версію та
обидва опубліковані digest; робоче дерево чисте.

#### Keys and failure policy

Production entitlement private key навмисно відсутній у CI та може бути
відсутній локально. Не створюйте і не замінюйте його заради `verify:dmg`.
Windows workflow smoke-тестує installer з ephemeral isolated key, а після smoke
перебудовує фінальний host/installer з tracked production public key. Якщо
будь-який gate падає, виправте pipeline і повторіть лише фазу від першого
невдалого gate; не рухайте tag, не підміняйте asset і не запускайте збірку через
проблему моніторингу.

Які платформи є обовʼязковими, визначає `REQUIRED_RELEASE_PLATFORMS` у
`packages/shared/src/release.ts`. Зараз там лише `macos-arm64`. Додавання
`'windows-x64'` робить Windows блокуючим: без валідного Windows-артефакта не
виїде і macOS. Перемикати це треба **останнім кроком** розкатки, коли пайплайн
стабільно віддає інсталятор. Деталі — `docs/WINDOWS.md`.

## SPA routing

`apps/web/public/_redirects` містить:

```text
/* /index.html 200
```

Тому прямі production-переходи на `/compressor`, `/account`, `/admin`, `/privacy`, `/terms` і `/auth/callback` повертають SPA shell, а router обробляє маршрут у браузері.

## Preview deployment

Preview повинен мати власний стабільний origin:

1. задайте preview origin у `VITE_SITE_URL`;
2. додайте точний `<preview-origin>/auth/callback` у Supabase Redirect URLs;
3. додайте `<preview-origin>` у Google Authorized JavaScript origins;
4. не вмикайте delete-account, доки origin не доданий у CORS secret функції;
5. перевірте login, callback, refresh session і прямий `/compressor`.

Якщо preview URL змінюється для кожного commit, використовуйте окремий стабільний preview alias. Не відкривайте широкі production wildcard redirects лише заради випадкових preview URL.

## Smoke test після deployment

Автоматична частина виконується сама і входить у крок `live_verify` релізного
раннера — після `verify-published-release.mjs`, тобто реліз не вважається
завершеним, доки живий сайт не відповів правильно:

```bash
npm run verify:live-smoke
```

Вісім перевірок проти `https://soty.pp.ua` приблизно за три секунди: оболонка
віддається і містить кореневий елемент; зібраний bundle, на який вона посилається,
справді завантажується, і конфігурація в ньому вказує на production-проєкт
Supabase непривілейованим ключем; глибоке посилання `/compressor` не перетворилось на 404;
`stable.json`, який опитує кожен встановлений застосунок, — це саме той маніфест,
який підписав цей реліз, і його підпис валідний; Supabase auth відповідає;
Google-провайдер увімкнений; рукостискання OAuth веде на `accounts.google.com`
з client_id; задеплоєні Edge Functions відповідають.

Та сама перевірка повторюється кожні 10 хвилин у
`.github/workflows/production-heartbeat.yml` — з GitHub-раннера, який не ділить
із продом ні машину, ні мережу, ні базу, тому аварія не може заодно вимкнути
перевірку. Падіння відкриває один issue і дописує в нього коментарі, а не
створює новий щоразу; наступний успішний прогін закриває його сам.

Налаштовувати heartbeat не треба нічим: смоук читає публічний ключ Supabase
із самого бандла, який віддає сайт. Це заодно сильніша перевірка, ніж ключ,
заданий збоку, — вона доводить, що працює саме той ключ, який отримують реальні
користувачі, і ловить бандл, зібраний під інший проєкт або з протухлим ключем.

Якщо смоук упав, відкат — одна команда, яка не перезбирає нічого, а повертає
рівно ті байти, які вже віддавались раніше:

```bash
npm run rollback:web             # показати, що саме буде повернуто
npm run rollback:web -- --confirm
```

Автоматичного відкату немає навмисно: конституція проєкту забороняє скасовувати
публікацію без рішення людини, і причина та сама — зелений сайт після
автоматичного відкату ховає причину падіння. Маніфест оновлень їде всередині
bundle, тож відкат повертає і канал оновлень десктопу на попередню версію.

Решта кроків потребує справжнього акаунта і поки лишається ручною:

1. У приватному вікні відкрийте `https://soty.pp.ua/compressor`: має бути redirect на `/login`.
2. Перемкніть UA/EN; маршрут і layout мають залишитися стабільними.
3. Увійдіть через Google і перевірте повернення на `/compressor`.
4. Оновіть сторінку — session має відновитися без миготіння login.
5. Перевірте profile й одну безпечну event у Supabase.
6. Перевірте Agent connected flow. Supabase JWT не повинен зʼявитися в loopback requests.
7. Запустіть коротку compression, тимчасово вимкніть мережу й переконайтеся, що Agent завершує локальну роботу. Analytics може дочитатися з обмеженої черги пізніше.
8. Перевірте account update, consent on/off і logout.
9. Перевірте `/admin` звичайним користувачем і admin-користувачем.
10. Після deploy Edge Function перевірте delete-account окремим тестовим акаунтом.

## Зміна production-домену

Не розкидайте нову адресу по коду. Змініть:

1. `PRODUCTION_SITE_ORIGIN` у `packages/shared/src/release.ts`;
2. `PUBLIC_SITE_ORIGIN` у `config/production.env`;
3. `VITE_SITE_URL` на хостингу;
4. Supabase Site URL і точний redirect URL;
5. Google origin, Branding links та, за потреби, verified domain;
6. `SOTY_SITE_URL` secret Edge Function;
7. Cloudflare custom domain.

Потім запустіть `npm run release:check`.

Web-only публікація з невідомим результатом зберігає спільний для Git worktree запис `release/automation/web-publication-pending.json`. Усі web writers блокуються до read-only `--reconcile`: він перевіряє завершення попередньої групи процесів та точні live-байти замороженого архіву. Невідповідність або відсутня ідентичність процесу потребує ручного розбору; повторний upload та автоматичне видалення запису заборонені. Якщо завершення дочірніх процесів не підтверджене, команда також залишає writer lock для розбору.

## Catalog image R2 rollout (045)

Use the full release workflow above for this shared/DB/functions change; web mini release is
not eligible. [CATALOG_IMAGES.md](CATALOG_IMAGES.md) defines isolated runtime credentials,
public-media consent, staging lifecycle and CDN setup. Apply the additive migrations and
functions with imports disabled, ship clients carrying contract version 2, and only then
authorize rollout after exact-SHA packaged-beta and provider acceptance evidence. Implementation
does not authorize provisioning, billing, production migrations or activation.

`CATALOG_IMAGES_ENABLED` and per-team `import_enabled` pause new import work; they retain reads
and existing issued URLs. The first verified ready pool commit admits v2 under the same mode
lock used by legacy settings and durable intent admission. Accepted legacy work keeps its
persisted version. Do not switch an admitted team back to a Drive-only client or delete ready
objects to roll back. Any temporary selection-off procedure must use compatible readers and
be validated against historical snapshots first. Explicit revocation/team deletion uses durable
purge evidence; an acknowledged managed-CDN purge does not erase third-party downloaded copies.

## Catalog feeds of R2 spaces (057)

A catalog in an R2 space has no Google sheet: its rows are a CSV feed in the public catalog-video
bucket (`soty-catalog-videos-{env}-public`), key `feeds/{feed_id}.csv`, served as
`text/csv; charset=utf-8` at `https://catalog-videos[-beta].soty.pp.ua/feeds/{feed_id}.csv`.
Every update rewrites the same key and purges that one address with `R2_CATALOG_PURGE_TOKEN`
(`supabase/functions/_shared/catalog-feed.ts`). The object carries `Cache-Control: public,
max-age=60`, but the zone forces `cache-control: max-age=14400` on everything it serves
(evidence/meta-feed-from-r2-2026-11-27.md), so a consumer that honours the browser cache could
read a four-hour-old feed.

**Required zone cache rule, per environment, before any R2 space has a catalog:**

- Match: hostname `catalog-videos.soty.pp.ua` (beta: `catalog-videos-beta.soty.pp.ua`) and URI
  path starts with `/feeds/`.
- Edge TTL: respect origin, at most 60 s. Browser TTL: override to 60 s (or «respect origin»).
- Everything else on the host keeps the existing year-long immutable video rule.

The purge is the fast path; the rule is the bound if a purge fails (the write still succeeds and
logs `[catalog-feed] purge failed` with the feed id only). The rule is applied by hand in the
Cloudflare dashboard together with T002/T062 — nothing in this repository configures the zone.
Check after applying: `curl -sI <feed url>` shows `cache-control: ... max-age=60` (or lower),
never `max-age=14400`. Feed bytes count in the space meter under `catalogs`
(`service_record_catalog_feed`). The feed holds exactly what the public sheet held, product links
included (a Launch link may carry `fb_capi_token`, as the sheet's did); its id is random, and no
log line or journal entry carries a row, a link or a token.

## Space bucket and files host (057)

The bytes of an R2 space live in a private bucket `soty-spaces-{env}`. Browsers and agents
upload parts straight to it on presigned URLs, and read through the `space-read` Worker on
`files.soty.pp.ua` for next and production (research.md R3/R4). Beta reads through the
`space-storage` function instead (see «Reads on beta» below). To qualify the real beta bucket, run
`node scripts/space-storage-qualify.mjs --env-file <functions .env>`. It refuses any bucket that
does not end in `-beta`, works only under `qualify/` and empties that prefix when it is done.
The results are in `specs/057-r2-workspaces/evidence/qualification.md`.

**Bucket, as code.** `config/space-storage/r2-cors.json` and `config/space-storage/r2-lifecycle.json`
hold exactly what the bucket carries. They use the Cloudflare API format, which
`wrangler r2 bucket {cors,lifecycle} set --file` also takes. Change the file first, then apply it
as a whole and read it back:

```sh
cd apps/catalog-image-delivery
npx --yes wrangler@4.112.0 r2 bucket cors set soty-spaces-beta --file ../../config/space-storage/r2-cors.json --force
npx --yes wrangler@4.112.0 r2 bucket lifecycle set soty-spaces-beta --file ../../config/space-storage/r2-lifecycle.json --force
npx --yes wrangler@4.112.0 r2 bucket cors list soty-spaces-beta
npx --yes wrangler@4.112.0 r2 bucket lifecycle list soty-spaces-beta
```

- CORS covers the four web origins: `https://next.soty.pp.ua`, `https://soty.pp.ua` and the beta
  web on `localhost`/`127.0.0.1:5173`. It allows `GET`/`HEAD`/`PUT` with `Content-MD5` among the
  allowed headers, and it exposes `ETag`, because the browser reads each part's ETag from the
  PUT response.
- Lifecycle aborts incomplete multipart uploads after 1 day (`abort-incomplete-multipart`). The
  bucket also kept R2's own `Default Multipart Abort Rule` (7 days). That rule is harmless, and it
  stays in the file so the file matches the bucket. There is no rule for staging keys, for two
  reasons: originals upload straight to `t/{team}/o/{content_id}`, so nothing is written under
  `t/*/u/*`, and R2 lifecycle conditions are plain prefixes with no wildcards.
- `soty-spaces-beta` has location hint EEUR and the **default jurisdiction** (not EU). It has no
  `r2.dev` access and no custom domain. The beta S3 token `soty-beta-catalog-videos` (object
  read/write) covers it. That token cannot read the bucket's CORS or lifecycle back
  (`AccessDenied`), so readback goes through `wrangler` or the dashboard.

**Reads on beta (lead decision 2026-11-28).** The local beta stack's Supabase API listens only on
`127.0.0.1:54321`, so a Worker on the internet can never read a space's `access_epoch` there and
every read through `files-beta.soty.pp.ua` would answer 503. Beta therefore reads through
`GET|HEAD <API>/functions/v1/space-storage/files/t/{team}/…?g=<grant>`
(`supabase/functions/space-storage/files.ts`). It is the same handler as the Worker
(`packages/shared/src/team/space-read.ts`): the same grant checks in the same order, Range/206,
HEAD, `Referrer-Policy: no-referrer`, CSP, `Content-Disposition` and `Cache-Control`, the same
30-second epoch cache; it streams from the bucket over S3 and keeps no edge cache. The grant is
never logged. `tests/space-read-local-route.test.ts` holds the two to identical answers.

The route exists only when the function's config says so, and fails closed:
`CATALOG_IMAGES_ENVIRONMENT` must be `beta` or `dev` **and** `SPACE_FILES_ORIGIN` must be the
route itself. Under `production`, a missing environment or the Worker's host it answers 404 like
any unknown path, and `/read-grant` refuses a route-shaped `SPACE_FILES_ORIGIN` in production
(STORAGE_UNAVAILABLE), so no production grant can point at it. The clients follow the
`filesOrigin` of the grant: a web bundle built with `VITE_APP_ENVIRONMENT=beta` accepts the
route, a production bundle refuses it as an invalid answer; the agent already accepts a loopback
`http:` source URL. The beta web CSP already allows `http://127.0.0.1:*` for images and media.

**Files host, beta (optional, not the read path).** `[env.beta]` in `apps/catalog-image-delivery/wrangler.toml` defines a
separate Worker, `soty-catalog-image-delivery-beta`. It has the `SPACE_BUCKET` binding to
`soty-spaces-beta` and the route `files-beta.soty.pp.ua/*`. The production section is not
touched: its binding is switched on in T062, after `soty-spaces-production` exists. Each of these
steps on the Cloudflare side needs the owner's authorization:

1. DNS: add a proxied record for `files-beta.soty.pp.ua`, using the usual route-only placeholder
   `AAAA 100::`, so the route has a hostname to match.
2. Deploy the beta Worker, which also creates the route: `cd apps/catalog-image-delivery && npm
run build && npx --yes wrangler@4.112.0 deploy --env beta`.
3. Set the Worker secrets for `--env beta`:
   - `SPACE_READ_GRANT_KEYS`, equal to the beta `space-storage` secret of the same name;
   - `SUPABASE_SERVICE_ROLE_KEY`;
   - `SUPABASE_URL`, a **public HTTPS** address of the beta API.

   The local beta stack listens only on `127.0.0.1:54321`, and the Worker refuses `http:` outside
   `dev`. So the beta files host needs a reachable address for that API, for example a
   Cloudflare Tunnel. Without one, every read answers 503 — which is why beta reads through
   `space-storage` (above) and these steps are needed only to rehearse the Worker itself.

4. Set the route failure mode for `files-beta.soty.pp.ua/*` to fail closed. The hostname has no
   origin, so failing open would only swap the daily-limit error for a different one.
5. Make sure no zone cache rule, transform or page rule matches the files hosts. Responses are
   `private`, and the Worker keeps its own edge cache, keyed without the grant.

The beta `space-storage` function needs these in its ignored env file:

- `R2_SPACE_ACCOUNT_ID`, `R2_SPACE_ACCESS_KEY_ID`, `R2_SPACE_SECRET_ACCESS_KEY`;
- `R2_SPACE_BUCKET=soty-spaces-beta`;
- `SPACE_READ_GRANT_KEYS` and `SPACE_READ_GRANT_KEY_VERSION`;
- `SPACE_FILES_ORIGIN=http://127.0.0.1:54321/functions/v1/space-storage/files` (the beta read
  route; `https://files-beta.soty.pp.ua` only while rehearsing the Worker behind a tunnel).

Next and production set `SPACE_FILES_ORIGIN=https://files.soty.pp.ua` and never the route.

**Free Workers plan limits** (developers.cloudflare.com/workers/platform/limits, read 2026-11-28):

- 100 000 requests per day **per account**, reset at 00:00 UTC, with error 1027 beyond that when
  the route fails closed. The same account also serves the production `/g/*` catalog image
  aliases, so they share this budget.
- 10 ms CPU per request. Waiting on R2, the cache or `fetch` does not count.
- 50 subrequests per request. R2 calls count, and Cache API calls share the quota.

Per request, `space-read` makes at most one epoch fetch (cached ≤30 s per isolate), one R2
`get`/`head`, one cache `match`/`put` and an HMAC check. That is far below the CPU and subrequest
limits. The daily count is the real bound: every thumbnail in a grid is one request on first
view, and `immutable` addresses keep repeat views in the same browser from coming back. M2
measures the actual count (T089).

**Production** (T062):

- create `soty-spaces-production` from the same two config files, with production origins only.
  Drop the beta loopback origins, and decide on the installed app's loopback origin the way the
  catalog staging bucket did;
- add the route `files.soty.pp.ua/*`;
- uncomment the binding in the production section;
- add the `/feeds/*` rule from the section above.

## Intel Mac release contract (049)

New full releases require `macos-arm64`, `macos-x64` and `windows-x64` together. Historical signed channels retain their original platform set; new signed channels declare `platformSetVersion: 2`. Never add fabricated Intel entries to an old release. The runner packages both Mac targets sequentially and binds Windows hosted smoke and final installer checksums to the same source.

Use `-- --arch=x64` for the Intel variant of Mac package commands; ARM defaults and paths remain unchanged. Intel outputs live in `release/x64/`, beta in `release/beta/x64/`, development in `release/dev/x64/`. A bootstrap runtime can be built with `SOTY_INTEL_BUILD_CACHE=/absolute/dedicated/cache nice -n 15 bash scripts/build-intel-inputs.sh`; supply the matching pinned browser through `SOTY_CHROMIUM_SOURCE_ROOT`. Do not reuse ARM binaries.

Both Mac records must match the exact source, public beta configuration, agent seal and web seal. ARM retains native packaged-beta verification. Owner-ratified `intel-user-feedback-v1` accepts schema-3 Intel static qualification: runtime/hardware remain unverified, and physical Intel/native-beta testing is first-user feedback rather than a release prerequisite. `hardware-acceptance.json` is optional observed evidence. Static checks or Rosetta must never be labelled physical success. [Policy](../specs/049-macos-intel-support/release-policy.md).

**Since 2026-11-14 Mac releases ship under `developer-id`** (Developer ID signed, notarized and stapled; the native updater stays off with `SOTY_NATIVE_UPDATES=disabled`, see [052](../specs/052-macos-native-updates/spec.md)). The earlier `adhoc-pre-048` decision of 2026-11-09 for 047+049 is history; the policy value remains only as an explicit owner override.

Before publication `scripts/verify-macos-release-trust.mjs` checks each Mac DMG's x86_64/arm64 payload and its sealed `release.json` identity (`target`, `architecture`, `buildId`, `stable` channel). Its default policy `developer-id` additionally requires the expected public Developer ID team in `MACOS_EXPECTED_TEAM_ID`, strict signatures, hardened runtime, Gatekeeper and stapled notarization; missing trust evidence blocks release. Until 048 provides Developer ID signing, the owner may explicitly select `SOTY_MACOS_TRUST_POLICY=adhoc-pre-048` (the way every release up to 1.3.3 shipped): ad-hoc signature integrity, payload and identity are still verified and the result reports `appleTrust: "unverified"`; it never claims notarization. There is no implicit fallback. This verifier does not sign or notarize an artifact. The signing chain itself is `scripts/sign-mac-app.sh` ([048](../specs/048-macos-apple-trust/spec.md)): inside-out, hardened runtime, one measured entitlement profile per binary, notarization and stapling with a Developer ID; under `developer-id` the gate also requires the hardened runtime on every Mach-O and a stapled ticket on the app as well as the DMG. Packaging signs through that chain (048 T008 to T011): an ad-hoc production package or image requires the explicit `SOTY_MACOS_TRUST_POLICY=adhoc-pre-048`, and under `developer-id` the runner proves the trust inputs (identity in the keychain, its team, the notary profile) before the first build, then journals each artifact's `signing.json` beside the gate result into the platform baseline. To re-sign an older signed channel without adding the Intel slot use `node scripts/sign-release-manifest.mjs --historical`; a current-version manifest missing a platform gets a zero-digest placeholder, never `null`. Existing immutable assets must match their published SHA-256; partial or uncertain publication stops for reconciliation rather than replacing assets.

Manifest-only verification reuses sealed binaries and refreshes exact-source qualification (native ARM, static-qualified Intel). The resulting `release/beta/platform-baseline.json` binds both Mac seals and Windows workflow proof to the signed channel. Web mini releases retain and validate this complete baseline; they never rebuild an installer or change its architecture. All existing production authorization, activation and recovery gates still apply.

For one ARM build host, prepare/verify the Intel beta target first (`npm run beta:package -- --arch=x64`, then `npm run beta:verify -- --arch=x64`), which never launches x64 code; then prepare/verify ARM natively. Packaging still refuses a running same-flavor app. Intel production package/DMG verification is static and does not require stopping a running production app. Public signature/notarization, all-three-artifact final-byte checks, Windows hosted proof, G0 and explicit activation are unchanged. Mini binds the qualification mode and may not relabel static Intel evidence native.

### Future052 global image activation

Feature052 is inactive by migration and excluded from the1.4.3 release worktree.
Its separate full-release acceptance is documented in `docs/CATALOG_IMAGES.md`
and `specs/052-shared-white-images/quickstart.md`. Provisioning the new delivery
Worker, exact `/g/*` route/canonical-cache rules and beta provider evidence precede
T0. Both current and archived rollback builds must understand the policy; otherwise
ship a separately verified compatibility baseline first. The read-only release
preflight checks `catalogGlobalCutover` evidence if explicitly declared; trusted
`recordCatalogGlobalAcceptance` records the short-lived exact-bound permit.
Operator control cannot mint it. Publication to next and promotion never call
activate. Activation, cleanup timing and source/config proof require a separate
explicit validated owner intent; no command in this implementation runs them.

## Native macOS updates (052)

The first qualified release containing the native host still needs the normal one-time signed installer. Later macOS updates use an explicitly accepted, dual-bound ZIP from the promoted production `stable.json`; next does not independently activate native updates. A web rollback never automatically downgrades an already-started native target.

Production packaging now embeds the checksum-pinned Sparkle framework and attests every helper’s upstream and signed Mach-O bytes. ZIP signatures use separate local updater Ed25519 keys, while the entire descriptor remains covered by the existing P-256 manifest signature. `updates:keys` provisions updater keys locally without rotating existing pins. The manifest-only release commit includes the exact published ZIP descriptor; the runner publishes and reads back ZIPs alongside DMGs. Assets remain immutable.

A Developer ID production package also requires `SOTY_NATIVE_UPDATE_QUALIFICATION`, a local source-bound record with reviewed workload, helper-budget, recovery, trust, Windows and successive-update evidence. The new implementation has not yet passed those runs. Follow [052’s implementation checkpoint](../specs/052-macos-native-updates/implementation.md) for the deferred test session. The existing explicit release authorization, packaged beta, source/config seals, Apple trust and next/promote/rollback gates still apply. A tiny notarized probe does not qualify Soty or replace clean-host acceptance.

**Owner decision 2026-11-14 (release after 1.4.4):** ship Developer ID signed, notarized and stapled Mac packages with the native updater compiled in but switched off: `SOTY_NATIVE_UPDATES=disabled` (exactly that value; anything else fails closed with `NATIVE_UPDATES_POLICY_INVALID`). The Apple trust gates are unchanged. The package records `SotyNativeUpdatesEnabled=false`, the runner skips the updater key and qualification preflight, no `.native-update.json` descriptor is signed and `stable.json` carries none, so users update through the trusted installer as before. Qualification of the updater remains a separate track for a later release; the first release with it enabled still needs one installer step.

**Owner decision 2026-11-16 (supersedes the switch-off for next):** `SOTY_NATIVE_UPDATES=qualification-deferred-until-promote` (exactly that value; it also refuses a simultaneous `SOTY_NATIVE_UPDATE_QUALIFICATION` with `NATIVE_UPDATES_POLICY_CONFLICT`). The package records `SotyNativeUpdatesEnabled=true`, the runner still requires the pinned updater key, signs `.native-update.json` descriptors and `stable.json` carries them; only the qualification record moves from packaging to `release:channel -- promote --native-update-qualification=<record>`, which refuses without a valid record for the descriptors' source revision. The deferral is accepted only for a run that lands on next first (`NATIVE_UPDATE_DEFERRAL_REQUIRES_NEXT`). Opting a Mac into next's manifest: see `docs/RELEASE-CHANNEL.md`.
