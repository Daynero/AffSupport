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
- [ ] Edge Function `delete-account` розгорнута до ввімкнення `VITE_DELETE_ACCOUNT_ENABLED=true`.
- [ ] Перший admin доданий UUID-командою з `SUPABASE_SETUP.md`.
- [ ] Реальні credentials відсутні в Git.

## Before you release: beta verification

Every production package and web deploy now runs `scripts/verify-beta-promotion.mjs`, which refuses
the release unless the commit is contained in the `beta` branch **and** a packaged-beta verification
record exists for that exact revision. Run `npm run beta:package && npm run beta:verify` on the beta
line first. Full workflow in [BETA.md](./BETA.md).

## Production build environment

Project: `wishly-app`. Canonical production origin: `https://soty.pp.ua`.

Додайте у production build environment:

| Variable                        | Production value                               |
| ------------------------------- | ---------------------------------------------- |
| `VITE_SUPABASE_URL`             | Project URL із Supabase                        |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_...` із Supabase               |
| `VITE_SITE_URL`                 | `https://soty.pp.ua`                           |
| `VITE_ADMIN_EMAIL`              | необов’язкова development-підказка або порожнє |
| `VITE_PRODUCT_OPERATOR`         | реальне ім’я/назва оператора                   |
| `VITE_LEGAL_CONTACT_EMAIL`      | реальний contact email                         |
| `VITE_DELETE_ACCOUNT_ENABLED`   | `true` тільки після deploy Edge Function       |
| `VITE_AGENT_URL`                | `http://127.0.0.1:43120`                       |

Не додавайте на frontend-хостинг Google Client Secret, Supabase secret/service role key або JWT. Не друкуйте значення environment variables у build logs.

Cloudflare project використовує **Direct Upload**: Cloudflare отримує вже готову папку `dist`, тому Dashboard variables не можуть змінити Vite bundle після build. Для поточного workflow створіть у корені незакомічений `.env.production` з таблицею значень вище або передайте ці самі змінні в CI, де запускається build. `.env.production` уже ігнорується Git.

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

## Реліз на дві платформи

### Canonical agent runbook

Це єдина дозволена production-процедура. Один `<release-sha>` породжує обидва
бінарні артефакти; пізніший `<manifest-sha>` лише підписує їх і деплоїть web.
Не перебудовуйте артефакти після manifest-only commit.

Перед початком задайте `<version>` без `v` (наприклад, `1.0.3`) і не змінюйте її
посеред релізу. Важкі локальні команди запускайте послідовно через `nice -n 15`.

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

Якщо HEAD змінився після цього кроку, gate застарів: синхронізуйте `beta` і
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
(cd release && shasum -a 256 -c Soty-v<version>-macOS-arm64.zip.sha256)
(cd release && shasum -a 256 -c Soty-v<version>-macOS-arm64.dmg.sha256)
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
