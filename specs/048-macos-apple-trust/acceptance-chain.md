# Acceptance: ланцюжок підпису без сертифіката (T006)

**Дата**: 2026-11-09. **Машина**: Apple Silicon, macOS 26.6 (Darwin 25.6.0), `codesign` з Xcode, `notarytool` 1.0.0, валідних ідентичностей підпису 0, Rosetta увімкнена. **Ідентичність у прогоні**: ad-hoc. **Реальний Node**: офіційний `node-v22.23.4-darwin-arm64/bin/node` з nodejs.org, статичний, SHA-256 `c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428`.

## Команда

```zsh
SOTY_TEST_NODE_BINARY=<шлях до node> npx vitest run tests/mac-signing-chain.test.ts tests/macos-trust-evidence.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true
```

## Результат

16 passed, 1 skipped, 7.7 с. Пропущений кейс потребує `SOTY_TEST_EXPECT_NOTARIZED=1` і Developer ID; він лишається відкритим до T012.

| Кейс                                                                               | Результат |
| ---------------------------------------------------------------------------------- | --------- |
| Верифікатор відхиляє сьогоднішній ad-hoc ланцюжок `package-mac.sh`                 | pass      |
| `package-mac.sh` досі підписує ad-hoc, тобто розрив той самий, що в поставці       | pass      |
| Верифікатор приймає hardened-бандл, підписаний вручну з JIT-парою лише на рантаймі | pass      |
| Верифікатор відхиляє бандл зі зміненим після підпису вкладеним бінарем             | pass      |
| Верифікатор відхиляє підпис ззовні всередину з непідписаним вкладеним бінарем      | pass      |
| Верифікатор відхиляє JIT-entitlement на бінарі без JIT                             | pass      |
| Верифікатор відхиляє entitlement, що вимикає library validation                    | pass      |
| Ланцюжок підписує фікстуру зсередини назовні з профілем на бінар; JSON-підсумок    | pass      |
| Ланцюжок відмовляється звертатися до Apple з ad-hoc ідентичністю                   | pass      |
| Ланцюжок зриває чужий підпис і його entitlements перед підписом                    | pass      |
| Реальний Node, підписаний ланцюжком, виконує JS і WebAssembly під hardened runtime | pass      |
| Той самий Node hardened без JIT-пари не стартує: SIGTRAP при створенні isolate     | pass      |
| Gatekeeper приймає, квиток степлений                                               | skipped   |
| `macos-trust-evidence`: політики, команда, ідентичність пакета                     | 4 pass    |

Lint: `eslint` і `prettier` на змінених файлах чисті.

## Контроль на реальному бандлі

Копія встановленого Soty 1.3.2 підписана ланцюжком за 15 с: підсумок `machO` 10 і `nestedBundles` 1, тобто 11 Mach-O разом із бінарем Finder-розширення, усі з прапорцем `runtime`; `node` і `chrome-headless-shell` рівно з JIT-парою; Finder-розширення зі своїм sandbox-набором; `codesign --verify --deep --strict` пройшов. У підписаній копії Node 24.13.0 виконав JS і WebAssembly, headless shell відрендерив сторінку з результатом скрипта, ffmpeg і whisper-cli відповіли. Застосунок не запускався: поруч працює встановлена копія, запуск є предметом T009.

## Спостереження, що вплинули на тест

Hardened-бінар, який падає під час старту всередині каталогу `*.app` з `Contents/MacOS`, не завершується: macOS показує модальний діалог «програму пошкоджено, перенесіть у Смітник» і тримає процес призупиненим, доки діалог не закриють; потім процес отримує SIGKILL без крашрепорту. Поза `.app` той самий бінар падає за секунду з SIGTRAP і крашрепортом. Тому негативний контроль живе в порожньому каталозі. Для продукту це означає: Node без JIT-пари в підписаному Soty.app виглядав би для користувача як «Soty пошкоджено», і саме це має виключити T009 до переходу production-пакування на ланцюжок.

## Прогін 2026-11-10 (T008, T013, T016–T019)

