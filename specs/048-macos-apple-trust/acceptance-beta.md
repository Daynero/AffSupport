# Acceptance: пакетна бета через ланцюжок (T009)

**Дата**: 2026-11-10. **Машина**: Apple Silicon (M-серія, не віртуалізована), macOS 26.6.2, Rosetta увімкнена. **Воркдерево**: `/Users/daynero/RiderProjects/AffSupport-048-trust`, гілка `048-macos-apple-trust`, база `main` f7e33e93 (реліз 1.4.1). **Коміт пакування**: c9823615 (чисте дерево; доказ бети відкидає `.dirty`, перший прогін з незакоміченою атестацією зупинився на `BETA_PACKAGE_PAYLOAD_CHANGED`). **Ідентичність**: ad-hoc (`SOTY_SIGNING_IDENTITY=-`, `SOTY_SKIP_NOTARIZATION=1`), бо Developer ID ще в обробці (T012).

## Входи

- Рантайм arm64: `BETA_RUNTIME_SOURCE_APP=/Volumes/LaCie/Soty/release/tmp/soty-release-worktree-s8DlpP/release/Soty.app` — застосунок 1.4.1+81 із воркдерева раннера релізу 1.4.1 (лише читання).
- Рантайм x64: `release/inputs/x64` (APFS-клон `release/inputs/x64` з основної копії, `approved-inputs.json` 049) і `SOTY_CHROMIUM_SOURCE_ROOT=/Volumes/LaCie/DevData/Soty/Intel049/browsers/chromium_headless_shell-1234`.
- Приватні файли воркдерева, як їх готує раннер (`provisionWorktree`): `.env.beta`, `.env.production*`, `config/keys/beta-agent-entitlement.*`, клони `node_modules` (симлінк не годиться: `npm ls --long` через симлінк дає 2,4 МБ замість 327 КБ і переповнює буфер стейджингу агента).

## Команди

```zsh
BETA_RUNTIME_SOURCE_APP=<1.4.1 Soty.app> npm run beta:package -- --arch=arm64 && npm run beta:verify -- --arch=arm64
SOTY_CHROMIUM_SOURCE_ROOT=<chromium_headless_shell-1234 x64> npm run beta:package -- --arch=x64 && npm run beta:verify -- --arch=x64
```

## Результат

| Крок                                                                  | arm64                                                                   | x64                                          |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| `beta:package` через `sign-mac-app.sh`                                | 55 с, `signing.json` поруч із пакетом                                   | 54 с, `release/beta/x64/signing.json`        |
| Підсумок ланцюжка                                                     | adhoc, machO 10, nested 1, node 1 / chromium 1 / hardened 7, `files` 10 | те саме                                      |
| `verify-macos-payload`                                                | 11 native файлів                                                        | 11 native файлів                             |
| `audit-macos-signing` (`codeSigning` у доказі)                        | hardenedMachO 11, кожен `after` збігся                                  | hardenedMachO 11, кожен `after` збігся       |
| `verify-staged-dependencies --static --signing=`                      | не викликається для arm64                                               | 85 залежностей, Chromium через атестацію     |
| Рантайм-подорож (`verify-beta-runtime`): pair, entitlement, компресія | завершено за 2 с                                                        | статична кваліфікація, рантайм не доводиться |
| `verification.json`                                                   | схема 2, `codeSigning`, `dirty: false`                                  | схема 3, `static-cross-build`, `codeSigning` |

Build id: arm64 `1.4.1-beta.c9823615.20261110014903+1794275343`, x64 `1.4.1-beta.c9823615.20261110015019+1794275419`. Жоден бінар не потребував entitlement поза таблицею профілів (T001 не відкривається).

## Розширена подорож (arm64, hardened-бінарі поза компресією)

Скрипт у scratchpad сесії запускає пакетований `Soty Beta.app` через `open` під тимчасовим `HOME` (моделі мовлення — APFS-клони з бети власника), робить pair, подає бета-ентайтлмент і проганяє три операції; три прогони, останній 43 с.

| Перевірка                                                                             | Результат                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/health`                                                                         | `ok`, канал `beta`, `sourceRevision` c9823615, ентайтлмент enforced                                                                                                                                                                               |
| Landing-прев'ю через Chromium Headless Shell із бандла (профіль `chromium`, JIT-пара) | папка з `index.html` і скриптом → `ready` за 2–3 с, `image/webp` 2506 байт; 3 процеси `chrome-headless-shell` з `Contents/Resources/agent/browser/…`                                                                                              |
| Транскрибація через `whisper-cli` із бандла (профіль `hardened`, без entitlements)    | синтезоване `say` англійське речення у mp4 → `completed` за 6–16 с (якість `fast`, large-v3-turbo), документ із сегментами й словами; мову визначено автоматично як `ru`, текст записано фонетично кирилицею — налаштування мови черги, не підпис |
| Finder-розширення (`com.wishly.beta.finder-extension`, sandbox-entitlements)          | зареєстроване в `pluginkit` саме з цього бандла після запуску через LaunchServices, `codesign --verify --strict` чистий, прапорець `runtime`                                                                                                      |
| Компресія                                                                             | доведена рантайм-подорожжю `beta:verify` (вище)                                                                                                                                                                                                   |

Каталог (047) окремо не ганявся: його Chromium-рендер і ffmpeg — ті самі бінарі, що доведені вище.

## Знахідка і виправлення

Статична x64-кваліфікація спершу впала: `The staged Chromium bytes differ from their recorded digest`. `verify-staged-dependencies.mjs` порівнював байти Chromium із дайджестом завантаження Playwright, а ланцюжок, як і має, переподписує кожен Mach-O. Зняття підпису (`codesign --remove-signature`) не повертає байти: upstream x64 shell непідписаний, upstream arm64 — linker-signed, і після циклу підпис/зняття відрізняються заголовок і load commands. Тому не «дайджест без підпису», а атестація ланцюжка: `files` у `signing.json` з `before`/`after` на кожен Mach-O, `audit-macos-signing` звіряє `after` з бандлом, верифікатор стейджингу бере `--signing=` у `verify-beta-package.sh`, `verify-package.sh`, `verify-dmg.sh`, `verify-dev-package.sh`. Без підсумку (Windows, джерельний запуск) діє байтова рівність, як раніше. Це єдиний гейт після підпису, який переподпис зачепив: агент у рантаймі дайджест Chromium не перевіряє (`landing-preview/renderer.ts` лише читає шлях), а входи рантайму (`runtime-inputs.json`) перевіряються до копіювання в бандл.

## Що лишається

- T010/T011: код є; закриваються першим релізом з ідентичністю (T014) після T012.
- Після злиття 048 у `main` бету в основній копії треба перепакувати обома архітектурами (`npm run beta:package` і `npm run beta:verify` з `--arch=arm64` та `--arch=x64`, близько двох хвилин), бо доказ без `codeSigning` відкидається; пакети з воркдерева прив'язані до c9823615 і підходять лише доки він лишається предком `HEAD` з web-only змінами після себе.
