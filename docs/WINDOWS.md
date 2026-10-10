# Windows release pipeline

Soty ships on Windows x64 from the same codebase as macOS. The installer is
produced entirely by GitHub Actions on a `windows-2022` runner — **no Windows
machine is required**, which is the whole point: the maintainer does not own
one.

The build is intentionally **unsigned**, matching the macOS build (ad-hoc
signature, no notarization). SmartScreen will warn every early downloader; the
download page tells them exactly what to click.

## The short version

```sh
# 1. Check the pinned third-party inputs (works from macOS)
node scripts/fetch-windows-inputs.mjs --verify-only

# 2. Build the installer in CI
gh workflow run release-windows.yml --ref <branch>
gh run list --workflow release-windows.yml --branch <branch> --limit 3
npm run release:watch -- <run-id>

# 3. Download and inspect the artifact
gh run download <run-id> --name windows-installer
```

Publishing (attaching to the release tag) is the `publish: true` input on the
same workflow. Recording the checksum into the signed manifest happens **on the
maintainer's Mac**, never in CI — see "Signing" below.

## Pieces and where they live

| Piece                     | Path                                          | Notes                                                             |
| ------------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| Pinned third-party inputs | `packaging/windows/inputs.json`               | sha256 + size for every bundled file                              |
| Input downloader          | `scripts/fetch-windows-inputs.mjs`            | verifies before use; `--verify-only` needs no network writes      |
| Input mirroring           | `.github/workflows/mirror-windows-inputs.yml` | snapshots upstream into an immutable `windows-inputs-<n>` release |
| Payload staging           | `scripts/stage-windows-runtime.mjs`           | mirrors the macOS `Contents/Resources` layout                     |
| Tray host                 | `packaging/windows/SotyAgentHost`             | .NET 8 WinForms, supervises the Node agent                        |
| Installer template        | `packaging/windows-installer.iss`             | Inno Setup 6, `iscc` is preinstalled on the runner                |
| Package checks            | `scripts/verify-windows-package.mjs`          | layout, PE architecture, release identity                         |
| Unattended smoke          | `scripts/windows-smoke.mjs`                   | install → use → uninstall, the CI gate                            |
| Build workflow            | `.github/workflows/release-windows.yml`       | the whole pipeline                                                |

## Pinned inputs

Every third-party file is pinned by exact sha256 and byte size. The downloader
verifies size, then hash, then archive-member presence, and aborts the build on
any mismatch — an unverifiable byte never reaches an installer.

Currently pinned:

| Input                                                    | Version                      | Why this version                                                                |
| -------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------- |
| Node.js                                                  | 24.13.0 win-x64              | the version the shipped macOS package bundles                                   |
| whisper.cpp                                              | v1.9.1 `whisper-bin-x64.zip` | same upstream version as macOS                                                  |
| Silero VAD model                                         | v5.1.2                       | hashed from the shipped macOS package, so both platforms bundle identical bytes |
| llama.cpp (translation runtime, downloaded on first use) | b10092 win-cpu-x64           | same tag/revision as macOS                                                      |
| FFmpeg + FFprobe (built in CI)                           | 7.1.1 + x264 `0480cb05`      | identical version and x264 revision to the macOS build                          |

**FFmpeg is compiled, not downloaded.** No static win64 GPL build of the 7.1.x
line the macOS package uses is still published — BtbN dropped the 7.1 line and
prunes old builds, gyan.dev 404s on every 7.1 package — and bundling a newer
third-party build would put Windows encoding out of step with macOS _and_ oblige
us to offer that builder's exact corresponding source. So the pipeline builds
FFmpeg 7.1.1 + x264 `0480cb05` itself, in MSYS2, with the same configure flags
the macOS binary uses. The result is cached on the pinned source revisions, so it
compiles once and every later release restores it.

A GPL binary may only ship with its complete corresponding source: the manifest
enforces that every copyleft input has a pinned `sourceArchiveFor` companion,
and the build refuses otherwise.

### Pinning a checksum (from macOS)

