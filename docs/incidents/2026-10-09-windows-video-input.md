# Windows video input investigation — 2026-10-09

## Evidence and limits

Two users reported video input failures on Windows x64, local build `1.2.5+70`.
One reported that the native picker never appeared and dropping returned
`STITCH_DROPPED_NOT_FOUND`. The other reported the generic unreadable-video
message after updating. Analytics confirms a previous successful **compressor**
operation on `1.2.3+68` for the second account; this is not proof of a previously
successful **stitcher** operation on the same file.

The first user's later screenshots show working image input and visible settings.
Successful image upload does not establish native picker or original-path lookup
health. Browser Android identities may be emulation or overrides; they are not
proof of the host OS or a cause. A pending request and provisional headers do not
prove the agent handler received it. No evidence establishes antivirus blocking.

Published tags `v1.2.3..v1.2.5` have identical picker, dropped-source, stitcher and
platform source. Fastify changed from `^5.6.1` to `^5.12.5`; causation has not been
reproduced. Do not downgrade it speculatively. Release source identity does not
prove the installed files or device state are identical.

## Reproduced defects and changes

- A browser `file:///C:/...` drop became `/C:/...`, an invalid Windows drive path.
  Strip the URL-only leading slash for drive-letter paths; keep POSIX paths and
  rejection of remote file hosts intact.
- Original lookup searched `Movies` but omitted the standard `Videos` directory.
  Include `Videos` within the existing bounded search. This does not promise
  discovery on arbitrary drives, redirected folders, or network shares.
- A probe spawn failure during `/api/stitcher/files` was returned as a successful
  HTTP response with an unreadable-file refusal. Return `MEDIA_TOOL_UNAVAILABLE`
  consistently with inspection instead. The readiness snapshot may predate the
  actual failure.
- PowerShell stdout was decoded separately per chunk, which can corrupt a Unicode
  path when its UTF-8 bytes span chunks. Decode incrementally on Windows.

The first three regression tests failed before the fixes. The Windows decoder
regression tests a real split multibyte sequence. These are demonstrated defects,
not a claim that either user's exact failure has been reproduced.

## Native dialog hardening

Both Windows file and folder dialogs now receive a topmost WinForms owner and
explicit disposal. PowerShell errors terminate instead of potentially looking
like a successful empty selection. Native dialog foreground behavior still needs
an interactive Windows check. Keep the existing 120-second bound and ordinary
Cancel semantics.

