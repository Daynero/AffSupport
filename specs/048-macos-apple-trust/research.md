# Research: Apple trust для Soty на macOS

Дата вимірів: 2026-11-09, Apple Silicon, macOS 26.6 (Darwin 25.6.0), Xcode `codesign`, Rosetta увімкнена. Усі проби: копія бінаря в тимчасовий каталог, `codesign --remove-signature`, `codesign --force --options runtime [--entitlements X] --sign -`, запуск. Ad-hoc ідентичність достатня, бо hardened runtime забезпечується ядром за прапорцем підпису, а не видавцем.

## R1. Що потрібно Node під hardened runtime

Проба: `node -e` з циклом на 5 млн ітерацій, `new WebAssembly.Module(...)`, друк версії й архітектури.

| Бінар                                              | Без entitlements                                       | лише allow-jit | лише allow-unsigned-executable-memory | обидва |
| -------------------------------------------------- | ------------------------------------------------------ | -------------- | ------------------------------------- | ------ |
| Node 22.23.4 arm64, офіційний tarball              | крах, rc=133                                           | ok             | ok                                    | ok     |
| Node 24.13.0 arm64 зі встановленого Soty 1.3.2     | крах: `Failed to reserve virtual memory for CodeRange` | не міряно      | не міряно                             | ok     |
| Node 22.23.4 x64, офіційний tarball, через Rosetta | крах, rc=133, `Check failed: 12 == (*__error())`       | крах           | ok                                    | ok     |

Сьогоднішній ad-hoc підпис без `--options runtime` працює на обох, саме тому проблема невидима.

**Рішення**: профіль `node` містить рівно `com.apple.security.cs.allow-jit` і `com.apple.security.cs.allow-unsigned-executable-memory`. Один профіль для обох архітектур: arm64 задоволений будь-яким із двох, x64 лише другим. Жоден інший ключ не потрібен для JS, WebAssembly і спавну дочірніх процесів.

**Чому не залишити підпис Node.js Foundation**: офіційний бінар несе шість entitlements: `allow-dyld-environment-variables`, `allow-jit`, `allow-unsigned-executable-memory`, `disable-executable-page-protection`, `disable-library-validation`, `get-task-allow`. Останній нотаризація відхиляє, інші три вимикають захист без потреби. Підпис зривається і бінар підписується власною ідентичністю.

## R2. Chromium headless shell

Каталог `chrome-headless-shell-mac-arm64` від Playwright 1.62.1: один виконуваний файл і чотири dylib (`libEGL`, `libGLESv2`, `libvk_swiftshader`, `libvulkan`), усі ad-hoc і linker-signed, без Team ID. Проба: `--headless --disable-gpu --dump-dom` сторінки зі скриптом.

| Entitlements на shell                        | Результат                                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| без                                          | зависання до таймера, рендер не стартує; GPU-процес падає на library validation          |
| allow-jit + allow-unsigned-executable-memory | ok, DOM із результатом скрипта; у stderr два записи library validation для власних dylib |
| те саме + disable-library-validation         | ok, без шуму                                                                             |

Шум library validation під ad-hoc: «mapping process and mapped file (non-platform) have different Team IDs». Обидва підписи не мають Team ID, тож ядро їх не вважає однією командою. З Developer ID усі файли несуть одну команду, і перевірка проходить.

**Рішення**: профіль `chromium` дорівнює профілю `node`; `disable-library-validation` не додається. Dylib Chromium підписуються hardened без entitlements. Під ad-hoc приймання допускає цей шум як відомий, бо `--disable-gpu` вже є режимом роботи каталогу.

## R3. Engines

`ffmpeg`, `ffprobe` 7.1.1 і `whisper-cli` на arm64 зі встановленого Soty 1.3.2 та x64 збірки з `Intel049`: під hardened runtime без entitlements `-version` і `--help` працюють. Усі статичні, без несистемних динамічних залежностей. Metal-шейдери whisper компілюються системним фреймворком і hardened runtime не обмежуються.

**Рішення**: профіль `hardened` без entitlements для engines і всіх dylib.

## R4. Поверхня підпису

Вільні Mach-O поза фреймворками сидять у `Contents/Resources`: `runtime/node`, `runtime/bin/ffmpeg`, `runtime/bin/ffprobe`, `runtime/bin/whisper-cli`, каталог headless shell у стейджі агента. Вкладений бандл один: `PlugIns/*.appex` Finder-розширення із sandbox-entitlements. Нативних `.node` аддонів у production-замиканні агента немає: залежності fastify, playwright-core, `@jsquash` на WebAssembly, yazl, yauzl. Головний виконуваний файл лончера на Swift із AppKit і FinderSync, без JIT.