GitHub's release API exposes a per-asset digest, so nothing here needs Windows:

```sh
gh api repos/ggml-org/whisper.cpp/releases/tags/v1.9.1 \
  --jq '.assets[] | select(.name=="whisper-bin-x64.zip") | [.name,.size,.digest]|@tsv'
```

For non-GitHub sources, download once on a trusted machine and use
`shasum -a 256` plus `stat -f %z`.

### Why inputs are mirrored

Upstream retention is not guaranteed — BtbN keeps only about two weeks of daily
builds. `mirror-windows-inputs.yml` copies each verified input into an immutable
`windows-inputs-<n>` release of this repository, and the manifest's `mirrorUrl`
then points there. That keeps a released commit rebuildable years later. Mirror
releases are never edited: bundling different bytes means minting a new
`windows-inputs-<n+1>`.

**State (2026-10-10):** the `windows-inputs-1` release does not exist yet and
every `mirrorUrl` is `null`, so CI builds fetch from upstream (still pinned by
sha256/size or git commit). Before it can be dispatched, the workflow needs one
fix: its download loop takes every `status: "pinned"` input, which includes the
`git` source `x264-source` (`sizeBytes: 0`), so the run would refuse on it. The
loop must skip `archiveKind: "git"` and a separate step must clone x264 at
`gitRevision` and `git archive` it into the mirror, the same way
`release-windows.yml` already does. The input most worth mirroring is the VAD
model: its upstream URL is Hugging Face `resolve/main`, which is mutable.

## Release gating

`REQUIRED_RELEASE_PLATFORMS` in `packages/shared/src/release.ts` is the single
list of platforms a stable release must ship. It contains both `macos-arm64`
and `windows-x64` (flipped once the pipeline reliably produced an installer;
every stable release since then has shipped both). Listing `'windows-x64'`:

- makes `scripts/verify-release.mjs` demand the Windows artifact in
  `apps/web/public/.well-known/wishly/stable.json`, and
- makes `scripts/verify-published-release.mjs` demand it be downloadable.

From that moment a missing or broken Windows build blocks the macOS release and
the web deploy too. That is the intended end state, and it is the current one.

Note the manifest path is `.well-known/wishly/`, not `soty/`.

## Signing the manifest

`scripts/sign-release-manifest.mjs` reads the private key from
`config/keys/release-manifest.private.pem`. That key **must never enter CI**.
The release runner (spec 020, `scripts/lib/release/step-adapter.mjs`) does this
step itself on the maintainer's Mac: it downloads the installer the workflow
attached, records its sha256 with `--platform windows-x64` and re-signs. Done
by hand, it is:

```sh
node scripts/sign-release-manifest.mjs --dmg <installer path> --platform windows-x64
node scripts/verify-release.mjs && node scripts/verify-published-release.mjs
```

## What CI cannot verify

`scripts/windows-smoke.mjs` prints this list on every run, and the release is
blocked while any check is skipped. These need a human with Windows access
**once**, before the first public release — a recruited waitlist tester or a
rented cloud Windows desktop:

| id                      | Behaviour                                                                                    | Why automation cannot cover it               | Checked by |
| ----------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------- |
| `native-chooser-dialog` | PowerShell file/folder dialogs come to the foreground; multi-select and non-Latin paths work | needs an interactive desktop and a human eye | _pending_  |
| `smartscreen-flow`      | wording of the unknown-publisher warning; "More info" → "Run anyway" completes               | reputation-driven, not reproducible in CI    | _pending_  |
| `antivirus-quarantine`  | how security products treat a freshly published unsigned binary                              | depends on the end user's product            | _pending_  |
| `firewall-prompt`       | loopback-only listening raises no prompt                                                     | policy-dependent                             | _pending_  |
| `reboot-survival`       | the app starts again after a real reboot                                                     | the Run key is asserted, the reboot is not   | _pending_  |

The list is closed: anything else discovered to be unverifiable must be added
here rather than left implicit.

## Перевірка людиною на Windows (T073, T076)

