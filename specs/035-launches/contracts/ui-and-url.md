# UI та URL contracts

## Navigation і controls

Route: `/team/<id>/launches` у чинному router; query launchId, tab=result/settings, revisionId. URL маршруту не містить original URL або конфігурацію. У списку є пошук, фільтри дати Calendar → Yesterday → Today, рекламного кабінету та офера. Учасником запуск не фільтрується. Усі фільтри застосовуються сервером до pagination.

Desktop form+preview поруч; narrow layout послідовний. Inventory Input/SelectMenu/Tabs/RadioGroup/Switch/Calendar/Popover/Card/state patterns, токени та i18n. Creative picker single selection через existing TaskAttachmentPicker seam; uploads — explicit action, не preview side effect.

Незаповнене required поле має light warning-soft/border, optional/hidden — ні. Валідне заповнення одразу прибирає accent. Це completion hint; aria-invalid і stronger error — після invalid interaction/submit. Manual result override також warning, але має явне «Змінено вручну». Немає помилкової спільної семантики цих двох станів.

Result: full-row copy в read mode, явне inline edit; input click не копіює. Clipboard success тільки після фактичного write, короткий green highlight потім повертає manual orange badge. Copy current draft override дозволений до save. Reset повертає baseline. Новий generated result не переносить overrides мовчки.

Copy Launch: новий draft, tomorrow/todo, config і material references, без catalog/result/manual overrides/history; активний assignee переноситься. Archive: warning про збереження каталогів/перезашитих відео з будь-якої revision; unchecked «Не показувати знову», per user/team, persisted з успішним archive.

## SUB normalization

Raw variable → trim зовнішніх пробілів Zs → replace внутрішніх Zs на `_` → ASCII regex `^[A-Za-z0-9_-]+$`. Control/tab/newline/кирилиця/emoji/% не допускаються, без транслітерації. Buyer і creative alias перевіряються завжди; інші sources — коли вибрані. Креатив береться зі stem filename, alias редагується окремо. Фізичний filename і соц не перейменовуються. Невалідне використане джерело блокує Generate із field-specific помилкою.

Ordered enum arrays buyer/social/adAccountSuffix/creative, без повтору в одному SUB. Join через `-`; final SUB також validate. Empty array = preserve original, не empty string assignment.

## Literal URL mutation

`originalUrl` зберігається точно; validator не trim-ить/не додає scheme. Valid absolute HTTP(S), без raw whitespace/control credentials; invalid input дає field error. Весь URL не серіалізується через URL/URLSearchParams.

Raw query segments із first '='; керовані тільки raw keys `sub1/sub2/sub3`. Для active builder замінити кожне входження value, залишити duplicate/order/key unchanged; `subN` стає `subN=value`. Missing active key append before fragment. Empty builder не змінює жодного його сегмента.

Golden vectors:

| Input / конфігурація                                                      | Expected                                                        |
| ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `https://example.invalid/p?x=a%2fb+z&sub1=old&sub1=older#H`, buyer=patrik | `https://example.invalid/p?x=a%2fb+z&sub1=patrik&sub1=patrik#H` |
| `https://example.invalid/?sub1=&sub2&x={{campaign.id}}`, all empty        | exact same string                                               |
| `https://example.invalid/p#H`, sub3 creative=video_5                      | `https://example.invalid/p?sub3=video_5#H`                      |
| `https://example.invalid/?%73ub1=x&SUB1=y`, active sub1=patrik            | `https://example.invalid/?%73ub1=x&SUB1=y&sub1=patrik`          |
| `https://example.invalid/?sub1&x=1`, active sub1=patrik                   | `https://example.invalid/?sub1=patrik&x=1`                      |
| Leading/trailing raw whitespace                                           | field error, original untouched                                 |
| Creative `Відео 5`                                                        | alias `Відео_5`, blocked до manual correction                   |
| Buyer `roman test`                                                        | `roman_test`, видима нормалізація                               |

