# Feature Specification: Soty для Intel Mac

**Feature Branch**: `049-macos-intel-support`; isolated worktree `AffSupport-049-intel`.
**Created**: 2026-11-05
**Status**: Implementation authorised; owner-ratified Intel user-feedback acceptance from 2026-11-07. Production activation remains separately gated.
**Input**: Додати до Soty застосунок для Intel Mac; підготувати спеку, план, задачі, аналіз та виправити неузгодженості документів.

## User Scenarios & Testing _(mandatory)_

### User Story 1 — Встановити та використовувати Soty на Intel Mac (Priority: P1)

Користувач Intel Mac встановлює окрему Intel-збірку й користується чинними локальними інструментами, авторизацією та командною роботою. Інша архітектура не створює інший продукт чи окремий акаунт.

**Why this priority**: завантажений пакет має справді виконувати роботу на Intel.
**Independent Test**: до релізу виконати static/source/config/signature qualification без Intel-хоста; наведені runtime-сценарії перевіряють перші Intel-користувачі після релізу. Невиконане лишається unverified.

**Acceptance Scenarios**:

1. **Given** Intel Mac із macOS 13 або новішою та без developer toolchain, **When** встановлено Intel-пакет, **Then** Soty запускається, підключається, проходить справжню авторизацію та entitlement і виконує всі заявлені для macOS можливості.
2. **Given** набір відео, аудіо й landing fixtures, **When** користувач виконує compression, stitching/restitch, transcription, landing preview/optimization і team background render, **Then** отримує доступний результат кожної операції; відсутній engine не видається за успіх.
3. **Given** активна операція, **When** користувач скасовує її або знижує power ceiling, **Then** діють чинні правила cancellation, cleanup і загального CPU budget без пошкодження результатів.
4. **Given** наявні налаштування та завантажені моделі Soty, **When** встановлено відповідну архітектурі нову версію, **Then** вони збережені, копії Soty не конкурують за одну установку.

### User Story 2 — Завантажити й отримувати сумісні версії (Priority: P1)

Користувач бачить окремі зрозумілі варіанти Mac (Apple Silicon) та Mac (Intel). Відомості підключеного агента визначають сумісність; невідомий процесор не маскується під Apple Silicon.

**Why this priority**: правильний пакет має бути доступний і залишатися правильним після наступного релізу.
**Independent Test**: перевірити вибір завантаження й update candidate на фікстурах підписаного каналу для Intel, ARM, Windows, legacy й unknown без записів production.

**Acceptance Scenarios**:

1. **Given** підключений Intel-агент та browser identity з іншою архітектурою, **When** відкрито встановлення/оновлення, **Then** пропонується Intel-артефакт перевіреного каналу.
2. **Given** непідключений або legacy агент без достовірної архітектури, **When** користувач відкриває завантаження Mac, **Then** обирає Intel/Apple Silicon явно; browser user-agent не доводить архітектуру пристрою.
3. **Given** Intel-артефакт відсутній, пошкоджений чи не пройшов перевірку каналу, **When** запитується Intel-версія, **Then** її недоступність пояснена без підстановки ARM-пакета.
4. **Given** підключений Intel-агент, **When** перевіряється наступна версія, **Then** кандидат зберігає Intel-архітектуру; automatic install доступний лише за перевіреної native capability із feature 048, інакше показано штатний installer-перехід.

### User Story 3 — Випускати та діагностувати три платформи (Priority: P2)

Власник отримує один повний реліз для Apple Silicon, Intel та Windows і пояснення Intel-проблем через read-only CLI без відкривання dashboard.

**Why this priority**: підтримка має переживати наступні релізи, а відсутній Intel-доказ не може стати успішним випуском.
**Independent Test**: dry-run релізних контрактів із трьома артефактами та fault fixtures; діагностичний end-to-end fixture від producer до CLI.

**Acceptance Scenarios**:

1. **Given** кандидат одного commit і build identity, **When** один із трьох обов'язкових артефактів або відповідний йому macOS beta / Windows validation proof відсутній/застарілий, **Then** final promotion відхилено; підробити Intel-proof ARM-прогоном неможливо.
2. **Given** успішний download без startup або startup без visible result, **When** агент розслідує спробу, **Then** називає останню доведену стадію, відокремлює browser і native architecture та не стверджує delivery.
3. **Given** delayed/missing signals, cancellation, offline restart або retry, **When** CLI читає зафіксований snapshot, **Then** повертає конкретну причину або explicit insufficient із прогалиною та межами вибірки.

### Edge Cases

