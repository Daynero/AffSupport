# Contract: ланцюжок підпису `scripts/sign-mac-app.sh`

## Виклик

```
zsh scripts/sign-mac-app.sh <App.app>
```

Підписує бандл на місці. Друкує один рядок JSON у stdout і виходить із 0; будь-яка відмова виходить ненульовим кодом із закритим кодом причини в stderr. Жодних часткових результатів: відмова після підпису, але до staple, лишає бандл підписаним, але без квитка, і це видно в коді відмови.

## Середовище

| Змінна                         | Значення                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `SOTY_SIGNING_IDENTITY`        | ідентичність для `codesign --sign`; `-` типово, тобто ad-hoc                                                    |
| `SOTY_SIGNING_KEYCHAIN`        | шлях до keychain з ідентичністю; необов'язково                                                                  |
| `SOTY_SKIP_NOTARIZATION`       | `1` вимикає нотаризацію і staple; обов'язково для ad-hoc                                                        |
| `SOTY_NOTARY_KEYCHAIN_PROFILE` | ім'я профілю `xcrun notarytool store-credentials`; обов'язково, коли нотаризація не вимкнена                    |
| `SOTY_ENTITLEMENTS_DIR`        | каталог профілів; типово `packaging/macos/entitlements`                                                         |
| `SOTY_NOTARY_TIMEOUT`          | скільки чекати Apple у `notarytool --wait`; типово `30m`, у межах 45-хвилинного бюджету кроку пакування раннера |

Жодне значення не читається з трекнутих файлів.

## Порядок

1. Перевірити бандл: `Contents/Info.plist` із `CFBundleExecutable`, наявність усіх файлів профілів.
2. Знайти всі Mach-O за magic-байтами одним проходом; виключити головний виконуваний файл і вміст вкладених бандлів.
3. Для кожного вільного Mach-O: зняти чужий підпис, підписати за профілем з `--options runtime`.
4. Для кожного вкладеного бандла, глибший спочатку: `.appex` Finder-розширення з його sandbox-файлом; інший вкладений бандл зі збереженням його власних entitlements.
5. Підписати застосунок із профілем `launcher`.
6. Перевірити: `codesign --verify --deep --strict`; кожен Mach-O має прапорець `runtime`; з Developer ID кожен має `Timestamp=` і `Authority=Developer ID Application`, а його `TeamIdentifier=` збігається з застосунком (T017); ключі entitlements кожного Mach-O збігаються з профілем; заборонених немає.
7. Якщо нотаризація не вимкнена: zip через `ditto`, `notarytool submit --wait`, `stapler staple`, `stapler validate`, `spctl --assess --type execute`.

## Таблиця профілів

| Профіль            | Відбір                                        | Ключі                                                                                       |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `launcher`         | головний виконуваний файл через підпис бандла | жодного                                                                                     |
| `node`             | `Contents/Resources/runtime/node`             | `com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory` |
| `chromium`         | базове ім'я `chrome-headless-shell`           | ті самі два                                                                                 |
| `hardened`         | решта вільних Mach-O: engines, dylib          | жодного                                                                                     |
| `finder-extension` | `*.appex` з id `*.finder-extension`           | `com.apple.security.app-sandbox`, `com.apple.security.files.user-selected.read-only`        |

Заборонені в усіх: `com.apple.security.cs.disable-library-validation`, `com.apple.security.cs.allow-dyld-environment-variables`, `com.apple.security.cs.disable-executable-page-protection`, `com.apple.security.get-task-allow`.

## Timestamp

`--timestamp` з іменованою ідентичністю, `--timestamp=none` з ad-hoc. Недоступний сервер часу зупиняє підпис; продовження без timestamp немає.

## Коди відмов

| Код                          | Коли                                                                   |
| ---------------------------- | ---------------------------------------------------------------------- |
| `SIGN_INPUT_INVALID`         | не бандл, нема Info.plist або головного виконуваного файла             |
| `SIGN_ENTITLEMENTS_MISSING`  | нема файла профілю                                                     |
| `SIGN_ADHOC_CANNOT_NOTARIZE` | ad-hoc без `SOTY_SKIP_NOTARIZATION=1`                                  |
| `NOTARY_PROFILE_REQUIRED`    | іменована ідентичність, нотаризація не вимкнена, профіль не заданий    |
| `SIGN_FAILED`                | `codesign` повернув помилку                                            |
| `SIGN_VERIFY_FAILED`         | перевірка після підпису: прапорець, timestamp, authority, entitlements |
| `NOTARIZE_FAILED`            | подання не `Accepted`; журнал Apple надруковано                        |
| `STAPLE_FAILED`              | staple або його валідація не вдалися                                   |
| `GATEKEEPER_REJECTED`        | `spctl` відхилив підписаний і степлений застосунок                     |

## Вивід