**Машина**: та сама; реліз 1.4.1 стояв на заблокованому кроці, воркер не працював, load 3,1. **Реальний Node**: `/Applications/Soty.app/Contents/Resources/runtime/node` зі встановленого Soty 1.4.0, статичний, v24.13.0. **Воркдерево**: `AffSupport-048-trust` на 1b071d37, `node_modules` симлінком на основну копію, `packages/shared/dist` копією.

```zsh
SOTY_TEST_NODE_BINARY=/Applications/Soty.app/Contents/Resources/runtime/node npx vitest run \
  tests/mac-signing-chain.test.ts tests/mac-signing-policy.test.ts tests/macos-signing-summary.test.ts \
  tests/macos-trust-preflight.test.ts tests/macos-trust-evidence.test.ts tests/macos-release-evidence.test.ts \
  tests/macos-static-qualification.test.ts tests/finder-integration.test.ts tests/release-runner-step-adapter.test.ts \
  tests/beta-promotion-gate.test.ts tests/environment-packaging.test.ts tests/web-only-policy.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true
```

Результат: 12 файлів, 136 passed, 1 skipped (Gatekeeper і staple, потребує Developer ID), 32 с. Зокрема: реальний Node через ланцюжок виконує JS і WebAssembly, без JIT-пари не стартує; три закриті коди входів спрацьовують до першого `codesign` (CDHash рантайму незмінний); списки заборонених entitlements, JIT-пара і правила відбору збігаються в ланцюжку, гейті, тесті, plist і контракті; статична x64-кваліфікація проходить із фікстурою, підписаною ланцюжком, і доказ несе `codeSigning` (6 hardened Mach-O, 5 у підсумку); раннер відмовляє `macos_package` без входів довіри і `publish` без `signing.json` під `developer-id`, а під явним `adhoc-pre-048` проходить як раніше; preflight читає команду і строк дії з сертифіката, згенерованого openssl.

`tsc -p tsconfig.check.json` чистий. `tsc -p tsconfig.scripts.json` показав три помилки типів у JSDoc нового коду (опція `expectedTeam`, читання `childEnv` як `NodeJS.ProcessEnv`); виправлено в 5fbff4a9; повторний прогін 2026-11-10 після релізу 1.4.1 (база `main` f7e33e93) чистий.

## Прогін 2026-11-10, атестація підписаних файлів (після T009)

T009 знайшов єдиний гейт після підпису, який переподпис ламає: `verify-staged-dependencies.mjs` вимагав байтової рівності Chromium Headless Shell із завантаженням Playwright. Ланцюжок тепер друкує `files` (шлях, профіль, SHA-256 до і після підпису кожного Mach-O), аудит звіряє кожен `after` з бандлом, а верифікатор стейджингу приймає переподписаний Chromium лише через `--signing=` (контракт, «Вивід»). Коміт c9823615.

```zsh
SOTY_TEST_NODE_BINARY=/Applications/Soty.app/Contents/Resources/runtime/node npx vitest run \
  tests/mac-signing-chain.test.ts tests/macos-signing-summary.test.ts tests/staged-browser-provenance.test.ts \
  tests/macos-static-qualification.test.ts tests/mac-signing-policy.test.ts tests/release.test.ts \
  tests/release-runner-step-adapter.test.ts tests/macos-release-evidence.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true
```

Результат: 8 файлів, 60 passed, 1 skipped (той самий нотаризований кейс), 16 с; `tsc -p tsconfig.scripts.json` і `tsc -p tsconfig.check.json` чисті. Ланцюжок на фікстурі: три записи `files` за шляхом, кожен `after` дорівнює дайджесту файла в бандлі й відрізняється від `before`, `before` рантайму дорівнює дайджесту `/bin/echo`, з якого фікстуру зібрано. Провенанс Chromium: рівність байтів без підсумку проходить як до 048; переподписані байти без підсумку відхиляються; з підсумком приймаються лише коли `before` дорівнює записаному завантаженню, а `after` — поточним байтам; підміна `before`, `after`, профілю, шляху, застосунку чи відсутність файла відхиляються закритими кодами.