Ці два пункти не можна зробити з Mac чи CI: потрібна людина за справжнім
Windows-комп'ютером. Станом на 2026-10-10 вони **не виконані**, усі клітинки
`Checked by` вище — `_pending_`.

Важливо: інсталятор Windows уже опублікований (щонайменше з 1.2.0, зараз 1.2.6), а сайт
показує кнопку «Windows» кожному відвідувачу з Windows, бо в маніфесті є запис
`windows-x64`. Тобто вимога FR-042 «спершу обмежена перевірка, потім усім» уже
формально обійдена. Поки сайт не показують стороннім людям, це не шкодить, але
перевірку нижче треба пройти до того, як посилання піде назовні.

### Що потрібно

- Комп'ютер з Windows 10 або 11, 64-біт (Intel/AMD, не ARM). Підійде власний,
  орендований хмарний робочий стіл (наприклад, Azure Virtual Desktop чи
  Shadow) або тестувальник зі списку очікування Windows (адмін-сторінка,
  розділ списку очікування).
- Звичайний антивірус, який там уже стоїть (Windows Defender теж рахується).
- Акаунт Soty для входу.

### Чекліст першого проходу (T073)

Кожен пункт — це одна перевірка з таблиці «What CI cannot verify». Що бачите,
те й записуйте, бажано зі скріншотом.

1. **SmartScreen** (`smartscreen-flow`). Відкрийте сайт, натисніть «Windows»,
   запустіть завантажений `Soty-v<версія>-Windows-x64.exe`. Має з'явитися синє
   вікно «Windows захистив ваш ПК». Натисніть «Докладніше» → «Усе одно
   запустити». Встановлення має дійти до кінця. Запишіть точний текст вікна.
2. **Антивірус** (`antivirus-quarantine`). Під час завантаження й
   встановлення: чи браузер або антивірус блокував файл, видаляв його, просив
   підтвердження? Через 10 хвилин після встановлення перевірте, що програма
   досі на місці й працює. Запишіть назву антивіруса та що він зробив.
3. **Брандмауер** (`firewall-prompt`). Під час першого запуску не має бути
   вікна «Брандмауер Windows заблокував деякі функції». Якщо воно з'явилося —
   скріншот, і натисніть «Скасувати», не «Дозволити».
4. **Вибір файлів** (`native-chooser-dialog`). У Soty увійдіть, з'єднайте
   програму з сайтом і в компресорі натисніть вибір файлів. Вікно вибору має
   з'явитися **поверх** браузера, а не сховатися за ним. Виберіть кілька файлів
   одразу (Ctrl+клік). Окремо виберіть файл і папку з кириличною назвою,
   наприклад `Відео тест\кліп.mp4`. Стисніть одне відео до кінця.
5. **Перезавантаження** (`reboot-survival`). Перезавантажте комп'ютер, нічого
   не запускаючи вручну відкрийте сайт: він має бачити програму як підключену.

Після проходу впишіть у колонку `Checked by` таблиці вище, хто й коли
перевіряв і результат, наприклад `Роман, 2026-10-12, Win 11 23H2, ок` або
`… — Defender видалив файл, див. скрін`. Будь-яке «не так» — окрема задача до
виправлення, а не позначка «перевірено».

### Обмежений пре-реліз (T076)

1. Запросіть 3–5 людей зі списку очікування Windows, у яких різні комп'ютери
   (бажано і Windows 10, і 11, різні антивіруси).
2. Попросіть кожного пройти пункти 1–5 вище й стиснути хоча б одне своє відео.
   Для зворотного зв'язку вистачить короткого повідомлення: що встановилось,
   що ні, скріншоти помилок.
3. Подивіться в аналітиці, чи були в них помилки завдань:
   `npm run analytics -- errors --period 7d` і
   `npm run analytics -- cohorts --cohort-by platform`.
4. Запишіть підсумок сюди, у розділ «Результати пре-релізу» нижче: дата,
   версія, скільки людей, на яких Windows, що зламалося, що виправили.
5. Лише після цього посилання на Windows-версію можна давати назовні.

### Результати пре-релізу

_Ще не проводився._