- ARM browser user-agent на Intel; Intel user-agent на ARM; remote browser; legacy agent без architecture.
- Запуск Intel-пакета на Apple Silicon під трансляцією не доводить Intel acceptance і не дозволяє автоматичний перехід між архітектурами.
- Змішані native binaries, embedded browser helpers або сторонні dynamic libraries; engine з вимогою непідтримуваних CPU instructions.
- Немає вільного місця, відмовлено в доступі, engine не запускається, частковий download, скасування, sleep/restart, немає аналітики.
- macOS старша за заявлений мінімум; артефакт старого каналу не містить Intel; x64/arm64 jobs перезаписують спільні staging paths.
- Наявні непідписані legacy установки та ще нереалізована 048: architecture support не доводить Apple trust або готовність automatic update.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: Soty MUST надавати окремий інсталяційний пакет Intel Mac для macOS 13+ із тією самою product/build identity та набором контрактів, що ARM і Windows того самого релізу. Universal-пакет і старіші macOS поза scope.
- **FR-002**: Кожний виконуваний компонент пакета MUST бути сумісний із Intel та заявленим мінімумом OS/CPU, включно з локальними engines, browser helpers і Finder integration; встановлені Homebrew, Node чи developer tools не можуть бути залежністю користувача.
- **FR-003**: Intel MUST підтримувати чинні macOS можливості. Об'єктивно недоступна можливість потребує explicit capability, stable machine reason і приховування відповідної дії; мовчазне вилучення функцій неприпустиме.
- **FR-004**: Intel MUST зберігати чинні auth/entitlement, user data/settings/models, single-instance, cancellation і shared power-budget правила. 100% power не змінює поведінку наявних платформ.
- **FR-005**: Кожна поверхня завантаження Mac MUST дозволяти явний Intel/Apple Silicon вибір; достовірний connected agent визначає сумісний варіант, невідомий host потребує вибору. Browser identity є окремою підказкою, не доказом native host.
- **FR-006**: Відсутній/неперевірений Intel-артефакт MUST означати unavailable; завантаження й update MUST не підставляти ARM/Windows та не довіряти довільному URL.
- **FR-007**: Наступні версії MUST зберігати архітектуру встановленого runtime. Automatic install/restart використовує лише native capability та trust/recovery контракти 048 після їх реалізації; до того — чинне ручне встановлення без неправдивої обіцянки автоматизації.
- **FR-008**: Пакування dev, beta й production MUST приймати явну target architecture, відокремлювати артефакти/тимчасові дані та відхиляти невідомий target до побічних ефектів. Dev auth та вимкнена аналітика не потрапляють до beta/production.
- **FR-009**: Повний Intel-enabled release MUST мати три артефакти одного релізу: ARM native packaged-beta proof, Intel exact-source/config/sealed-package static qualification за `intel-user-feedback-v1` і чинний Windows hosted validate/install/use proof. Historical platform sets, immutable assets і final-byte verification зберігаються.
- **FR-010**: За рішенням власника 2026-11-07 фізичні Intel macOS 13.0/newer та native Intel beta-тести НЕ є передумовою релізу. MUST пройти автоматичні static/payload/signature/source/config gates; runtime/hardware залишаються `unverified` до реальних user reports. Статичну перевірку чи трансляцію не можна назвати physical pass.
- **FR-011**: Apple signing/notarization та native update acceptance MUST бути узгоджені з 048 для кожної архітектури; Intel acceptance саме по собі не доводить trust. Перший публічний Intel-реліз потребує виконання застосовних trust gates 048.
- **FR-012**: Зміни MUST зберігати працездатність Apple Silicon, Windows і web-only mini-release gates, immutable assets, shared contract origin та правила явної production activation; ця документація не дозволяє deployment.
- **FR-013**: Діагностика MUST відновлювати architecture-specific download/startup/readiness/tool-result/update journeys, із кореляцією attempts, failure codes, cancellation/interruption/recovery, delivered outcome та explicit unknown, відповідно до наступного розділу. Потрібні автоматизовані regression tests і packaged acceptance.

### Analytics & Diagnostic Coverage _(mandatory)_

Наслідується [031](../031-platform-autoanalytics/spec.md). Очікувані стадії: download choice → download requested → native boot → link/auth/entitlement → engine readiness → operation accepted → terminal → result visible. Для update: candidate selected → installer handoff або native stages 048 → boot/readiness потрібної build → UI confirmation. Окремі opaque flow/attempt/run IDs корелюють лише доведений зв'язок; новий retry має новий attempt. Завантаження з іншого browser/пристрою без correlation не приєднується евристично.

Окремі факти: browser platform/architecture, agent platform/runtime architecture, package target, product/build identity. Старі події не отримують вигадану Intel-атрибуцію. x64 runtime на ARM під трансляцією позначається окремо або physical host залишається unknown. Нові сигнали мають пройти typed producer → sanitizer/ingestion → storage → read-only query → diagnosis; capability inventory і code map оновлюються разом із причинами.

Success інструмента потребує terminal і evidence видимого результату; file open поза Soty не спостерігається. Download click не доводить download bytes/install; відсутність boot не доводить OS rejection. До старту агента fallback — локальний privacy-safe bundle/пакувальний proof зі stage та machine reason, без контенту, raw paths, secrets або provider payloads. Beta не відправляє production analytics: локальні artifacts і ізольовані ingestion/CLI fixtures доводять pipeline.