Existing query terminator/empty segments зберігаються; додавати `?` лише коли query delimiter відсутній, потрібний `&` без переписування попередніх separator bytes. Вставка відбувається до `#`. original/generated length<=8192. Нові values encode once; allowed alphabet лишається читабельним. Макроси, CAPI/Pixel, невідомі query keys і path/authority не змінюються.

## Derived values

N=max100, budget max999999; Math.round(i*max/N); zero/duplicates rejected, manual строго зростають і last=max. Ranges `(i-1)*ads+1 .. i*ads`, ads max1000. Date tomorrow = calendar day у browser timezone, persisted YYYY-MM-DD; age positive safe integer без 99 cap.

Names v1: `[social-suffix-alias{-c}] Offer $budget genderLowerAge+{ adv+} DD/MM #i(start-end)`. Offer не розбирається на GEO; alias не стає V-index. Шаблон versioned. Google Drive catalog name походить від existing physical filename convention, result copy alias не перейменовує файл.

## RAM, ручні розходження та історія

Draft, незбережені result overrides і conflicts тримати тільки в RAM. Не писати config/original/generated URL/ручні значення в localStorage, sessionStorage, IndexedDB, Cache API або workspaceOperationJournal; захищені detail responses не кешувати service worker-ом. Явний save пише їх у захищене серверне сховище. Reload втрачає незбережений ввід, тому при виході показати unsaved warning; logout/зміна scope очищає RAM. Відновлення requestKey може використовувати несекретні IDs, але не persistence повного payload. Для copy timezone/key — також несекретний retry context.

При ручній зміні advertising URL біля каталогу показати «Змінено для копіювання; каталог не оновлено». Для budget/adRange/SUB та інших залежних outputs аналогічно назвати поле, яке не перераховано. Це окремо від orange «Змінено вручну» і не запускає IO. Збереження/reopen не прибирає попередження; повернення відповідного override до baseline прибирає саме це розходження. Ручна catalog URL/name правка також пояснює, що фізичний ресурс не змінено.

Історія має дію «Відновити конфігурацію». За dirty draft/overrides спочатку запропонувати зберегти відповідною дією, відкинути або скасувати; нічого не зберігати побічно. Відновлена config відкривається у Settings як робоча копія зі старою датою, актуальні sources перевіряються явно. Збереження draft і нова generation виконуються стандартним шляхом; active result залишається попереднім до commit. Недоступні джерела показати й заблокувати Generate до виправлення. Viewer не має цієї дії. Cancel залишає збережені дані та active revision незмінними.

### Versioned catalog name in SUB (2026-10-25)

The builder offers `catalogName` as a fifth ordered variable for catalog launches.
It means the complete, collision-safe name of the catalog actually created for the
selected creative, including its reserved version. The editor shows “After generation”
until that reservation exists; it never guesses a version. Missing non-catalog values
still validate normally. Other-method launches cannot generate a catalog-name SUB.
Workspace and offer defaults retain the new variable and its order.

The durable name plan resolves the SUB before catalog rows are written. Only slots
containing this variable accept the exact catalog text, URL-encoded; other SUB validation
and untouched URL bytes keep their existing rules. Control characters and oversized
values are refused. The original child request and its digest remain unchanged for
retry. The resolved URL is committed into the Launch baseline only together with the
matching registered catalog. Published revisions remain immutable. A new generation
using this variable creates a new version rather than reusing a differently bound URL.

Acceptance covers deferred preview, five ordered variables, Unicode/spaces in the
actual name, non-catalog rejection, name reservation before URL resolution, failure
before provider creation, stale coordinator fences, same-version child retry, and an
immutable published URL. Diagnostic evidence uses existing `catalog_planning` and
`catalog_registering` stages plus the protected intent binding and revision receipt.
Names, URLs and SUB values are not telemetry. Missing registration or browser delivery
remains unknown; a reserved name alone is not proof of a delivered result. Beta without
Drive credentials can verify the component and database seams, but cannot claim a real
provider/catalog delivery test.