Relevant platform documentation:
[OpenFileDialog](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.openfiledialog)
and [Node child processes](https://nodejs.org/api/child_process.html).

## Diagnostic evidence for the next occurrence

Stitcher input reports correlated stage start/completion and allowlisted
`error_occurred` events for picker, dropped-original resolution, source probe and
compressor-settings read. A picker cancellation has a cancelled outcome.
File refusals report a safe diagnostic code where available:

- `SOURCE_STAT_FAILED`: file metadata could not be read.
- `PROBE_SPAWN_FAILED`: inspection process could not start (the route returns
  `MEDIA_TOOL_UNAVAILABLE`).
- `PROBE_EXIT_FAILED`: inspection process did not complete successfully.
- `PROBE_JSON_INVALID`: process output was not valid JSON.
- `PROBE_METADATA_INVALID`: the returned media description was incomplete.

Existing `analytics -- journey <email> --json` and `analytics -- errors --json`
can read these events. Use their `flow_id` to correlate the stages. No migration
or new event name is needed. No paths, names, raw stderr, headers or tokens enter
these events; unknown exception text becomes `STITCH_INPUT_FAILED`.

This is a narrow first implementation of diagnostics. It does not implement all
of [031 platform autoanalytics](../../specs/031-platform-autoanalytics/spec.md):
central telemetry still cannot establish native-window visibility or reconstruct
an unobserved past failure.

## Доповнення 2026-10-10: три причини, яких перший прохід не побачив

Перший прохід (вище) виправив обробку шляхів і помилок, але не пояснював, чому
нативний пікер «не з'являється», чому дроп не знаходить файл і чому не
відкривалася папка з результатом. Ось що знайшлося при читанні Windows-гілок
коду, а не лише звернень.

**1. Explorer отримував `/select,` у лапках і показував «Документи».**
`showInFileManager(..., { reveal: true })` викликав
`spawn('explorer.exe', ['/select,C:\…\file.mp4'])`. Node на Windows бере в
лапки кожен аргумент із пробілом цілком, і Explorer отримував
`"/select,C:\Users\Ада Сміт\Downloads\file.mp4"` — такої форми він не розуміє й
відкриває теку за замовчуванням. У кожного користувача з пробілом в імені або в
шляху «показати в Explorer» не працювало ніколи. Тепер аргумент будується як
`/select,"C:\…"` і передається дослівно (`windowsVerbatimArguments`).

**2. Пікер відкривався, але його ніхто не бачив.** Агент запускає PowerShell із
прихованою консоллю (`windowsHide`). Windows записує це в `STARTUPINFO`
процесу, і **перший** виклик `ShowWindow` у цьому процесі ігнорує власний
аргумент і бере звідти стан «сховано». Без власника діалог був першим вікном
процесу, тож міг показатися невидимим або лягти за Chrome; через дві хвилини
запит завершувався `NATIVE_PICKER_TIMEOUT`, а користувач бачив лише, що «нічого
не відкрилося». Тепер перед діалогом показується однопіксельна прозора форма
(`Opacity = 0`, `TopMost`, по центру екрана): вона з'їдає той перший виклик і
стає власником діалогу, тож діалог виходить поверх Chrome і по центру.

**3. Дроп шукав файл не там і не мав індексу.** На Windows 10/11 із OneDrive
«Робочий стіл», «Документи» і «Відео» живуть у `~/OneDrive/...`, а `~/Desktop`
порожній або відсутній; агент же шукав лише під `os.homedir()`. І на відміну від
macOS, де після папок запитується Spotlight, на Windows другого кроку не було
зовсім, тож відео на `D:\` не знаходилося ніколи — звідси
`STITCH_DROPPED_NOT_FOUND`. Тепер `userContentFolders()` один раз питає Windows,
де насправді Downloads/Desktop/Videos/Documents (той самий реєстр, що читає
Explorer; PowerShell друкує UTF-8, тому кириличне ім'я користувача не
псується), додає корені `OneDrive`, `OneDriveConsumer`, `OneDriveCommercial`, а
після папок `indexedFileSearch()` питає Windows Search — той самий індекс, що й
поле пошуку Explorer — за точним ім'ям файла. Кожен кандидат, як і раніше,
звіряється за розміром і часом зміни.

Що ще змінилося разом із цим: PowerShell викликається за повним шляхом
(`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`), а не через
`PATH`; capability `spotlightSearch` перейменовано на `indexedFileSearch` і на
Windows вона тепер `true`.

Що це не доводить: жоден із трьох пунктів не перевірено на живій Windows —
машина власника macOS. Перевірка перед релізом лишається такою, як описано
нижче, плюс два кроки: «показати в Explorer» для файла з пробілом у шляху, і
дроп файла з `D:\` та з OneDrive-робочого столу.

## Validation and release acceptance

The initial six targeted test files passed (72 tests). The follow-up probe,
analytics query, diagnostic privacy and stitcher page checks passed (29 tests,
including 3 diagnostic tests already counted in the initial set).

Final `SOTY_VERIFY_SERIAL=1 nice -n 15 npm run verify`: 13/14 gates passed;
4,455 tests passed, 2 failed and 10 were pending. Formatting, lint and all type
checks passed. The two failures also reproduce in an isolated two-file run:

- `performance-budgets.test.ts`: existing built assets total 907,909 gzip bytes
  versus a ceiling of 903,611. Their latest timestamp is 2026-10-08 16:15 Kyiv,
  before this patch; the verification command does not rebuild the web assets.
- `team-agent-finance-realtime.test.tsx`: the unchanged finance test cannot find
  “An account association changed” after an external transfer.

These remain release blockers outside the input fix; no budget or assertion was
weakened. The actual read-only `journey --limit 1 --json` command also succeeded
against the existing analytics schema with its added `flow_id` field.

### Coverage inventory for this patch

| Path                                     | Evidence now available                                                          | Remaining acceptance                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Windows native file/folder picker        | Launch failure/timeout and correlated web stages; Unicode decoding regression   | Interactive Windows foreground, Cancel and file selection                                         |
| Windows file URI drop                    | Drive-path conversion regression                                                | Actual browser URI delivery on Windows                                                            |
| Browser video drop                       | Resolver error category and correlated probe stage; Videos-directory regression | Same files and locations from the reported cases; arbitrary folders remain outside bounded search |
| Stitcher input probe                     | Stat/spawn/exit/JSON/metadata categories and existing read-only CLI access      | Packaged runtime and production delivery smoke                                                    |
| Compressor settings read within stitcher | Stage/error events                                                              | Native stitcher state/SSE readiness coverage remains part of feature 031                          |

This patch is implementation-complete for the defects above, but is not a
production-readiness record and does not close either user incident without
reproduction on the affected environment.

Before shipping, verify a packaged Windows candidate on an interactive desktop:

1. Open file and folder pickers with Chrome in front. Confirm foreground, Cancel,
   retry, multi-select and paths containing Cyrillic and spaces.
2. Add the same known-good MP4 through picker and drop from Downloads and Videos.
   For an out-of-search location, verify the explicit not-found recovery message.
3. Test a Windows file-URI drop and ordinary browser File drop independently.
4. Verify a corrupt video and unavailable FFprobe are distinguishable, and that
   analytics contains the expected safe stage/error evidence.
5. Reproduce the original users' attempts with the same source files when available.
   A passing synthetic test does not close those incidents.

The existing beta and production runbook gates remain required. No release,
version bump, production mutation or artifact publication is part of this fix.