Приймання: healthy Intel/ARM/Windows controls, wrong architecture, engine launch failure, missing artifact, explicit cancel, interrupted boot/update, recovered retry, delayed/missing terminal, browser/agent mismatch. `investigate`, `inspect`, `audit` і architecture cohorts повертають останню доведену стадію та fact/hypothesis/insufficient, delivery lag, truncation і coverage. Новий unknown code або critical unverified gap блокує готовність.

### Key Entities _(include if feature involves data)_

- **Platform artifact**: product/build, target, immutable URL, digest, trust evidence.
- **Runtime identity**: installation/agent instance, OS, runtime architecture; browser identity незалежна.
- **Packaged acceptance proof**: exact source, environment, target, sealed package bytes, acceptance level, static evidence та окремі реально спостережені runtime outcomes.
- **Diagnostic attempt**: opaque correlations, stage, outcome/reason, evidence source, observation/delivery time й missing evidence.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Intel package проходить обов’язкову статичну target/deployment/dependency/signature перевірку і exact-source qualification без Intel-хоста. Runtime-сценарії на мінімальній і новішій OS перевіряють перші користувачі; outcomes залишаються unknown до спостереження.
- **SC-002**: 100% контрольних Intel/ARM/Windows/legacy/unknown/mismatched identity випадків пропонують сумісний перевірений пакет або пояснений вибір/unavailable; жодної мовчазної підстановки.
- **SC-003**: Усі missing/stale/wrong-target/digest/trust proof сценарії блокують promotion; повний кандидат має три перевірені артефакти одного релізу.
- **SC-004**: У 100% контрольних diagnostic journeys CLI відтворює правильну останню доведену стадію й outcome або конкретну сліпу зону; немає хибного success чи Intel-атрибуції.
- **SC-005**: ARM і Windows контрольні install/use/update-selection сценарії проходять; дані збережені, active work не вбивається, жодних неавторизованих production side effects.

## Assumptions

- Окремий Intel DMG — початковий формат. Один бренд, акаунт, support directory і модель даних; перенесення між різними комп'ютерами не додається.
- macOS 13 — поточний deployment minimum репозиторію; OS/CPU claim підтверджується dependency inventory і реальними тестами до release, а не самим Swift target. Якщо залежність не працює, спочатку добирається сумісний build; звуження підтримки потребує зміни спеки.
- Intel hardware не потрібне для pre-release qualification; portable inputs та Apple trust залишаються prerequisites. Реальні Intel runtime outcomes збираються після релізу.
- Feature 048 залишається власником signing/updater механізму; її виключення нових архітектур стосується власного MVP, 049 додає Intel окремим наступним increment без редагування сусідньої спеки.
- Власник 2026-11-06 дозволив переперевірити/доповнити документи та одразу реалізувати повну підтримку в ізольованому worktree. Production release і купівля сервісів не дозволені; Apple trust залишається обов’язковим. Рішення 2026-11-07 замінює hardware/native-Intel prerequisite моделлю [user feedback](release-policy.md); воно не дозволяє production activation.

## Implementation refinement — 2026-11-07

Intel runtime pins use Node 22.23.4 LTS to preserve the macOS 13.0 floor (the available Node 24 x64 binary requires 13.5). FFmpeg 7.1.1/x264 and Whisper 1.9.1 are built statically with one worker and conservative CPU flags. The actual Chromium revision 1234 x64 archive has macOS 13.0 deployment targets. Version, source and SHA-256 pins are recorded in `packaging/macos/inputs.json`; generated input provenance is immutable per target.

New full-release manifests declare platform set version 2 and require all three platforms. Existing authenticated historical manifests retain their historical set. Both Mac beta proofs bind exact source, public config, agent payload, package metadata and web payload. Intel uses sealed schema-3 static qualification under `intel-user-feedback-v1`; native runtime/hardware remain unverified and are exercised by users after release. Windows proof binds the hosted run, smoke installer and final published installer. Complete mini-release baselines bind these proofs to the signed channel without rebuilding installers.

Pre-server diagnostic fallback is a bounded local launcher journal (32 records, 32 KiB, closed codes/stages, no paths/content). The native startup UUID is carried separately through health, typed events, SQL guard and CLI diagnosis. `analytics startup <file> --json` reads exported local evidence without database writes. Missing evidence remains insufficient; no client can prove OS refusal before it runs. Apple trust remains mandatory; physical Intel acceptance is post-release user feedback and is never inferred from cross-compilation.

Installer request intent uses the closed `installer_target` property. Observed `package_target`, native architecture and startup UUID come only from captured native health context. CLI exposes `requested_installer_targets` separately from installed identity; an installer click never establishes installation, native hardware or result delivery. Guard extension is forward-only in `20261207190000_agent_native_identity_analytics.sql` (single migration, renumbered after 047 by review-claude.md); no table/RPC shape or generated database types change.