Result sections are ordered: catalog name and URL, campaign names, advertising URL.

### Launch notes (2026-10-25)

Settings provide a collapsed Notes accordion. An empty collection presents one Add
note action. Each added cell has an optional single-line title, a scrollable multiline
body and a remove action. There is no fixed note-count limit; individual titles are
bounded at 160 Unicode characters and bodies at 8192, within the existing bounded
protected draft request. Stable note IDs preserve edits and ordering during autosave.
Empty cells remain editable; they do not block generation.

Notes belong to a launch and are excluded from workspace/offer profiles. Draft save,
reload and copy preserve them; generated revisions retain their snapshot. Current
results use the current launch notes without requiring regeneration; historical
results use the historical revision notes. Note-only edits do not mark generated
campaigns/catalogs stale or require another media operation.

Results display a Notes accordion at the very end, initially expanded, only when a
body contains non-whitespace text. Each button displays its title or a shortened
beginning of its body. Copy writes the exact body, including line breaks, without the
title. Green confirmation and a check follow successful clipboard completion only;
failure stays explicit and retryable. Locked input and permission loss retain the
existing protected Launch behavior.

Diagnostics reuse correlated `save_draft` outcomes for persistence. Clipboard attempts
have bounded generic operation start/success/failure signals with
`flow_step=launch_notes_copy`; note IDs, titles and bodies never enter analytics.
Browser termination or missing delivery leaves the clipboard outcome unknown. A save
receipt proves persistence, not clipboard delivery. Acceptance covers draft/revision
round-trip, legacy drafts, rejected malformed/duplicate IDs, add/edit/remove, empty
filtering, untitled labels, exact multiline copying, failure/retry and current-result
notes without generation. Component checks in source beta and isolated database tests
do not substitute for a packaged-beta/provider journey.

### Personal persistent copy marks (2026-10-25)

A successful clipboard promise first shows the existing brief green confirmation,
then a readable muted copy surface with a permanent check and “Already copied”
accessible description. Edit and external-link controls retain their appearance and
function. Recopy remains enabled and repeats green confirmation; failure creates no
mark. Copying is not proof of pasting, launching or completing a campaign.

Protected personal receipts survive reload and another device. Ordinary fields are
scoped to actor, team, launch, generated baseline, stable field and exact copied value.
Manual revisions retain unchanged marks through their baseline; new generations start
fresh. Notes instead use actor/team/launch/note ID/body, so renaming does not reset a
mark and a body edit needs another copy. Earlier copied values retain their receipts
for historical results. No Launch version or team progress changes when marking.

A small personal counter and reversible Reset copy marks action apply only to the
currently displayed user's matching values. Undo restores those marks without claiming
another clipboard action. Reset from an old tab cannot erase a receipt for different
new content. Reads revalidate on focus and same-user cross-tab notifications; delayed
reads preserve local mutation tombstones. The captured owner-scoped write queue drains
after closing a result; expected-actor RPC checks fence account swaps.

The server stores a private keyed HMAC and stable opaque scope, never duplicate copied
text. Keys and fingerprints are unavailable to browser/service analytics projections;
protected RPC responses return matching field keys only. Content exists in authorized
request bodies/RAM, never browser storage or analytics. Each request has bounded size,
field keys and elapsed time. Viewers can keep their own markers, never another member's.
Read errors remain unknown. Write errors keep honest tab-local proof, disclose that
persistence failed and allow retry without touching the clipboard again.

Diagnostics separate clipboard success from receipt read/write persistence using
correlated `launch_copy_marks_read` and `launch_copy_marks_write` operations. Missing
signals or a lost reply never prove persistence; a later protected matching read is
the fallback. Acceptance covers rejection, recopy, reload, value/actor/generation changes,
manual lineage, note rename/body edits, stale reads around reset, stale-tab reset,
undo, queued writes after unmount, and storage/telemetry privacy. PGlite stubs verify SQL
behavior and ACLs; native PostgreSQL verifies real pgcrypto HMAC and RPC/table grants.
