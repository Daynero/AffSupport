# Baseline та зовнішні залежності

Дата перевірки: 2026-11-05. Це evidence для специфікації, не технічний план і не підтвердження готового оновлювача.

## Що доведено локально

| Доказ                                                        | Спостереження                                                                     | Наслідок для специфікації                                                           |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `scripts/package-mac.sh`, фінальне підписування              | `codesign --sign -`, ad-hoc; runtime/node також перепідписується ad-hoc           | Потрібен справжній Developer ID та перевірка всіх вкладених executable              |
| `scripts/build-finder-extension.sh`                          | Finder extension підписаний ad-hoc, має sandbox-entitlements                      | Підписування extension і його permissions — окреме приймання                        |
| `scripts/verify-package.sh`                                  | Перевіряє цілісність signature та функції пакета, без Apple acceptance/Gatekeeper | Поточний зелений package-check не доводить нотаризацію                              |
| `security find-identity -v -p codesigning`                   | 0 valid identities у доступних Keychain                                           | Немає доказу готового signing identity; це не доводить відсутність членства Apple   |
| `xcrun --find notarytool`                                    | Інструмент доступний у встановленому Xcode                                        | Самої наявності інструмента недостатньо: потрібні членство/повноваження/credentials |
| `apps/web/src/release-manifest.ts`                           | Web перевіряє підпис stable manifest                                              | Є базова довіра web; native install має перевіряти незалежно                        |
| `apps/web/src/components/ReleaseUpdateNotice.tsx`            | Основна дія є посиланням download                                                 | Повний native download/install за web-командою ще не реалізований                   |
| `apps/web/src/locales/uk.ts`, `releaseNoticeInstruction`     | Пропонує завантажити й замінити Soty в Applications                               | Чинний шлях ручний, потрібен bootstrap для legacy                                   |
| `packaging/Launcher.swift`, installed-build monitoring       | Помічає замінений release.json, очікує роботу, координує restart                  | Є частина handoff, але це не доказ безпечного автоматичного install                 |
| `apps/agent/src/index.ts`, `queue/queue.ts`, `server/app.ts` | Є update drain та стани pending/draining                                          | Треба перевірити повноту глобального busy, черг і background-work                   |
| `packaging/Info.plist`, production packaging                 | Наявні історичні bundle identifiers і Apple Silicon/macOS 13 target               | Не перейменовувати identity навмання; перевірити безпечний перехід та permissions   |

Наявні непов'язані untracked матеріали, зокрема `specs/047-catalog-reliability/` і три документи в `docs/`, не змінювалися. Порядковий номер 048 отримано після сканування `specs/`. Активний шаблон — `.specify/templates/spec-template.md`: локальних preset/extension overrides не знайдено, `specify` CLI у PATH відсутній. `.specify/extensions.yml` відсутній, pre/post hooks не застосовуються. Активний покажчик `.specify/feature.json` переведений на цю специфікацію за workflow skill.

## Офіційні джерела

- [Apple: Program enrollment](https://developer.apple.com/help/account/membership/program-enrollment/) — тип заявника, належні юридичні дані та повноваження; organization має додаткові вимоги, зокрема D-U-N-S. Тип реєстрації не можна вивести лише з назви Soty.
- [Apple: Enrolling in the app](https://developer.apple.com/help/account/membership/enrolling-in-the-app/) — потрібен Apple Account із 2FA; можливі ID verification та особисті підтвердження, окремо згода й оплата. Точний доступний шлях залежить від регіону/акаунта. Повністю нульову особисту участь обіцяти не можна.
- [Apple Developer Program](https://developer.apple.com/programs/) — базова річна ціна $99; фактичні currency/tax/renewal перевіряються перед оплатою, членство не купувалося.
- [Apple: Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) — Developer ID, hardened runtime та автоматична перевірка Apple для розповсюдження поза App Store. Це не App Store review і не гарантія відсутності всіх дефектів.
- [Apple: Customizing notarization](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow) — submission/status/log і stapling; ZIP не є прямою ціллю stapling. Фінальна послідовність app/archive/DMG і перевірки точних байтів має бути доведена в плануванні.
- [Apple: Hardened runtime](https://help.apple.com/xcode/mac/current/en.lproj/devf87a2ac8f.html) — необхідні runtime protections і лише потрібні exceptions. Сумісність вкладених runtime-компонентів не доведена до реального тесту.
- [Apple: App code signing](https://support.apple.com/en-lamr/guide/security/sec3ad8e6e53/web) — Gatekeeper і довіра для app поза App Store. Стандартний download-confirmation не тотожний блокуванню невідомого розробника.
- [Sparkle: Documentation](https://sparkle-project.github.io/documentation/) та [Customization](https://sparkle-project.github.io/documentation/customization/) — можливий native-механізм signed updates та background download/install. Це кандидат для технічного дослідження, не вже прийнята залежність і не гарантія сумісності з Soty.

## Висновок і межі доказів

Технічна можливість обґрунтована моделлю Apple для зовнішніх macOS-app і наявним native launcher. Реальна нотаризація, потрібні entitlements, міграція довіри/permissions, повнота busy і recovery ще не перевірені. Вони є предметом плану й acceptance; сам факт написання специфікації їх не закриває. Не проводили signup, оплату, випуск/відкликання сертифікатів, production-release або зміну каналу.
