# Implementation Plan: Apple trust для Soty на macOS

**Branch**: `048-macos-apple-trust` у воркдереві `AffSupport-048-trust` | **Date**: 2026-11-09, оновлено 2026-11-10 | **Spec**: [spec.md](spec.md)
**Input**: `/specs/048-macos-apple-trust/spec.md`

## Summary

Замінити ad-hoc підпис одним ланцюжком `scripts/sign-mac-app.sh`: усі Mach-O зсередини назовні, hardened runtime, профілі entitlements на бінар, timestamp, нотаризація і staple застосунку, потім DMG. Гейт `verify-macos-release-trust.mjs` під `developer-id` додатково вимагає hardened runtime на кожному Mach-O і staple на застосунку. Усе, що не потребує сертифіката, робиться й доводиться зараз з ad-hoc ідентичністю; пакування переходить на ланцюжок лише після того, як пакетна бета з hardened runtime пройде чинні перевірки.

## Technical Context

**Language/Version**: zsh для ланцюжка, як і решта пакування; ESM `.mjs` для гейта; Vitest у центральному `tests/`.
**Primary Dependencies**: `codesign`, `spctl`, `xcrun notarytool`, `xcrun stapler`, `ditto`, `hdiutil`; Developer ID Application у keychain; профіль `notarytool store-credentials`.
**Storage**: жодного нового сховища; запис довіри входить у чинні докази релізу; подання нотаризації живе в журналі кроку.
**Testing**: `tests/mac-signing-chain.test.ts` на фікстурі і на реальному Node через `SOTY_TEST_NODE_BINARY`; `tests/macos-trust-evidence.test.ts` для гейта; пакетна бета для приймання запуску.
**Target Platform**: macOS 13+ arm64 і x64; Windows не змінюється.
**Project Type**: release tooling навколо desktop agent.
**Performance Goals**: очікування нотаризації типово до 30 хвилин (`SOTY_NOTARY_TIMEOUT`) усередині 45-хвилинного бюджету кроку пакування раннера; підпис бандла зі стейджем агента в межах хвилин.
**Constraints**: одна слабка машина, один важкий процес; мережа для timestamp і нотаризації; секрети лише keychain/env; жодного fallback між політиками.
**Scale/Scope**: 3 історії, 11 FR, 5 SC; два Mac-артефакти на реліз.

## Constitution Check

| Principle                | Design evidence                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| I — typed boundaries     | Закрита таблиця профілів і закриті коди відмов у ланцюжку; гейт перевіряє точні ключі entitlements і прапорці, не евристики            |
| II — release origin      | Гейт лишається в кроці publish раннера; результат записується разом із чинними платформними доказами; старі канали не переподписуються |
| III — least privilege    | Мінімальні entitlements, виміряні, не скопійовані; чужі підписи зриваються; секрети лише в keychain; ad-hoc не звертається до Apple    |
| IV — processes/resources | Нотаризація як окремий послідовний крок; жодного паралельного важкого процесу; таймаути на `notarytool --wait`                         |
| V — HTTP conventions     | Не застосовується, HTTP-поверхонь немає                                                                                                |
| VI — UI/state            | Не застосовується до релізу; інструкції користувачам змінюються лише після першого нотаризованого релізу                               |

Винятків немає. Вимога конституції перевіряти пакування на обох платформах зберігається; Windows-підпис лишається окремою роботою з 009.

## Project Structure

### Documentation (this feature)

```text
specs/048-macos-apple-trust/
├── spec.md
├── plan.md
├── research.md          # виміри entitlements і рішення
├── data-model.md        # профіль, ідентичність, запис довіри, подання
├── quickstart.md        # ad-hoc і Developer ID прогін, перевірка
├── contracts/
│   └── signing-chain.md # інтерфейс ланцюжка, таблиця профілів, коди, схема запису
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
packaging/macos/entitlements/
├── launcher.plist       # порожній набір
├── node.plist           # allow-jit, allow-unsigned-executable-memory
└── chromium.plist       # той самий набір для chrome-headless-shell
packaging/FinderExtension/FinderExtension.entitlements   # без змін, sandbox
scripts/
├── sign-mac-app.sh                 # новий ланцюжок (009 T157)
├── verify-macos-release-trust.mjs  # + hardened на кожному Mach-O, + staple застосунку; T017: команда і timestamp на кожному Mach-O
├── package-beta-mac.sh             # перший споживач ланцюжка, пише signing.json (T008)
├── verify-beta-package.sh          # + аудит hardened runtime і entitlements бети (T008)
├── record-macos-beta-proof.mjs     # + поля аудиту в доказі бети (T008)
├── package-mac.sh                  # перехід на ланцюжок після приймання бети (009 T158, T010)
├── package-dev-mac.sh              # те саме для dev-збірки (T010)
├── package-dmg.sh                  # нотаризація і staple DMG з ідентичністю (T011)
├── audit-macos-signing.mjs         # аудит бандла проти signing.json для доказу бети (T008); звіряє after кожного файла (T009)
├── verify-staged-dependencies.mjs  # --signing=: Chromium приймається через атестацію ланцюжка (T009)
├── lib/
│   ├── macos-signing-summary.mjs   # типізоване читання signing.json і запису гейта (T013); files (T009)
│   ├── sha256-file.mjs             # потоковий SHA-256 файла (T009)
│   └── staged-browser-provenance.mjs # before = дайджест завантаження, after = байти в бандлі (T009)
└── lib/release/
    ├── platform-evidence.mjs       # схема доказу бети з полями аудиту (T008)
    ├── macos-trust-preflight.mjs   # входи довіри до macos_package (T019)
    ├── step-adapter.mjs            # preflight входів довіри до macos_package (T019); publish журналить signing.json і запис довіри (T013)
    └── platform-baseline.mjs       # запис довіри в macos[target].trust (T013)
tests/
├── mac-signing-chain.test.ts       # контракт на бінар, реальний Node, негативний контроль; T018: закриті коди входів; T009: files
├── macos-trust-evidence.test.ts    # гейт; T017: команда і timestamp на кожному Mach-O
├── mac-signing-policy.test.ts      # T016: збіг заборонених списків, JIT-пари і правил відбору в трьох місцях
├── macos-signing-summary.test.ts   # читання підсумку підпису, зокрема files (T013, T009)
├── staged-browser-provenance.test.ts # Chromium через атестацію (T009)
├── macos-trust-preflight.test.ts   # preflight входів довіри (T019)
└── release-runner-step-adapter.test.ts # publish і manifest_beta_verify з signing.json і записом довіри (T013)
```

