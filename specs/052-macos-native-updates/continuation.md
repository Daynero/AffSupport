# Відновлення розробки — 2026-11-12

## Гілка та інтеграція

- Новий worktree: `.claude/worktrees/macos-trusted-updates`, гілка `feature/macos-trusted-updates`.
- База `release/1.4.3` (`a7e30bca`), інтеграція `048-macos-apple-trust` (`b58259d9`). Старе дерево 048 та основна релізна копія збережені.
- Єдиний текстовий конфлікт — `.specify/feature.json`; покажчик переводиться на 052.
- Початкова 048 з backup збережена verbatim в `original-048-spec.md` та `original-048-evidence.md`.

## Apple readiness

Через Chrome підтверджено активне особисте членство Apple Developer Program, renewal у листопаді 2027, угоду прийнято. Команду іншої організації, яка була вибрана при вході, замінено на особисту; в чужій команді нічого не створено.

На початку сертифікатів не було, `security find-identity -v -p codesigning` повернув 0 valid identities. Існуючий CSR пройшов `openssl req -noout -verify`. Після явної згоди власника CSR надіслано Apple, Developer ID Application створено й імпортовано в login Keychain. Офіційний проміжний Developer ID G2 завантажено з Apple та імпортовано без зміни правил довіри. Після цього `security find-identity -v -p codesigning` підтвердив **1 valid identity**. Приватний ключ не експортувався. Приватні ідентифікатори, дані облікового запису та секрети сюди не записуються.

Власник явно схвалив API access, ключ Soty Notarization з роллю Developer і показані Apple умови внутрішнього використання API. Checkbox/Submit виконані після цієї згоди; Apple approved API access. Створено один Team API key з роллю Developer. Одноразове завантаження перенесено з Downloads у machine-local signing directory, mode 0600; key contents не виводились і не потрапляли в репозиторій.

`notarytool store-credentials` перевірив credentials через Apple й записав `soty-notary` у login Keychain. `macosTrustPreflight` реально пройшов з policy developer-id, чинною certificate/team pair і відповіддю notary history. Machine-local JSON містить лише key/profile references; secret лишається у private key file та Keychain.

Apple credentials і preflight доведені; реальне Apple acceptance пакета й чистий Mac запуск ще не доведені. T012 setup завершено, T014 лишається відкритим. Окремий малий trust probe (один Mach-O) підписано ланцюжком, Apple прийняла submission, staple прикріплено й validate пройдено; `spctl --assess --type execute` повернув accepted / Notarized Developer ID. Він не є пакетом Soty або clean-host acceptance. Local detailed proof: `/private/tmp/soty-048-apple-trust-grmqw3o0/`; sanitized summary у verification-integration.json.

Уточнення після перевірки ключа: реальний Developer ID signing **доведено** на тимчасовій копії `/bin/echo` поза встановленим Soty. `codesign --options runtime --timestamp --sign …` та `codesign --verify --strict` завершилися з кодом 0; прочитано прапорець `runtime`, ланцюжок Developer ID Application → Developer ID Certification Authority → Apple Root CA і secure timestamp. Це доказ доступності ключа та підпису, **не** нотаризації, Gatekeeper acceptance або production-пакета. Шлях тимчасового proof і персональна ідентичність у цей документ не переносяться.

## Наступний порядок роботи

1. Перевірити інтеграцію trust з актуальною базою; зафіксувати фактичні результати.
2. Developer ID Application отримано; valid identity і підпис фікстури/статичного Node цим ключем доведено: 47 passed, 1 notary test skipped у 7 focused файлах, JS/WebAssembly і негативний JIT контроль пройшли.
3. API consent, Developer key, Keychain profile і real preflight завершені. Далі довести Apple notary/staple на probe, потім actual packaged Soty за 048. Secret не вводиться в код/репозиторій/журнали.
4. Виконати Apple trust acceptance за 048 без production-публікації; реальні Apple/clean-host докази не замінювати ad-hoc тестами.
5. Дослідити installer та global drain, сформувати plan/tasks для 052, реалізувати A→B через failing regression і packaged beta acceptance.

## Primary references for design research

