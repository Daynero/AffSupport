# Початковий аудит нативного оновлення

Дата: 2026-11-12. Це список доведених seams і відкритих рішень, не implementation plan чи native acceptance.

## Що вже є

- `packaging/Launcher.swift`: authenticated update handoff, обробка exit status, спостереження за встановленим build і `restartIntoInstalledBuild`. Це handoff після зовнішньої заміни, не download/verification/transactional installer.
- `apps/agent/src/index.ts:requestUpdateDrain`: викликає queue admission gate, чекає `modules.some(module => module.busy())`, чекає `saveChain` і завершує агент спеціальним exit code. Отже глобальний список власників роботи вже є; створювати другу систему busy обліку не слід.
- `apps/agent/src/server/tools.ts`: канонічні `ToolModule.busy`, `ToolContext.acceptingNewTasks`; team-модуль включає preview/process/poster/download/landing/library/restitch/native restitch/catalog foreground. Покриття всіх admission paths, final writes і uncertain external effects ще не перевірене.
- `apps/agent/src/queue/queue.ts`: `requestUpdateDrain` і стани none/pending/draining. Поточний механізм завершує процес після idle; це не reversible defer/cancel до підтвердження installer commit. Нативний намір потребує окремого durable lifecycle, який делегує admission наявному seam.
- `apps/agent/src/server/app.ts`: `/native/update/drain` захищений окремим handoff secret, який не тотожний browser session token. Новий web intent не повинен розкривати цей secret.
- `051`: next є production-data preview, promote архівує/активує точні байти. Update metadata не може перетворити next на сторонній stable updater канал.

## Installer research

