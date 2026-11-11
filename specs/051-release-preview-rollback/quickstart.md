# Quickstart / перевірка 051

Важкі кроки виконувати по одному, через `nice -n 15`, після `uptime`.

1. **Юніт-тести**: `npx vitest run tests/release-channel*.test.ts tests/check-migrations-additive.test.ts tests/site-channel.test.ts tests/release-testers.test.ts --pool=forks --poolOptions.forks.singleFork=true`. Мають бути зелені.
2. **Гейт міграцій**: `node scripts/check-migrations-additive.mjs --base=origin/main` проходить на гілці. Тимчасовий файл із `alter table x drop column y` має блокуватись із назвою файлу.
3. **Dry-run каналу**: `SOTY_RELEASE_CHANNEL_DIR=$(mktemp -d) node scripts/release-channel.mjs status` має сказати «кандидата немає».
4. **Справжній next**: `npm run build:web`, далі `node scripts/deploy-web.mjs --channel=next`.
   - `https://next.soty.pp.ua` віддає цей бандл з позначкою тестової версії;
   - `https://soty.pp.ua` не змінився: `index.html` до і після збігаються;
   - `release:channel -- status` показує кандидата.
5. **Вхід на next** у Chrome: вхід повертає на next, гейт пропускає адміна.
6. **Відкат і розкатка — лише репетиція**: `release:channel -- promote` без `--confirm` показує план і перевіряє живий next. Справжній `--confirm` виконується лише за командою власника.
7. **Скасування**: `release:channel -- cancel --confirm` повертає next на прод-бандл (`index.html` next == прод).