```json
{
  "app": "/path/Soty.app",
  "identity": "adhoc",
  "teamId": null,
  "machO": 8,
  "nestedBundles": 1,
  "profiles": { "node": 1, "chromium": 1, "hardened": 5 },
  "notarized": false,
  "stapled": false
}
```

`identity` є `adhoc` або `developer-id`. `machO` рахує вільні Mach-O разом із головним виконуваним файлом, тож дорівнює сумі профілів плюс один; бінарі вкладених бандлів входять у `nestedBundles`, не в `machO`. Гейт натомість рахує в `hardenedMachO` кожен Mach-O бандла, включно з бінарями вкладених, тому для Soty 1.3.2 ланцюжок дає 10, а гейт 11; раннер (T013) порівнює не кількості, а вид ідентичності й команду. Після T017 рядок також містить `"submissionId"`: UUID подання нотаризації або `null`, щоб журнал publish тримав квитанцію Apple без повторного звернення. Пакувальники зберігають цей рядок як `signing.json` поруч з артефактом (T008, T010); це «підсумок підпису» зі спеки.

## Гейт релізу

`scripts/verify-macos-release-trust.mjs <dmg> --arch=<arm64|x64>` під `developer-id` додатково до чинних перевірок вимагає прапорець `runtime` на кожному Mach-O застосунку, відсутність заборонених entitlements, після T017 також `TeamIdentifier=` очікуваної команди і `Timestamp=` на кожному Mach-O, і `stapler validate` на застосунку та на DMG. Коди: `MACOS_HARDENED_RUNTIME_MISSING: <шлях>`, `MACOS_ENTITLEMENT_FORBIDDEN: <шлях> <ключ>`, після T017 `MACOS_MACHO_SIGNER_MISMATCH: <шлях>`. Політика `adhoc-pre-048` не змінюється.

## Пакувальники і раннер

- `scripts/package-mac.sh` викликає ланцюжок після `release.json`, `runtime-inputs.json` та `AppIcon.icns` і до `ditto`, зберігає підсумок як `signing.json` у корені цілі (`release/`, `release/x64/`). З ідентичністю `-` він вимагає явного `SOTY_MACOS_TRUST_POLICY=adhoc-pre-048` або `SOTY_SKIP_NOTARIZATION=1`, інакше зупиняється з `SIGN_IDENTITY_REQUIRED`; неявного відкату до ad-hoc немає. `package-dev-mac.sh` і `package-beta-mac.sh` завжди підписують ad-hoc через ланцюжок і теж пишуть `signing.json`.
- `scripts/package-dmg.sh` з іменованою ідентичністю підписує образ із timestamp, вимагає степлений застосунок усередині, подає образ у `notarytool --wait`, степлить, валідує і перевіряє `spctl --type open`; SHA-256 образу рахується лише після staple. З `-` ті самі умови явності, образ лишається непідписаним.
- `scripts/audit-macos-signing.mjs <App.app> --signing=<signing.json> [--team=<TEAMID>]` перевіряє hardened runtime і заборонені entitlements на кожному Mach-O та відповідність підсумку бандлу; `verify-beta-package.sh` і `record-macos-beta-proof.mjs` вбудовують результат у доказ бети як `codeSigning`, без якого `validateMacosBetaEvidence` відкидає доказ (`MACOS_BETA_SIGNING_UNPROVEN`).
- Раннер (`scripts/lib/release/step-adapter.mjs`): крок `macos_package` починається з preflight (`macos-trust-preflight.mjs`): під `developer-id` потрібні `SOTY_SIGNING_IDENTITY`, `MACOS_EXPECTED_TEAM_ID`, `SOTY_NOTARY_KEYCHAIN_PROFILE`; ідентичність має бути в списку `security find-identity -v`, OU її сертифіката дорівнює команді, сертифікат не прострочений, `notarytool history` відповідає. Коди: `MACOS_TRUST_INPUTS_MISSING`, `MACOS_TRUST_IDENTITY_MISSING`, `MACOS_TRUST_TEAM_MISMATCH`, `MACOS_TRUST_IDENTITY_EXPIRED`, `MACOS_TRUST_NOTARY_PROFILE_INVALID`. Крок `publish` читає запис гейта з його stdout і `signing.json` поруч з образом як `unknown` (`scripts/lib/macos-signing-summary.mjs`), вимагає їх згоди з політикою (`MACOS_SIGNING_SUMMARY_REQUIRED`, `MACOS_SIGNING_IDENTITY_ADHOC`, `MACOS_SIGNING_TEAM_MISMATCH`, `MACOS_SIGNING_NOT_NOTARIZED`, `MACOS_SIGNING_POLICY_CONFLICT`) і журналить події `macos_trust_preflight` та `macos_trust`; `manifest_beta_verify` переносить їх у `release/beta/platform-baseline.json` як `macos[target].trust` і `macos[target].signing`, а під `developer-id` без них зупиняється (`MACOS_TRUST_RECORD_MISSING`).