Офіційна [документація Sparkle](https://sparkle-project.org/documentation/) описує programmatic setup, custom UI й існуючі archive formats. Це кандидат, який може зменшити власний код заміни та OS authorization. Водночас [SPUUserDriver](https://sparkle-project.org/documentation/api-reference/Protocols/SPUUserDriver.html) і [SPUUpdaterDelegate](https://sparkle-project.org/documentation/api-reference/Protocols/SPUUpdaterDelegate.html) описують install-on-quit. Треба експериментально довести, що «Пізніше», звичайний quit і падіння не встановлюють завантажений кандидат без прийнятого наміру Soty.

Перед прийняттям залежності потрібні:

1. Зафіксовані version/hash/license, ARM/x64 binaries і мінімальна macOS; підтверджена збірка Swift launcher та seal framework/XPC/helper через 048, без широкого entitlement exception.
2. Доказ binding конкретного кандидата до чинного signed manifest: appcast або інша metadata сама по собі не замінює release policy; EdDSA updater key, якщо потрібен, окремий від entitlement/release key.
3. Capability negotiation та authenticated local command path без довільних URL/path; одна accepted operation на installation/candidate.
4. Spike download→verified→explicit install consent→global drain→native install/relaunch. Реальний A→B, а не mock API callback.
5. Fault injection до/після commit і першого запуску, build readiness, збереження user profile, локальний durable journal та eventual CLI diagnosis. Sparkle callback сам по собі не доводить readiness агента.

До цих доказів не додаються production feed, updater capability чи автоматична заміна встановленого Soty.

## Phase 0 decisions — 2026-11-12

### D1: Sparkle лише після згоди

**Decision:** pin [Sparkle 2.10.1](https://github.com/sparkle-project/Sparkle/releases/tag/2.10.1), official tar SHA-256 `1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27`. Research agent перевірив завантаження у пам'яті та FAT headers: framework, Autoupdate, Updater і XPC мають ARM64/x64; minimum OS 12 сумісний із Soty 13. Це не runtime acceptance Soty.

**Rationale:** mature native replacement/OS authorization, але автоматичне завантаження Sparkle одразу переходить до extraction і може встановлювати при звичайному quit. Delegate delay не є veto: [source](https://github.com/sparkle-project/Sparkle/blob/2.10.1/Sparkle/SPUCoreBasedUpdateDriver.m#L166-L183), [delegate](https://sparkle-project.org/documentation/api-reference/Protocols/SPUUpdaterDelegate.html).

Soty робить predownload самостійно. `SUEnableAutomaticChecks`, `SUAutomaticallyUpdate`, `SUAllowsAutomaticUpdates` вимкнені. Native host створює updater лише для durable consented attempt після global workload barrier. Standard automatic download та власний privileged installer відхилені: перший порушує згоду, другий додає непотрібний security/recovery surface.

### D2: Bounded повторний download і dual signature binding

**Decision:** перша реалізація чесно показує друге HTTPS-завантаження після згоди. Публічного archive injection немає, [Downloader](https://github.com/sparkle-project/Sparkle/blob/2.10.1/Downloader/SPUDownloader.m#L65-L80) відхиляє file URLs. Private cache API відхилені; authenticated loopback relay — пізніша оптимізація.

Canonical signed Soty manifest розширюється native descriptor: target/build/source, immutable archive URL, length, SHA-256 і Sparkle EdDSA archive signature. Single-candidate feed формується лише з verified descriptor. Strict `shouldProceedWithUpdate` звіряє enclosure через public `propertiesDictionary`; Sparkle перевіряє actual second download його EdDSA signature. Окремий appcast із непов'язаним підписом не доводить відповідність stable SHA. Descriptor входить у exact archived/promoted bytes 051, іншого stable authority немає.

### D3: Reversible canonical drain і persistence barrier

**Decision:** `AgentUpdateCoordinator` додає epoch-owned hold, admission permits до першого await, scheduler quiesce і tracked flush поверх canonical ToolModule list. Другий busy registry не потрібен.

**Evidence:** `index.ts:976` exits одразу після idle; queue state memory-only, без reset/defer. RecoveryWorker `allowed` на `index.ts:684` не враховує drain, directory-intake не отримує predicate, waiting catalog tasks можуть attach пізніше. `saveChain.finally` дозволяє exit після persistence failure, stitcher save promise не відстежується. Це обов'язковий implementation scope.

Pause new claims/ticks/attach без abort, let accepted work settle; await permits=0, canonical busy=0, durable flush, recheck epoch. `drained` receipt ще reversible і не exits. Defer відпускає лише власний hold; native commit запускає штатний update exit. Unknown external effects reconcile через чинні ownership receipts. Legacy native drain лишається compatibility path. Shutdown-as-drain, compressor-only idle і independent booleans відхилені.

### D4: Native authority й окремі receipt writers

**Decision:** launcher owns installation lock/candidate/consent/native journal, agent owns workload receipt. Owner-only Unix socket із per-boot child secret; browser передає лише IDs/revision, не paths/URLs/native token. Platform seam owns paths/capability. Native перевіряє P-256 signature над точними canonical payload bytes і derive candidate з verified payload, а не довіряє окремим полям Node. Generated public key/build inputs походять із shared contract.

Single writer на кожен namespace, atomic write/flush/rename із parent durability. Два writers одного JSON, browser handoff secret, arbitrary executable command та reconnect-as-success відхилені. Native-ready і UI-visible різні receipts.

### D5: Signing та diagnostics не відкладені

048 нині пропускає loose Mach-O усередині nested framework. До embedding Sparkle ланцюжок підписує й атестує кожний helper/binary, потім nested app/XPC/framework і host. Generic preserve-entitlements не дозволяє нові exceptions. Unused XPC видаляються лише до seal за [official guidance](https://sparkle-project.org/documentation/sandboxing/), зі збереженням ліцензій та target proof.

Dependency helpers also need a power-budget proof: Sparkle spawning them does not imply they entered the existing governor. Before enabling the adapter, prove supported platform registration/ownership of heavy extraction work while the governor remains alive, throttle-scaled deadlines and safe termination; otherwise block integration. No second duty-cycle controller or implicit 100%-CPU exemption is introduced.

`update.run` capability inventory прямо має producer gap; `updates` counts не доводять A→B. Receipt-based diagnosis розширює read-only CLI, closed codes/code map і producer→transport→CLI tests. Offline local receipts не залежать від analytics delivery.

Технічні рішення Phase 0 визначено; native bridge, signing, consent/quit та fault spikes лишаються обов'язковими доказами реалізації, а не заявленими runtime pass.