`codesign --deep` підписує лише вкладені бандли та головний файл; вільні Mach-O в Resources він пропускає, хоч і запечатує їх хеші в ресурсний seal. Сьогоднішній `package-mac.sh` саме тому підписує `runtime/node` окремо, а решту engines узагалі не підписує індивідуально, що нотаризація відхилить.

**Рішення**: ланцюжок знаходить усі Mach-O за magic-байтами одним проходом, підписує їх окремо за профілем, потім вкладені бандли, потім застосунок. Для перевірки `--deep --strict` лишається.

**Контроль на реальному бандлі, 2026-11-09**: копія встановленого Soty 1.3.2 (393 МБ) підписана ланцюжком з ad-hoc ідентичністю за 15 с. Підсумок ланцюжка: `machO` 10 і `nestedBundles` 1, тобто лончер і 9 вільних Mach-O (node, ffmpeg, ffprobe, whisper-cli, chrome-headless-shell і його 4 dylib) плюс Finder-розширення з власним бінарем у вкладеному бандлі; разом 11 Mach-O, і саме стільки рахує гейт у `hardenedMachO`. Усі отримали прапорець `runtime`; node і shell рівно JIT-пару; Finder-розширення зберегло `app-sandbox` і `files.user-selected.read-only`; `codesign --verify --deep --strict` пройшов. У підписаній копії node 24.13.0 виконав JS і WebAssembly, headless shell відрендерив сторінку, ffmpeg і whisper-cli відповіли на `-version` і `--help`. Застосунок не запускався, бо поруч працює встановлена копія; запуск є предметом T009.

## R5. Staple

Гейт у `verify-macos-release-trust.mjs` валідує staple лише на DMG, а Gatekeeper оцінює застосунок усередині змонтованого образу. Після перетягування в Applications застосунок живе без образу; офлайн перший запуск можливий лише з квитком на самому `.app`.

**Рішення**: нотаризувати і степлити застосунок до збирання DMG, потім нотаризувати і степлити DMG; гейт валідує обидва.

## R6. Секрети і машина

Keychain релізної машини тримає ідентичність і профіль `notarytool store-credentials`. Раннер передає весь process env у дочірні кроки, тож `SOTY_SIGNING_IDENTITY`, `SOTY_NOTARY_KEYCHAIN_PROFILE`, `MACOS_EXPECTED_TEAM_ID` і `SOTY_MACOS_TRUST_POLICY` доходять без змін у коді раннера. Запис секретів у трекнуті файли заборонений чинною політикою репозиторію. `codesign --timestamp` і `notarytool --wait` потребують мережі; одна слабка машина виконує нотаризацію як окремий важкий крок.

На цій машині валідних ідентичностей підпису нуль, `notarytool` 1.0.0 доступний.

## R7. Bundle id

Виміряно, не вирішено: production Info.plist і `environment-meta.mjs production bundle-id` дають `local.video.compressor.test`; dev і beta мають власні id. Developer ID закріплює пару Team ID і bundle id як ідентичність для TCC, Finder-розширення і визнання «того самого» застосунку. Зміна після першого підписаного релізу означає повторні дозволи у користувачів. Типове рішення: зберегти, згідно з рішенням власника від 2026-09-17; відкрите вікно до першого підписаного релізу зафіксоване в спеці.

## R8. Відкинуті альтернативи

- `codesign --deep --options runtime` на бандл: не підписує вільні Mach-O, не дає профілів на бінар.
- Один набір entitlements на весь бандл із `--preserve-metadata=entitlements`: лончер і engines отримали б JIT без потреби, а Node успадкував би чужі шість.
- `disable-library-validation` для Chromium: прибирає лише ad-hoc шум ціною вимкненого захисту в production.
- Нотаризувати лише DMG: офлайн перший запуск після перетягування не доведений.
- Залишити підпис Node.js Foundation: `get-task-allow` відхиляється нотаризацією; інша команда не впливає на library validation, бо Node не вантажить наших dylib, але чужі entitlements неприйнятні.
- Робити траст і нативний апдейтер однією спекою: реліз із ручним handoff уже вийшов; апдейтер не є умовою довіри.

## R9. Падіння hardened-бінаря всередині бандла

Виміряно під час T006. Якщо hardened-бінар без потрібних entitlements падає на старті всередині каталогу `*.app` з `Contents/MacOS`, macOS показує модальний діалог «програму пошкоджено, потрібно перенести у Смітник», а процес лишається призупиненим без витрат CPU, доки діалог не закриють, після чого отримує SIGKILL без крашрепорту. Той самий бінар у звичайному каталозі падає за секунду з SIGTRAP і звичайним звітом. Для користувача неправильно підписаний Soty.app виглядатиме саме так, не як крах; це головний аргумент за приймання запуску пакетної бети до переходу production-пакування на ланцюжок. Негативний контроль у тесті тому живе поза бандлом.
