# Data model — 047

Це проєкт additive migrations; таблиці нижче ще не створені. T004 звіряє чинний
післярелізний schema baseline. Нова модель підпорядкована existing intent/attempt;
вона не створює незалежного scheduler або execution queue.

## Existing records

- `public.team_catalog_update_profiles`: додати `video_variation_count`, legacy
  read default 1; existing `version` CAS. Delay належить catalog publication policy,
  не recurring interval. Старі PATCH не обнуляють незнайомі поля.
- `public.team_catalog_update_attempts.profile_snapshot`: versioned effective config
  з N/source/settings identity та посиланням на video set; snapshot immutable.
- Launch defaults/config/revision і catalog intent payload: той самий shared contract;
  поле catalog `variant` залишається без зміни змісту.
- `packages/shared/src/team/launches/revisions.ts` та SQL reuse/receipt keys:
  video recipe fingerprint включає source version, restitch settings, N і contract;
  table fingerprint включає persisted row recipe; publication fingerprint включає
  mode/due/zone/policy revision. Schedule-only edit повторно використовує сумісні
  ready outputs, але не старий publication receipt. N change не reuse incompatible
  набір. Explicit manual restitch створює новий set; retry same intent відновлює старий.
  Reuse іншою Launch revision додає authorized reference, не змінює immutable owner.
- Row recipe: internal UUID `recipeRowId` і monotonic `recipeRevision`; при legacy
  adoption створити один раз і зберегти. External product ID не є цим UUID.

## `private.catalog_video_sets`

Поля: `id`, `team_id`, nullable `catalog_material_id`, `catalog_intent_id`,
`update_attempt_id`, `source_material_id`, `source_version`, `settings_snapshot`,
`settings_digest`, `requested_count`, `product_count`, `recipe_revision`, `state`,
`revision`, `cancel_requested_at`, timestamps. Exactly one owner:
catalog_intent_id XOR update_attempt_id; Launch підпорядкований catalog intent.
Team-bound composite FKs, immutable owner/source/config; UNIQUE owner identity.
CHECK 1≤requested_count≤product_count; canonical shared product limit перевіряється
server/SQL. Нема silent clamp при зміні товарів; створюється нова recipe revision.

States: accepted → preparing → ready → applying → verified;
blocked/failed/unknown/cancel_requested/canceled_with_cleanup_pending окремі.
Ready — всі N child receipts зареєстровані й доступність перевірена;
verified — provider content відповідає assignment. Partial — projection K/N,
а не дозвіл замінити чинний набір неповним.

## `private.catalog_video_variants`

PK `(video_set_id, video_variant_index)`, index 0≤i<N. Поля: team, stable process
request key, operation/attempt ID, selection snapshot, state, output material ID,
receipt ID, safe failure code, timestamps. FK до existing team_operations/receipts;
duplicate claim не створює інший child. Один output не зараховується двом indices.
State queued → downloading/preparing → processing → uploading → registered;
failed/blocked/unknown/cancel_requested/canceled — окремі terminal/recovery outcomes.
Receipt retention переживає restart; unknown upload не перезапускається до readback.
Stored signed URLs/grants заборонені; URLs отримуються через існуючий access seam.

## `private.catalog_video_assignments`

PK `(video_set_id, recipe_revision, recipe_row_id)` → video_variant_index;
FK до slot і persisted recipe, усі records належать одній team.
Shuffled balanced mapping генерується один раз; seed і algorithm version stored.
N≤rows, всі indices використані, counts differ≤1. Повтор тієї самої revision
читає mapping, не генерує новий. Reorder з незмінними IDs зберігає mapping.
Growth/shrink створює нову recipe revision і assignment; N>rows блокує write.

## Screen refusal records

У recovery snapshot зберігаються per-slot candidate IDs/version, exclusions,
cause і використані retry budgets. Нова версія кандидата розглядається окремо.
Додати `private.catalog_screen_refusals`: composite scope team/source-pool/version/
settings digest/slot/candidate/version, safe code, observed_at, expires_at.
TTL 24 h і максимум 512 records/scope за contract C4. Ordinary new attempt читає
memory, а не очищує її; explicit revalidate/version/settings change/expiry дозволяють
нову перевірку. Transient/global failure не записується як candidate refusal.
Attempt counters (candidates, retries, refreshes, bytes, active I/O) зберігаються
разом із recovery snapshot; restart їх не скидає. Server ledger і local checkpoint
reconcile monotonic maxima, не від'ємні delta; один execution fence власник.
Записи не містять secret grants, URL, raw names/paths або provider payloads.
Screen selections і ефективні налаштування доступні через sanitized diagnostic
projection за opaque IDs; current source settings позначаються current_snapshot.

