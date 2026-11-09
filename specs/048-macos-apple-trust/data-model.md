# Data Model: Apple trust для Soty на macOS

Нових таблиць і сховищ немає. Сутності нижче живуть у файлах репозиторію, у keychain релізної машини та в доказах релізу.

## Профіль entitlements

| Поле     | Значення                                                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| name     | закрите: `launcher`, `node`, `chromium`, `hardened`, `finder-extension`                                                                         |
| file     | `packaging/macos/entitlements/<name>.plist`; `hardened` без файла; `finder-extension` чинний файл                                               |
| selector | правило за шляхом у бандлі: `Contents/Resources/runtime/node`; базове ім'я `chrome-headless-shell`; `*.appex`; головний виконуваний файл; решта |
| keys     | точний очікуваний набір ключів; порожній для `launcher` і `hardened`                                                                            |

Інваріанти: жоден профіль не містить `disable-library-validation`, `allow-dyld-environment-variables`, `disable-executable-page-protection`, `get-task-allow`. Профілі `node` і `chromium` містять рівно `allow-jit` і `allow-unsigned-executable-memory`.

## Ідентичність підпису

| Поле   | Значення                                                     |
| ------ | ------------------------------------------------------------ |
| kind   | `adhoc` або `developer-id`                                   |
| teamId | 10 символів для `developer-id`; відсутній для `adhoc`        |
| source | `SOTY_SIGNING_IDENTITY` і за потреби `SOTY_SIGNING_KEYCHAIN` |

Ніколи не записується в репозиторій. `adhoc` не може нотаризувати.

## Підсумок підпису

Рядок JSON із виводу ланцюжка, збережений пакувальником як `signing.json` поруч із ZIP або пакетом бети; формат у [контракті](contracts/signing-chain.md).

| Поле               | Значення                                                    |
| ------------------ | ----------------------------------------------------------- |
| identity           | `adhoc` або `developer-id`                                  |
| teamId             | Team ID для `developer-id`, `null` для `adhoc`              |
| machO              | вільні Mach-O плюс головний виконуваний файл                |
| nestedBundles      | кількість вкладених бандлів                                 |
| profiles           | кількість бінарів на профіль `node`, `chromium`, `hardened` |
| notarized, stapled | стан після ланцюжка; з `adhoc` завжди `false`               |
| submissionId       | UUID подання нотаризації або `null` (після T017)            |

Інваріант: під політикою `developer-id` раннер відмовляє в publish, якщо файла немає, `identity` не `developer-id` або `teamId` не дорівнює очікуваній команді (T013).

## Запис довіри релізу

Результат `verify-macos-release-trust.mjs` для одного DMG; зберігається поряд із платформними доказами релізу.

| Поле          | `developer-id`                                                     | `adhoc-pre-048` |
| ------------- | ------------------------------------------------------------------ | --------------- |
| target        | `macos-arm64` або `macos-x64`                                      | те саме         |
| trustPolicy   | `developer-id`                                                     | `adhoc-pre-048` |
| appleTrust    | `verified`                                                         | `unverified`    |
| developerId   | `true`                                                             | `false`         |
| hardenedMachO | кількість перевірених Mach-O, включно з бінарями вкладених бандлів | відсутнє        |
| notarized     | `true`                                                             | `false`         |
| stapled       | `true` лише якщо застосунок і DMG                                  | `false`         |

Інваріант: `adhoc-pre-048` ніколи не має `notarized: true`. З T013 запис і підсумок підпису лежать у `release/beta/platform-baseline.json` як `macos[target].trust` і `macos[target].signing` (`app` лише базове ім'я).

## Аудит підпису в доказі бети

Доказ `verification.json` (схеми 2 і 3) з 048 несе обов'язкове поле `codeSigning`: `chain` = `sign-mac-app`, `identity`, `hardenedMachO` (кожен Mach-O бандла, не менше 3), `machO` (підсумок ланцюжка, не більше `hardenedMachO`), `profiles` з рівно одним `node`. Без нього доказ відкидається (`MACOS_BETA_SIGNING_UNPROVEN`).

## Подання нотаризації

| Поле   | Значення                                                                |
| ------ | ----------------------------------------------------------------------- |
| id     | UUID від Apple; після T017 входить у підсумок підпису як `submissionId` |
| status | `Accepted`, `Invalid`, `Rejected`, таймаут                              |
| log    | журнал відмови, друкується в stderr кроку і не зберігається             |

Статус і журнал живуть лише у виводі кроку пакування; ідентифікатор подання є квитанцією Apple для журналу publish.