- Apple Developer ID: https://developer.apple.com/help/account/certificates/create-developer-id-certificates/
- Sparkle documentation: https://sparkle-project.org/documentation/
- Custom user driver: https://sparkle-project.org/documentation/api-reference/Protocols/SPUUserDriver.html
- Install-on-quit delegate: https://sparkle-project.org/documentation/api-reference/Protocols/SPUUpdaterDelegate.html

За `speckit-plan` завершено Phase 0 decisions і Phase 1 design: [plan](plan.md), [data model](data-model.md), [contract](contracts/native-updates.md), [validation guide](quickstart.md). Extensions hooks відсутні. Два read-only research agents перевірили Sparkle public APIs/source/archive і workload/persistence seams; runtime compatibility лишається spike gate, не pass.

## Перевірка інтеграції

Перший прогін після підключення локальних workspace dependencies: усі 14 static gates passed; suite мав 8094 passed/88 skipped, але лише 6/8 shards і один unhandled jsdom `scrollTo` error, отже FAILED. Збій відтворено окремо. У `tests/space-settings.test.tsx` додано dialog-local `scrollTo` spy і assertion top:0; ті самі 6 тестів тепер проходять без unhandled error. Product code не змінювався. Повторний suite завершив усі 8/8 shards: 10923 passed, 107 skipped, але ще два unhandled scrollTo errors в catalog-manager-settings-navigation. Product assertions пройшли; загальний gate лишився FAILED. У tests/support/setup-dom.ts додано shared Element.scrollTo compatibility shim зі зміною scroll offsets, локальний spy збережено для assertion. 10 тестів у трьох DOM файлах пройшли без unhandled errors; typecheck:tests пройшов. Typecheck і targeted ESLint пройшли. Третій suite перервано власним SIGINT лише до свого Vitest: load близько 20, ~64 MiB free physical pages і активна compression/decompression понад 14000/17000 pages/s. Інші програми не зупинялися. Збережено partial report: 2/8 completed shards, 2693 passed, 27 skipped, без assertion failures; це НЕ PASS. Повний verify треба повторити після звільнення ресурсів. Evidence summary: [verification-integration.json](verification-integration.json).

Machine-local public identity/team/notary-profile references записано в `~/Library/Application Support/Soty/signing/release-signing.env` з mode 0600. Secret у файл не записувався; notary profile validated реальним Apple запитом. Зберігається контрольний merge commit для review, без заяви про green verify або release readiness. T004 лишається відкритим до повного verify. На цьому історичному checkpoint native updater ще не був реалізований; поточний стан наведено нижче та в implementation.md.

`speckit-tasks` перетворив backlog на 34 dependency-ordered задачі: US1 8, US2 5, US3 4, US4 3, shared 14. Формат/IDs/relative links перевірено; extensions hooks відсутні. MVP потребує всіх критичних safety/recovery/diagnostic сценаріїв, не одного happy path.

## Owner-directed implementation before runs

The owner explicitly requested full implementation before any further runs. Development continued in this worktree; [implementation.md](implementation.md) maps code, regression sources and deferred native acceptance. The previous checkpoint’s verification does not cover the new edits. No acceptance checkbox was promoted from source inspection, and no production action occurred. Next session starts with verification of this implementation, not more planning or Apple enrollment setup.

## Owner-authorized bounded validation

The owner subsequently authorized testing without interfering with parallel agents and explicitly excluded this feature from the next release. Validation uses worktree-local workspace links and outputs, low-priority children, one Vitest worker, bounded heaps and host-headroom monitoring. Installed Soty, other worktrees, beta services and other agents' processes are untouched. See [validation.md](validation.md) and `verification-integration.json` for current results; full packaged acceptance and overall verify remain open.

## Checkpoint for later continuation — 2026-11-13

The owner requested committing and pushing the complete development snapshot, then returning to this work later. Save source, tests, public configuration and evidence on `feature/macos-trusted-updates`; keep private keys, signing credentials, caches and generated packages outside Git. This checkpoint does not enter the next release or claim a green full verify. Resume from [validation.md](validation.md): 803 distinct tests and 13 native checks passed, two opt-in CPU benchmarks skipped, ARM/x64 compilation passed; full verify and actual packaged A→B→C/trust/workload/transport acceptance remain open. No further test or release run is part of the checkpoint request.