**Structure Decision**: ланцюжок окремим скриптом, який пакувальники викликають одним рядком; профілі окремими файлами, щоб diff entitlements був видимий у рев'ю; гейт лишається єдиною точкою рішення про публікацію.

## Phases

**Phase 0, research**: виконано 2026-11-09, [research.md](research.md). Виміряно Node arm64 і x64, Chromium headless shell, engines; підтверджено поверхню підпису і поведінку `--deep`.

**Phase 1, design**: контракт ланцюжка, таблиця профілів, схема запису довіри, quickstart. Виконано разом із цим планом.

**Phase 2, реалізація без сертифіката**: профілі, ланцюжок, тест, гейт. Виконано 2026-11-09 (T001–T007), доказ у [acceptance-chain.md](acceptance-chain.md): 16 passed, 1 skipped, реальний Node позитивно й негативно. T016, T017 і T018 закрито 2026-11-10 прогоном після релізу 1.4.1.

**Phase 3, приймання запуску**: бета-пакування через ланцюжок, hardened пакетна бета проходить `beta:verify`; потім production-пакування і DMG-крок. Бету обох архітектур доведено 2026-11-10 ([acceptance-beta.md](acceptance-beta.md)); production-пакування і DMG-крок мають код і тести делегування (T010, T011) і закриваються першим релізом з ідентичністю.

**Phase 4, ідентичність**: власник купує Developer ID, кладе сертифікат і профіль нотаризації в keychain, задає команду в середовищі релізу; перший реліз під `developer-id`; потім оновлення інструкцій користувачам.

## Risks

- Пакетна бета під hardened runtime виявить бінар, якому потрібен entitlement поза таблицею. Відповідь: вимір, оновлення профілю і research, не загальне послаблення. Прогін T009 2026-11-10: такого бінаря немає; натомість зламався гейт байтової рівності Chromium із завантаженням Playwright, закритий атестацією `files` у підсумку підпису.
- Нотаризація відхилить щось, чого локальна перевірка не бачить, наприклад timestamp у вкладеному бінарі. Відповідь: журнал `notarytool log` друкується в крок; виправлення в ланцюжку.
- Зміна bundle id після першого підписаного релізу. Відповідь: рішення зафіксоване в спеці як типове «залишити», вікно до першого релізу назване явно.
- Активація членства затримується: Apple запросив документ одразу після оплати, а підтвердження замовлення адресоване платнику з іншим ім'ям, ніж заявник. Відповідь: паспорт завантажено 2026-11-09; якщо активації немає через три робочі дні або перевірку відхилено, відкривається кейс у Developer Support; усе до T012 не чекає.
- Робоча копія `main` спільна з релізним раннером і з іншою сесією Claude, яка перед релізом паркує чужі незакомічені файли в stash. Відповідь: робота 048 живе у власному воркдереві `AffSupport-048-trust` на гілці `048-macos-apple-trust` і має бути закомічена там; воркдерево готується як воркдерево раннера (`provisionWorktree`): APFS-клони `node_modules`, приватні копії `.env.*` і ключів бети, клон `release/inputs/x64`; симлінк `node_modules` не годиться, бо стейджинг агента читає `npm ls --long` і через симлінк вивід переповнює буфер; тести і пакування ганяються в самому воркдереві, не паралельно з релізом.
- Перший підписаний запуск поверх ad-hoc збірки може повторно запитати дозволи на папки, бо вимога коду в TCC змінюється з cdhash на команду. Відповідь: це одноразово й очікувано; перевіряється в T014 на машині власника і згадується в нотатках першого нотаризованого релізу, а не лікується entitlement-ами.
- Три копії одного закритого списку заборонених entitlements: у ланцюжку, у гейті, у тесті. Відповідь: T016 додає тест, що читає всі три і вимагає збігу; одне джерело у файлі політики відкладене, бо ланцюжок на zsh.