## Publication target та active delivery

`VideoTarget` — discriminated union:

- `source`: original material ID + immutable source version; restitch off, N=1
  inert preference; не створює video set/child і не рахується generated output.
- `video_set`: video_set_id + assignment recipe revision; ready N реальних outputs.

Для original target output readiness доводиться metadata/access verification
original material/version, а не restitch receipt. Перед due availability revalidated;
source version changed/deleted/revoked → blocked, не silent substitution.
SQL CHECK рівно один typed target (source ID/version XOR video_set_id), team-bound FKs.

`private.catalog_video_deliveries`: PK catalog_material_id, team, active target,
active assignment/recipe revision, verified provider revision/digest, verified_at.
До першої публікації active target null. Legacy published catalog adopted once
через existing current video link + authorized source/material mapping; якщо це
не можна довести, blocked adoption, а не вигаданий video set. Поточний delivery
record є єдиним authoritative active pointer; старі projections derived from it.

Scheduled/held replacement змінює тільки pending policy target. Regular refresh
uses active target/mapping для вже published каталогу; до першої публікації поля
порожні. Нова row recipe потребує актуального assignment чинного target окремо
від pending assignment. Swap active pointer лише після verified provider content;
lost settlement → unknown і readback, old refs утримуються до завершення reconciliation.
У транзакції settlement active pointer, published job і consumed policy змінюються
узгоджено за current fence. Нема раннього pointer swap на generation ready.

## `private.catalog_video_publication_policies`

PK catalog_material_id з team-bound FK. Поля: revision, `mode`
(immediate/scheduled/held), pending typed VideoTarget, recipe_revision, due_at UTC,
local_datetime, IANA timezone, resolved UTC offset, current_job_id, updated_by,
timestamps. Один актуальний policy на каталог. Нова unchecked creation immediate;
scheduled cancellation → held. Уже published links не ховаються заднім числом.

## `private.catalog_video_publications`

Поля: id, team/catalog, policy_revision, typed target snapshot, recipe_revision, due_at,
state, lease_owner/fence, next_retry_at, safe failure, started_at, verified_at,
provider revision/content digest, existing reconciliation reference.
UNIQUE(catalog_id,policy_revision), at most one unsettled writer for a catalog.
States waiting_dependencies/waiting_time → applying → verifying → published;
retry_wait/blocked/unknown/canceled/superseded — окремі. Policy held не тотожна
job canceled. Успішне одноразове publication споживається, не повторюється на кожен
regular tick. Routine наступний update після published використовує immediate policy.

Cancel/reschedule при dispatched provider write: cancel_requested/unknown до
readback, жодного другого writer. Якщо write вже відбувся, published outcome чесний;
URL автоматично не стираються. Add now використовує той самий settlement path.

## Writer reservation і references

Розширити `private.catalog_update_reconciliations`: один owner/revision/fence
для всіх Soty writers цього catalog file. Network поза DB transaction.
Provider version condition обов'язкова при replacement; pre-read+DB lock її не
замінює. Unknown write блокує takeover до доведеного settlement.
Verified вимагає порівняння actual video cells/row recipe, не лише appProperties.

Reference protection охоплює всі child materials, active catalog assignments,
Launch revision history, pending set/publication та unresolved receipts.
Original-source publication targets теж мають references; відсутність video set
не робить матеріал вільним для cleanup. Active і pending targets утримуються окремо.
Розширити existing retention predicates; не заводити несинхронізований ref counter.
Cleanup можливий лише після відсутності всіх чинних references й unknown owners.

## Security, migration і projections

Усі нові таблиці мають RLS, revoke all, narrow grants; private tables без direct
authenticated writes. Definer RPC використовує `search_path=''`, qualified names,
current membership/entitlement та existing process/upload/share capabilities.
Cross-team IDs не приймаються. Safe read projections перевіряють current view access.
Background publication повторно перевіряє делеговані права й доступність outputs.
Зміна прав → blocked, не bypass. SELECT-only analytics роль залишається read-only.

Forward-only migrations, `ROLLBACK.md` з безпечним recovery, generated database types;
legacy singleton operations завершуються старим contract, нові sets — новим.
Нема примусового перетворення вже активних operations. Feature disable зберігає
jobs/hold/receipts і не дозволяє legacy writer обходити нові policy.
