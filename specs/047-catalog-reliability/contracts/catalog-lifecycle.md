# Interface contracts — 047

Проєкт розширення існуючих APIs, без нового gateway. Shared validators у
`catalog-video-set.ts` / `catalog-publication.ts`; existing request/error envelopes
і analytics CLI envelope не змінюються. Запропоновані нові names нижче стануть кодом
лише під час реалізації. Unknown input проходить guard перед використанням.

## C1. Config і read models

`videoVariationCount: integer` — total для наступного set; default 1 для legacy,
server/DB 1≤N≤effectiveProductCount. Missing field у legacy PATCH означає preserve,
не reset. Explicit null/NaN/fraction/out-of-range — validation error.

При restitch off N=1 лишається inert legacy preference; N>1 не зберігається як
активна генерація: UI пропонує ввімкнути перезашивку, server відхиляє inconsistent
config. Нема тихого перетворення на URL variations. Config save має expectedVersion;
run приймає immutable config/source/recipe snapshot. Зміни під час run — next run.

Нове create intent має `videoPublication`:

- `{ mode: 'immediate' }`;
- `{ mode: 'scheduled', localDateTime, timeZone, resolvedOffset, dueAt }`.

Persisted catalog read model містить `mode: immediate | scheduled | held`,
policyRevision, jobId/state, requestedN, registeredN, availableN, childStage,
generationId, attemptId, recipeRevision, dueAt, serverNow, lateSince, safeCode,
tableState, videoState, lastVerifiedAt, freshness. registeredN — historical receipts;
ready K/N використовує availableN після потрібної live access перевірки.
Без другого owner progress; local upload percentage лише SSE, server facts — Realtime.
Read model також розділяє active delivered target/assignment і pending target.
`publicationTarget.kind = source | video_set`: source original material/version
для restitch off, video_set для перезашитого набору. Delay не вмикає restitch.
Source readiness має текст «Відео доступне/недоступне», не «Створено 1 відео»;
generated K/N показується лише для video_set. N>1/restitch off лишається невалідним.

The atomic manager RPC also returns `observed_at` from the database statement
clock. Web snapshots carry it as `runtimeObservedAt`, separately from settings
version. An older same-version observation cannot replace a newer readback's
runtime. Missing legacy observation time remains unknown; the client never
invents a server timestamp from response arrival or a settings update time.

List results: validated rows + bounded invalid-row count/reasons + freshness/completeness.
Entire invalid response — INVALID_RESPONSE; mixed valid rows — partial. Run/retry
count=0 і cancel=false валідні no-op; malformed value не перетворюється в no-op.

Trash pages use the authenticated read-only RPC list_team_trashed_materials_v2.
The cursor is the exact returned timestamp plus material UUID, ordered descending
by both values. Both fields are absent for the first page and present together
for subsequent pages; a missing field or nonfinite timestamp is INVALID_INPUT.
The boundary row need not still exist or remain trashed. Timestamp precision is
preserved across the SDK and UI. Top-level folder filtering and current view ACL
remain authoritative. The legacy three-argument RPC remains unchanged for older
clients; a new-client read failure cannot fall back to a lossy timestamp cursor.

## C2. Commands і idempotency

Existing `apps/web/src/api/team.ts` wrappers та `drive-ops`/RPC dispatch розширюються:

| Proposed typed command        | Required identity                                                               | Outcome                                                      |
| ----------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| beginCatalogVideoSet          | team, existing parent intent/attempt, source/config/recipe revision, requestKey | accepted existing/new generation snapshot                    |
| retryCatalogVideoSet          | generationId, expectedRevision, requestKey                                      | reconciled snapshot; only failed/unstarted children eligible |
| cancelCatalogVideoSet         | generationId, expectedRevision, requestKey                                      | cancel_requested або settled outcome                         |
| setCatalogVideoPublication    | catalogId, expectedPolicyRevision, requestKey, scheduled fields                 | saved policy + job snapshot                                  |
| cancelCatalogVideoPublication | catalogId, expectedPolicyRevision, requestKey                                   | held/cancel_requested або already published                  |
| publishCatalogVideoNow        | catalogId, expectedPolicyRevision, requestKey                                   | explicit immediate intent through same writer                |

Приклад SQL seam: service `private.begin_catalog_video_set`,
`private.claim_catalog_video_variant`, `private.settle_catalog_video_variant`,
`private.claim_due_catalog_video_publication`; client-facing authorized commands
йдуть через Edge або narrow definer RPC, без direct private table writes.
Existing material-operation keys/receipts лишаються джерелом виконання.
Set publication command binds explicit typed target і current recipe revision;
readback зберігає active/pending окремо. Source target version immutable для job.
Duplicate same key+payload повертає існуючий outcome; same key+different payload —
conflict. Один catalog-wide reservation для всіх command paths.

Timeout після відправленої mutation — unknown, далі readback з тією самою identity.
Нова requestKey не є способом «виправити» unknown. Accepted не дорівнює verified
або visible. Діалог зберігає recovery link за opaque ID після reload.

### Material-group provider dispatch

Managed move/trash/restore operations bind an immutable `group-v1` nonce to the
existing operation key. Existing intents retain nullable legacy execution state;
they are never backfilled as unexecuted. The service claims one invocation and
reserves each frozen member before provider PATCH. A repeated reservation returns
readback, never a second write permit. Only the holding invocation may checkpoint
that member, attest that its own provider call never began, or reconcile a verified
response after a lost checkpoint acknowledgement. A lost provider response keeps
the member held without expiry-based reset. The old checkpoint refuses managed
intents. Completion requires all frozen members and no pending provider dispatch.
Current actor rights remain authoritative. Overlapping unresolved member snapshots
serialize within the team, including distinct primary sources with shared members.
Managed failure markers bind the same open executor. Legacy, replaced, closed or
completed writers cannot change its material placement or parent receipt. Fully
acknowledged registration closes the finished marker atomically; it does not
clear an unknown member or renew provider execution permission.

GROUP_RECONCILING and PROCESS_RESULT_UNCERTAIN preserve the active parent; a
duplicate or uncertain request cannot mark another executor's parent failed.
The SELECT-only `analytics_material_group_execution` projection exposes opaque
identities, closed state/cause and bounded counts. A reservation does not prove
provider execution; member confirmation does not prove registration or UI delivery.
Current-state/as-of limits, missing sources and malformed evidence remain explicit.
Current-generation receipt replay and complete entry-point partial recovery are
separate acceptance requirements; these primitives alone do not prove them.

### Stop the observed updater round (T024)

The additive authenticated RPC `cancel_team_catalog_update_attempt(p_team uuid,
p_catalog uuid, p_expected_round timestamptz, p_expected_attempt uuid)` returns a
strict boolean. It locks the updater item, checks current process permission and
compares the observed round before calling the existing cancellation boundary.
No active round returns false; a replacement round/attempt returns STALE_RESULT
and is left running. A live provider-worker lease retains the existing WRONG_STATE
refusal: cancellation cannot claim that an in-flight provider write was undone.
The old two-argument RPC remains for already deployed clients. The current UI
refuses a missing observed round before dispatch and never falls back to an
unfenced cancel. Its actor-bound observed-round RPC also checks the original
actor captured before session acquisition.
Schedule off remains a separate profile change. No new publication writer is added.

### Stop diagnostic observations (T029)

The initiating actor is captured before session acquisition; the server refuses a
replacement actor through the additive actor-bound RPC. An unknown observed round
never falls back to the legacy unqualified Stop. Manager state is scoped by team,
client identity and private actor/access epoch.

Stop has its own `flow_id` and `attempt_id`, `flow_step=catalog_manager_stop` and
`production_completed=false`. The observed catalog attempt is `parent_flow_id`;
a read-only Check has another own flow and retains the original request in
`workflow_id`. Neither Stop nor Check uses the target attempt as its own flow.
Closed stages distinguish request, accepted/no-op/unknown reply, rejected request,
readback, inactive/active/unknown target and committed visible feedback. A lost
reply permits a bounded state read, never an automatic second Stop RPC. Round
identity is compared by timestamp instant rather than textual timezone spelling.

`catalog_stops` in SELECT-only inspect/investigate separates browser-reported
acknowledgement, readback and visible result from the existing authoritative
attempt projection. No new Stop queue or server receipt ledger is introduced.
The browser relation is an observation, not a causal server Stop receipt. A target
terminal never replaces a Stop terminal, and Stop UI completion never replaces
the update terminal. Cancelled/inactive does not prove native child termination
or provider quiescence; existing execution/upload fences remain authoritative.

Lookup is bounded to 501 UI rows (500 output), 20 target identities, and fixed
feature/flow predicates. It uses the canonical `analytics_events.flow_id` column;
parent/origin remain bounded opaque properties. Missing/invalid identity,
conflicting relation, unavailable view, delayed delivery and cutoff limitations
remain explicit. Event cutoff includes occurrence and receipt time. Target state
is a current snapshot with terminal-time filtering, never reconstructed history.
Only opaque identities, closed stages/codes and times are returned; no URLs,
settings values, file names or provider payloads are collected. Beta telemetry
remains disabled; producer → sanitizer → actual SQL → SELECT-only diagnosis is
verified with isolated fixtures. Manual beta acceptance remains separate.

## C3. Native contract і variants

Native claim передає фактичні supported versions/capabilities installed agent.
Proxy не підставляє свою версію замість executor. Missing capability ⇒ legacy;
unsupported video-set/publication writer не claim нову роботу і повертає зрозумілу
вимогу оновлення. Source/settings version зафіксовані для всього set.

Child identity generationId + videoVariantIndex стабільна через attempts. Один
heavy child/set, lazy grant перед фактичним download/upload, shared machine governor.
Кожна variant — окремий output material/receipt; візуальна унікальність кадрів не
гарантується, якщо вибрані налаштування/пул дають однаковий вигляд. Готові outputs
не генеруються заново; expired доступ оновлюється без нового відео, якщо можливо.
Нема гарантії старту локальної обробки без доступного authorized agent:
до підготовки — waiting_agent; після підготовки server publication незалежний від нього.

## C4. Screen recovery і error semantics

Підтверджені candidate-local причини — not found, candidate-specific forbidden,
source identity mismatch, invalid/checksum/decode/unsupported image. Вони дозволяють
reselect в authorized pool. Відсутність membership, спільний auth/network outage,
local no-space/write failure зупиняють перебір із конкретною дією.
Expired grant оновлюється для тієї самої identity, не дискваліфікує файл.
Already valid slot лишається; exclusions прив'язані до candidate+version+slot.

Нормативні початкові shared bounds (технічні рішення, не нові продуктові опції):

| Budget                             | Межа                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| Distinct candidates per child/slot | 32                                                                                  |
| Transient retries                  | 2 після initial на candidate, максимум 6 на child/slot сумарно                      |
| Expired-grant refresh              | 1 на candidate, максимум 2 на child/slot сумарно                                    |
| Download bytes per child/slot      | 5 × `RESTITCH_SCREEN_MAX_BYTES` (зараз 250 MiB); partial bytes також рахуються      |
| Active network I/O per child/slot  | 120 s сумарно; offline/queued час не рахується                                      |
| Decode preflight                   | base 20 s на candidate через `governor.scaleTimeout`, managed process               |
| Cross-attempt refusal TTL          | 24 h від доведеної file-specific відмови; skip не продовжує TTL                     |
| Refusal-memory bound               | 512 записів на team/source-settings-scope/slot; deterministic oldest-first eviction |

Перша вичерпана межа завершує selection із budget code. Retry/recovery тієї самої
операції не скидає consumed counters; reservation записує candidate до I/O.
32 спроби — верхня межа, не гарантія перевірити 32 файли попри byte/time budget.
Новий звичайний click отримує новий attempt budget, але спершу виключає відомі
незмінені bad versions через refusal memory. Scope ключ: team, source-pool ID/version,
settings digest, slot, candidate ID/version. Cross-child та cross-attempt reuse
відмов можливий тільки в цьому scope. Global/network/disk failure не потрапляє в memory.
Валідні slots не redrawn. Якщо всі кандидати лише remembered bad, UI прямо називає
попередні перевірки і пропонує зміну пулу або окреме «Перевірити знову».
Ця явна дія, expiry або version/settings change дозволяють перевірку; ordinary retry
не скидає пам'ять. Successful validation очищує відповідну file-version відмову.

Decode має максимум 16 000 000 pixels, узгоджено з чинною catalog image validation.
Cached file перевіряється за identity/checksum та bounded full image decode
(не тільки metadata probe). Corrupt cache видаляється і отримується наново один раз
у тому самому budget, перш ніж source буде визнано непридатним. Truncated-but-probeable
image має провалити preflight. Якщо image-specific defect виявився пізніше, тільки
доведений failed processing до upload може перейти до нового selection/child attempt;
unknown/accepted/uploaded processing не replay. Нормалізований screen artifact,
перевірений декодером, використовує той самий backend, що й restitch.

UI: заміна картинки є progress, не кінцевим error toast. All-candidates-unusable
дозволений тільки після перевірки всього eligible snapshot; budget reached має
окремий code/текст. Known cause не маскується generic «сервер відповів несподівано».
Невідома причина лишається unknown з діагностичним ID.

Нові machine codes реєструються в closed `packages/shared/src/types.ts`, uk/en,
`scripts/analytics/code-map.ts`, producer guards і tests. Семантичні групи:
VIDEO_VARIATION_COUNT_INVALID, RESTITCH_REQUIRED, SCREEN_CANDIDATES_EXHAUSTED,
SCREEN_SELECTION_BUDGET_EXCEEDED, VIDEO_SET_NOT_READY, VIDEO_OUTPUT_UNAVAILABLE,
PUBLICATION_TIME_INVALID, PUBLICATION_CONFLICT, CATALOG_WRITE_CONFLICT,
CATALOG_WRITE_UNSUPPORTED, CATALOG_WRITE_UNKNOWN, EXECUTOR_CONTRACT_UNSUPPORTED.
Names — proposed additions; existing equivalent codes перевикористати без alias drift.

## C5. Time, held і edits

Дати/час з calendar input інтерпретуються в видимій IANA zone; default — поточна
zone користувача. Server повторно обчислює UTC instant, звіряє local+zone+offset.
DST gap — validation з пропозицією часу; fold — явний вибір одного з двох offsets.
Зміна browser zone не пересуває збережений due. Для нового/rescheduled intent
past time відхиляється за serverNow; «Додати зараз» обходить цю валідацію явно.
Retry already accepted job після due не відхиляється як нова дата в минулому.

One-shot job не є recurring interval. New unchecked creation — immediate; cancel
scheduled — held. Вимкнення checkbox у pending existing job відображає cancel/held,
не неявне Add now. Published one-shot consumed; наступні updates звичайні.
Переходи: held→scheduled дозволений явним setCatalogVideoPublication з новою
валідною датою; held→immediate тільки publishCatalogVideoNow. Scheduled→scheduled
є reschedule, scheduled→held є cancel. Applying/unknown спершу reconcile;
жоден із цих переходів не може заднім числом скасувати вже delivered write.
Новий delay для вже published каталогу стосується майбутньої заміни, не стирає
поточні URL. Empty-field guarantee стосується нового, ще не published каталогу.

## C6. Writer і verification

Перед provider IO: authoritative recipe/policy revision, current ACL/entitlement,
живі outputs, current reservation/fence; before due/held не додавати нових URL.
Only video fields targeted by delayed publication change; актуальні nonvideo поля
і row recipe зберігаються. Product count change ⇒ rebind new assignment або blocked.

Owner clarification (2026-11-08): existing table/file URL remains unchanged.
Prepare and retain immutable links privately; create the catalog with blank video
cells; at due write only the existing video-link product cells. Do not recreate
or replace the sheet, update nonvideo cells, change formatting/headers/IDs/grid,
or require Soty ownership of user product IDs. Routine updates preserve actual
video cells until the explicit publication worker replaces them.

Use Sheets spreadsheets.batchUpdate with narrow UpdateCells `start` and
`fields: userEnteredValue`, plus an original-fence developerMetadata receipt in
the SAME atomic batch. The old full-XLSX/Drive media paths remain prohibited:
actual provider tests showed cells changed despite HTTP412. Preserve that failed
proof; never interpret412 as no-mutation evidence. Sheets atomic batching is NOT
external-cell compare-and-swap. Fresh exact header/sheet/unique-ID proof and
stored ID→URL assignments are required immediately before dispatch; reordered
products keep their original URLs. Missing/added/changed IDs or headers block,
without structural repair. Collaborator races remain explicitly unobservable
until readback; do not claim arbitrary concurrent structural-edit protection.

Only exact marker AND complete current ID→URL readback can settle verified.
Unknown/missing/duplicate marker, partial cells, provider/source access loss or
changed headers remain unknown with the original fence retained; never blindly
repeat a dispatched batch. Only verified settlement changes active target.
Private URL preparation runs before due in the existing cron lane, with no
additional queue. Deduplicate original output identities and admit small
concurrent proof batches within the tick budget. A healthy proof has no artificial
per-output delay. Reuse eager proofs observed within five minutes of the original
due-validation epoch; older proofs join that immutable epoch. Successful proofs
are not discarded by a rolling TTL while the tail finishes (N400 liveness).
Expose the first/last source observation window and current database identity/ACL
checks; these observations are not simultaneous external-file CAS. An epoch
exceeding one hour before dispatch blocks visibly instead of looping forever.
Only after all required original links are privately prepared may exact Sheet
readback and video-only dispatch proceed. Verified ordinary refresh may rebind
public IDs under the same catalog fence, retaining URL per exact ordered internal
recipe; dispatched/unknown publication can never rebind.

Real-provider acceptance must prove only video cells changed, manual nonvideo
edits survived, before-due/held made no writes, same file/URL remained, and lostACK
reconciled without another apply. Keep capability disabled until this proof.

Timeout/dispatched unknown тримає reservation; дубль/інший worker не робить новий
write. Lease expiry не доводить, що HTTP перестав виконуватися. Provider content
readback звіряє recipe, row IDs, N assignment і video cells; marker недостатній.
Cancel/reschedule під час dispatched write спершу settle; якщо результат уже
published, UI повідомляє це, не обіцяє заднім числом скасування.

## C7. Download/share delivery

Bytes/export path визначається доведеним типом каталогу. Не будувати URL з
неперевірених полів/IDs. Share permission verified і URL available — різні факти;
clipboard copied додається лише після resolved clipboard write. Local OS disk-save
приймається лише за власним verified receipt; browser anchor handoff — offered,
а фактичне browser save невідоме. UI не потребує технічних слів receipt/fence.

## C8. Diagnostic path

Correlation: flow → catalog intent/update attempt → videoSet → child index →
operation/attempt → publication policy revision/job → provider receipt → UI delivery.
Stage vocab: requested/validated/accepted/selection/preflight/processing/uploading/
registered/table_ready/waiting_time/waiting_dependencies/applying/verified/visible.
Terminal discriminates success/partial/failed/canceled/interrupted/unknown, зі safe
reason, recovery, event and observation time. Ефективний settings snapshot дозволяє
назвати опції перезашивки; контент/URL/media names не збираються.

Existing `catalog`, `inspect`, `investigate`, `journal`, `audit` розширюються без
нового довільного SQL. Звіти мають source capabilities, delivery lag, truncation,
missing sources, observed_current vs event history і denominator. Native terminal
не доводить browser delivery; journal join має врахувати parent/child, не лише generic
tariff reservation. Producer exception не блокує користувацьку дію.

Verification: real producer → sanitizer → ingestion → stored rows → SELECT-only
CLI на ізольованій synthetic DB; окремо real beta UI/Drive readback. Жодного ввімкнення
production telemetry в beta, жодних grants або сирого provider content у fixtures.

### Durable manager Run/Retry intent (T024, additive)

`request_team_catalog_update_command(team, command, catalogs, expected_actor,
source_attempt)` atomically seals one immutable acceptance receipt and binds each
accepted catalog to its actual update attempt. The same key and canonical payload
replays that receipt after the round finishes; a changed actor/team/payload is
refused. A retry has exactly one catalog and a source attempt. Command acceptance
never proves provider delivery or UI visibility.

The browser retains only command/catalog/source-attempt UUIDs and creation time,
separated by confirmed actor and team, before dispatch. Storage failure refuses a
new request. Unknown commands do not expire into assumed failure. Limits are 500
catalogs per command, 50 retained commands per actor/team, four concurrent requests
or lookups, 2,000 examined storage keys and 25,000 characters per stored record.
Waiting for an acknowledgement and its one readback is bounded independently.

`get_team_catalog_update_command` is view-authorized, actor-bound and read-only.
Null means no observed committed receipt; the original request may still commit.
Reopening performs one bounded lookup pass, without replaying a mutation or adding
a polling owner. Every acknowledged catalog, including zero accepted work, waits for a registry read begun after acknowledgement
before another run is allowed; an older in-flight read cannot unlock it.

`cancel_team_catalog_command_intent` serializes on the same command identity. It
seals a cancelled-before-acceptance tombstone, or returns an already accepted
receipt. It never stops that accepted update. Stopping an active update remains a
separate observed-round command. Closing a window does not cancel server work.

Restricted immutable analytics views expose identifiers, counts, closed reasons
and acceptance time only. `inspect` joins by command, UI flow/attempt and actual
update attempt. Browser completion is an observation of visible acceptance;
`production_completed=false` prevents that acknowledgement from being presented
as verified catalog production. Missing, delayed or truncated evidence remains
explicit.

### Material Get-link / Share protocol v2 (T010–T011)

Get-link is a read: it obtains a provider-verified HTTPS Drive/Docs URL and never
creates permission or saves sharing consent. URL availability, current public
access, confirmation persistence and clipboard delivery are independent facts.
Restricted URLs remain selectable and openable; permission-list failure does not
hide a separately verified URL. Share inspects first, then uses explicit consent
or an already remembered approval. A new remember checkbox starts unchecked.
Legacy callers without actor/version binding can read only.

A modern permission request binds expected actor, material/connection/provider
identity, observed opaque share version and remember choice. Its immutable key is
`share.v2:<server-anchored issuance milliseconds>:<UUIDv4>`. First use has a
five-minute DB-clock window. Completed same-key replay never gets another write
permit; changed payload is refused. One unknown request holds each provider file,
including material aliases. A final provider read preserves existing public
reader/commenter/writer access. Permission creation is never retried. A consumed
permit proves only that a write may have started, not dispatch or attribution.
Acknowledgement and later observed public access remain separate evidence.

Check performs reads only, including after lost responses or reload. A public
observation can settle a pending request, without attributing another actor's
permission to it. Missing clipboard permission never repeats Share. Actor/client/
permission scope changes fence late results before copying or rendering them.
Completed/blocked requests and idle authorities expire after 31 days in bounded
batches of at most 100 total; unknown writes do not expire. Opaque UUID versions
and issuance-window checks prevent expired keys becoming fresh write permits.

The restricted `analytics_material_share_intents` projection contains opaque
request/actor/team IDs and bounded states/timestamps, not provider IDs, raw keys,
URL or hashes. `investigate` discovers the ten newest owned server requests even
without browser events. `inspect` keeps immutable UI observations separate from
current mutable receipt state; a historical cutoff cannot reconstruct that state.
Readback and clipboard actions have their own flow IDs and reference the original
request through `parent_flow_id`; child failures never replace its terminal.

## C4.1. Recovery budget boundary (T016 implementation contract)

The shared selection kernel is a versioned, immutable transition model, not an
execution queue or an authorization seam. One private row belongs to an existing
cloud team operation and one screen slot. Only a service-side compare-and-swap
may persist a transition. A candidate reservation commits before issuing its
transfer grant or starting provider I/O; repeated request IDs are readback only.
Unsettled reservations survive restart and prevent fresh I/O or candidate changes.
The server measures transferred payload prefixes and active fetch/read waits;
client-reported byte/time counters cannot settle accounting.

Transfer ranges have a fixed server-selected size (2 MiB, except the final range),
so a caller cannot grow an unbounded ledger with advancing one-byte requests.
The ledger bounds transfer records as well as candidates. A failed range can be
retried from its original offset; its discarded prefix still consumes the same
byte/time budget. Reacquiring an evicted accepted artifact keeps its candidate
version and consumes the same retry and byte/time budget, without redrawing the
opposite slot. Stale acquisition reports cannot invalidate a newer validation.

Selection and refusal authority bind the authenticated processing actor separately
from the owner of a frozen recipe. Refusal hints are private to that actor, team,
source-pool configuration, slot and candidate version. Stable opaque version
handles support correlation across ordinary clicks; raw checksums, provider IDs,
URLs, tickets and filenames never enter analytics. A truncated candidate snapshot
cannot prove every eligible candidate unusable.

Manual local restitch delivery must acquire an existing kind=download cloud
operation without obtaining process/upload permissions. Its native display ID
and cloud UUID remain separate identities. Background updater and Launch paths
bind to their own accepted immutable recipe, never a later workspace default.
The actual installed binary advertises recovery support; unsupported executors
are refused before claim, lease or processing. Existing legacy/default behavior
remains available through its own contract until this new capability is complete.
A new shared kernel alone is not evidence of any wired recovery path.

## Installed-executor pre-claim boundary (working increment)

Browser updater claims probe the current installation's teamWorkspace, stitcher,
imageEmbedding and teamRestitchSources contracts before requesting work. Missing
source capability is legacy1 only when the baseline tools are usable. Unsupported
or malformed capabilities refuse; unreachable health does not take a cloud job.
The web advertises the intersection of its protocol and the actual installation,
never its own source constant alone. Legacy library work remains compatible.

The browser uses `drive-ops/updater/claim-as-actor` with expectedActorId captured
before health and refusal-history reads. The server compares it to the current
JWT actor before the existing claim handler. Desktop recovery credentials cannot
use this new user route. No older unguarded-route fallback is permitted. Actor or
access-epoch replacement blocks subsequent reads and handoff. A late accepted
job remains held under the original server authority; it is not dispatched under
the replacement account or silently re-claimed.

The content-free catalog_manager_restitch_claim flow correlates probe/request and
claim_refused, claim_idle or claim_accepted. Its terminal acknowledges only this
claim step and always carries production_completed=false; it never emits
result_visible. Native background claims and full durable screen-selection
protocol negotiation remain separate unfinished boundaries.

## C4.2. Selection-storage foundation (unwired)

The first storage increment admits only an existing manual download/process root.
Its immutable source/team/actor binding is checked against the cloud operation;
automated updater/Launch operations are explicitly refused until their immutable
logical-preparation acceptance and executor-alias proof are implemented.
No public root initializer, native capability or user path is enabled here.

The service-only read/CAS/bookkeeping signatures are:

- service_read_restitch_selection_slot(root, team, actor, slot): canonical scope
  echo plus strict version1 budget; missing state never becomes an empty budget.
- service_cas_restitch_selection_slot(root, team, actor, slot, expected, next):
  exact state under lock, current permissions/source and one canonical kernel
  transition. Only literal true acknowledgement permits a newly reserved range.
- service_settle_restitch_selection_range(root, team, actor, slot, request,
  expected_reservation, measurement): the already issued range only. It cannot
  select a candidate, issue a grant or add a range. Trusted server measurements
  may settle after parent cancellation/access revocation. Lost acknowledgement
  may be confirmed read-only against the exact reservation and measurement.

Service RPC builders are PromiseLike. A lost reservation acknowledgement or a
failed compare-and-swap is never rebased into fresh dispatch. Fixed2MiB ranges,
50MiB per candidate,250MiB and120s active upstream waits per slot,32 candidates,
two per-candidate/six total retries, one per-candidate/two total refreshes and
956 maximum transfer records retain the existing shared kernel values.

Private rows have forced RLS, no direct browser or service table grants and the
existing cleanup-reference fences. Candidate snapshots are frozen before use.
Missing pool completeness remains unknown; it never proves every image broken.
Actual protected reader, accepted recipe/pool authority, durable refusal memory,
logical aliases, diagnostics and all product-path wiring remain separate work.

Reacquisition also covers lost local prefixes of an unvalidated active candidate,
after at least one settled range in that acquisition. It increments the same
per-candidate/global retry counters, preserves all prior measurements and does
not set acceptedVersionId or validatedAcquisition. Unsettled ranges still block
reacquisition; a fresh selection with no work cannot consume a restart. Parsing
requires retained transfer evidence for abandoned unvalidated acquisitions.

Native background claims likewise declare the installed executor's compiled
restitchContractVersion. Absent is legacy1, malformed values refuse before claim
authorization and the server intersects the declaration with its own support.
It never substitutes its current version for an absent client declaration.
A durable Drive-screen replay is also refused for a legacy executor without
claiming another job. Existing library replays remain compatible. The broker
maps the updater's outdated-client refusal to AGENT_UPDATE_REQUIRED, which the
existing worker records as blocked/needs_agent_setup without a retry storm.
This does not advertise the unfinished durable-selection recovery capability.

## C4.3. Measured range and frozen source authority (working, unwired)

`service_read_restitch_selection_source(root, team, actor, slot, version,
acquisition)` is service-only. It echoes the exact logical scope and resolves
credential/source context from the private frozen candidate. It requires the
current processing actor's rights, an active parent operation and the same active
candidate acquisition. It does not select, reserve, refresh or issue credentials
to an HTTP caller. Missing or malformed state remains unknown/refused.

The frozen candidate records connection, provider file, resource key, accepted
parent and connection root. Metadata-only provider version changes preserve
content identity; changed checksum/size/MIME, mapping, parent or connection root
refuses. The reservation CAS repeats the current mapping/root checks to close
the context-read race. Current provider metadata and live ancestry are checked
again inside the protected reader before media access. Native checksum and decode
validation remain required; accounted range completion is not image validation.

The service adapter preloads DB context and credentials outside the I/O meter.
A new acknowledged reservation is required before OAuth, metadata or media I/O.
OAuth/metadata and image transports are distinct: only the exact frozen Drive
file, GET and reserved Range may be the image response; one reservation permits
at most one media dispatch. Untracked/control responses cannot be forwarded as
images. Returned bytes are buffered within the fixed range and exposed only
after exact server settlement or confirmed readback. Failed/late/canceled reads
retain known prefixes; an unquiesced read or close holds the reservation. Active
fetch/body waits include OAuth/metadata and exclude DB, CPU and backpressure.
Clock rollback or an unknown/over-limit measurement cannot become zero usage.

This is still an internal boundary. Accepted recipe/pool construction, stable
version registry, root aliases, retention, a dedicated grant and installed native
capability, all execution-path wiring and manual acceptance remain unfinished.
No generic download/upload grant can activate this code.

## C4.4. Internal manual-download admission (source-only)

The service-only accept/read signatures are
`service_{accept,read}_manual_restitch_download(team, actor, material, key,
client_operation)`. They are not browser RPCs or native grants. Accept atomically
creates the cloud download operation and frozen root before any selection or
provider I/O. Read cannot initialize a missing root. Reuse binds the exact actor,
source material and separate local display UUID; changed request identity refuses.
An existing operation without its root remains unknown and cannot acquire a new
budget. No process/upload right is obtained by a download-only caller.

A registry supplies stable opaque versions by actual team/connection/file and
checksum/MIME/size. Namespace configuration is separate: actor plus semantic
settings and declared sources, excluding resave metadata and sampled randomness.
The immutable root recipe stores one actual sampled duration, source content
binding and bounded pool observations. Missing metadata, unresolved sources and
truncation cannot establish all images unusable. The5001st folder/image or501st
eligible image marks observation incomplete. Candidate snapshots retain each
actual provider copy instead of deduplicating only by checksum.

Protocol1 manual downloads compare their accepted source content/binding, allowing
metadata-only provider versions. Legacy process roots retain their version policy.
Disabled slots are explicit in diagnostics. Source-only deletion fences preserve
active recipes and unknown ranges; a terminal protocol1 parent is not proof of
native quiescence. An owned-executor/epoch and retirement protocol, dedicated
capabilities, native handlers and automated-root aliases are prerequisites to any
user-callable initializer or advertised support. These remain unfinished.

#### C4.5 — Owned execution boundary (internal, beta storage verified)

Protocol 1 actions require the original executor UUID and monotonic epoch. Both
active reads (including no-op transitions) and CAS repeat current actor, parent
and content authority. Read-only bookkeeping and exact settlement remain possible
after cancellation. Claim receipts preserve the original native instance and
epoch across retries; historical claims never reactivate and historical closure
acknowledgements cannot close a later owner. Missing executor accounting remains
unknown. No timeout alone allows takeover. A service-only quiescence receipt
requires a future controller to observe all local requests and managed children
stopped, plus no held server ranges; the RPC alone is not that proof. Capability,
public endpoints and retention relaxation remain disabled until native acceptance.

### Existing lifecycle actions: versioned execution scope

Lifecycle Edge work uses `(intentId, executorId, epoch)` independently of native
screen ownership. Capture the context epoch before awaits and compare it once in
claim admission; never borrow a newer epoch after a lost reply. Missing claim
acknowledgement permits only exact readback. Modern begin, checkpoint, close and
failure callbacks reject old epochs, including a repeated executor UUID. Legacy
callbacks cannot mutate an adopted modern scope.

A pending provider dispatch blocks every replacement. With no issued dispatch,
a transactional epoch fence can supersede metadata work because all its future
PATCH calls require the matching begin RPC. This is not native quiescence: it
must not be reused for local child processes, decoding, downloads or output saves.
Cancellation and admission lock the same parent. Late exact bookkeeping may close
issued work after cancellation or access revocation without creating new I/O.

The read-only view exposes the current protocol and epoch; legacy, absent and
malformed ownership remain explicitly unknown. Current counters do not reconstruct
old request outcomes or prove visible delivery. Historical lifecycle receipts and
current material-generation reconciliation remain a separate unfinished boundary.

## C4.7. Dedicated screen transfer authority (working, not advertised)

Migration162000 is private preparation only. Each screen range grant binds the
original root/team/actor, slot, stable candidate version and acquisition, request,
executor epoch and native instance. Issue commits the original budget reservation
and token hash atomically. Purpose-separated HMAC tickets cannot be used as generic
download/upload, source or control authority. No public route or capability is
introduced by this increment.

Consumption uses a fresh server-generated invocation UUID, never a native-provided
nonce. One issued row can become consumed once. An original invocation that loses
its acknowledgement can read its exact consumption; another invocation receives
no dispatch permission. The protected service reader then rechecks current owner
and frozen source, measures provider work and settles before exposing bytes. It
uses the original reservation without reserving again. An unconsumed abandoned
row has authoritative zero cost; consumed but unconfirmed work stays held. Expiry
never proves nonexecution. Refresh of an expired unused ticket must consume the
same candidate/global durable refresh allowance before another grant can issue.

The restricted selection projection adds only total/issued/consumed/abandoned
counts. Grant state changes advance its observation time, so as-of cannot present
a later consumption as an earlier state. Legacy schemas expose unknown counters,
not invented zeroes. Consumed authority is not proof of provider I/O, settlement,
image validation, processing or user delivery. Raw ticket/hash, provider identity,
credentials, checksums and content are never diagnostic fields. Native control,
observed child quiescence, retained refusal outcomes and full product acceptance
remain separate open work.

## C4.8. Protected native cache seam (working, not advertised)

A cached screen is available only after a fresh exact service acknowledgement of
root/team/actor, DB namespace UUID, executor epoch/native boot, slot, stable content
version, acquisition and checksum/MIME/size. Capture primitive bindings and loader
methods before awaits; reject missing, inherited or substituted receipt fields.
The namespace is the actor-bound database handle, not a concatenated oversized
client fingerprint. Rejected authority cannot use cached bytes as a fallback.

Dedicated screen transport must supply its own validated local source; never
represent a protected ticket as download_range or process_input. Warm/fresh cache
paths keep actual MD5 and bounded full decode checks. A valid cache is not proof
of a fresh provider observation, processing or delivered output. Provider work
still uses the durable server-owned reservations and measurements.

Remember protected failures by stable version UUID per namespace/slot. A metadata
correction is eligible as a new version even if MD5 is unchanged; legacy checksum
consumers must not reinterpret that refusal. Persist only bounded existing cache
metadata and use opaque root/slot/version IDs with closed reasons in diagnostics.
Atomic image staging must distinguish simultaneous writes even within one clock
millisecond. No route/capability is advertised until control/source authority,
actual executor ownership/quiescence and full diagnostic/product paths pass.

## C4.9. Native protected screen delivery (working, not advertised)

Dedicated screen permits bind the exact captured C4.8 identity, original persisted
request/grant IDs, purpose, acquisition, offset and at most2MiB. Native does not
use its clock to renew or invalidate service authority. It refuses redirects,
substituted permit scope, response request correlation/range/size/MIME and changed
actual bytes. The server supplies its original reserved request ID only after
measurement and settlement. Source MD5 is checked over bytes actually written.

There is no implicit HTTP retry or ticket refresh. Unknown issue acknowledgement
stays accounting-uncertain; an original request reference survives network failure.
The outer controller must reconcile before any same-version reacquisition or new
draw. Cancellation joins the original reader/cancel promise; abort requested is
not quiescence. Failed cancellation remains uncertain. Public errors expose only
closed reasons and an opaque original request ID, never token/provider content or
local path. The full cache still reauthorizes and decodes before acceptance.

The recovery coordinator snapshots the requested slots, parsed candidate content
and validated result before awaits. A retained mutable provider object cannot
change which file or path an acknowledgement accepts. This internal increment
does not expose a route, capability or product producer.


## C4.10. Native executor and exact closure recovery (internal increment)

`NativeRestitchExecutor` owns a root before any authority mutation: it captures
root/team/actor/claim and the trusted constructor's native boot UUID, persists
the original claim, and admits work only after exact owned receipt persistence.
Each activity promise is registered before its factory runs. A cancellation or
global failure closes activity admission; cancellation remains distinct from the
original global failure. The executor joins original promises and registered
cleanup before requesting remote closure with one persisted UUID nonce. Local
callback return, cancellation requested, a child error event, elapsed time and a
terminal UI state are never substitutes for observed closure.

The metadata journal is environment-scoped, at most64 records/64KiB, strips
unknown content, reads from one bounded original file handle and serializes
atomic staged replacement. It claims process-interruption durability only, not
directory-fsync/power-loss durability. Missing/corrupt metadata cannot close a
remote claim. Unfinished records restored from disk remain blocked; no timer or
new native boot may turn them into zero prior activity. Unknown records are never
evicted to admit another root.

A live process may reconcile its own already joined activity using the same
identity, owner epoch and persisted closure nonce. Concurrent reconciliation
requests share original completion; shutdown joins them. Reconciliation never
runs the callback again, creates another claim or redelivers its result. A
restarted journal or unknown claim lacks this process-local stopped observation
and cannot use this shortcut. A confirmed remote closure remains bookkeeping
evidence even when a later actor change prevents returning a result to the UI.

The internal service closure adapter captures all arguments before awaiting,
reads the exact original claim/native instance, requires its executor and epoch,
and accepts only boolean true from `service_quiesce_restitch_executor`. A missing
receipt, substituted owner or malformed/lost acknowledgement stays uncertain.
The adapter itself neither repeats a close mutation nor creates a new owner.
An explicit live-owner reconciliation can repeat only the same closure nonce;
the existing SQL primitive acknowledges that historical nonce without closing a
later epoch.

These classes/adapters are not public grant authentication. Enrolled native-only
control, immutable control-grant-to-claim binding, current real Auth session and
entitlement checks for new I/O, manual/updater/Launch aliases and complete
producer-to-CLI diagnostics remain prerequisites to product wiring. No ordinary
JWT, generic transfer ticket, browser body or public status response may supply
trusted quiescence proof or expose native control credentials. No capability is
advertised by this increment.


## C4.11. Private native-control grant (beta manual candidate)

Migration164000 stores an immutable root/team/actor, real Auth session, original
enrollment, native boot and separate proof/control-token hashes. Only service
RPCs may issue/redeem/claim/read/quiesce/authorize. A challenge lasts2min; a grant
lasts at most24h; a root retains at most8 grants. Replay retains the original
window. SQL returns neither proof/token hashes nor a control credential.

The trusted enrollment factory obtains actor/session from verified Auth, never
from the body. The internal dispatcher retains the enrollment UUID as grant UUID
through lost replies. Every credential-bearing action rejects browser Origin
before SQL. Control tickets use the dedicated control MAC purpose, and native
proof hashes use a separate domain. The current candidate wires bounded beta hosting, verified Auth-session extraction
and platform credential persistence. Installed acceptance remains pending.

Claim and immutable control-to-original-claim binding commit together under the
parent lock. A new grant cannot adopt an existing claim UUID, including one from
the same native boot. Current authorization revalidates real session, workspace
rights, root/source identity and exact executor epoch. Unknown claim replies use
one exact read, never another claim. Late readback and same-nonce closure remain
possible after logout/cancellation; expiry and missing metadata cannot take over
an old owner. Real isolated HTTP logout/session-guard and same-boot claim/logout
lock races now pass alongside the full447-migration native gate.

Controlled image ranges bind grants atomically at issue and consumption; a prior
authorize call never substitutes for a consume-time session check. The candidate
advertises only the manual beta path, after its own installed acceptance. Automated
aliases remain unsupported by this capability and T017 remains open until every
required entry point has its trusted factory. Retirement, complete diagnostics
and user-delivery acceptance remain required for feature completion.

The dedicated source endpoint requires both the existing bounded download grant
and the enrolled native control. The download grant alone cannot authorize image
selection, protected source fetching or native ownership closure. The native
controller joins source transfer, processing, final authority check and cleanup.
Failed native terminals correlate to the cloud root through process_terminal;
unknown stages and missing journal delivery remain explicit blind spots.


## C4.12. Controlled screen leaf binding (isolated verified; beta pending)

A controlled range derives original root/team/actor/boot/owner from its private
control grant. The reservation, leaf grant and immutable control binding commit
in one transaction. An unbound historical/internal grant cannot be adopted.
Current real Auth session and exact owner are checked at consumption and before
each protected upstream request. A prior authorize response alone is insufficient.

The fresh server invocation stays internal. Original consumption readback is
bookkeeping and cannot authorize another invocation. An already settled range
cannot pass a new upstream check. The metered reader retains single payload
dispatch and actual prefix/time accounting. Exact late readback and known-zero
unconsumed abandon survive logout; consumed uncertainty never becomes zero.

The 448 isolated migration and native gate passed. The candidate routes these
wrappers only behind the default-off beta flag. Installed 449, diagnostic and
manual product acceptance remain pending. See reviews/restitch-controlled-screen-ranges.md for pending scenarios.

### Implemented pure contracts (writer integration remains separate)

`catalog-video-set.ts` now defines the canonical400-product limit, strict N
validation and assignment algorithm1. A64-hex-character seed is sampled once by
the generation owner. Canonical internal row UUIDs are sorted before a seeded
shuffle of balanced variant indices. Persist the returned seed/version/revision
and assignments atomically with their owner. Retry uses
`reuseCatalogVideoAssignment` on that stored mapping and refuses changed
membership, revision, N or seed; it does not draw another mapping. Missing PATCH
fields must be preserved by callers rather than routed through the legacy
read/create default.

`catalog-publication.ts` validates the explicit offset and UTC instant against
the calendar minute and IANA zone using a trusted server clock. The web draft
resolver reuses the existing calendar timezone seam and presents both fold
occurrences, with elapsed choices distinguished; gaps are refused. The shared
validator is the final request boundary, including after a client selection.
Unit/isolated PostgreSQL parity is recorded in
[the pure-contract proof](../reviews/catalog-video-pure-contracts.json).

These helpers do not persist configuration, advertise executor support, schedule
jobs or authorize provider writes. T031/T033–T041 and T043–T050 retain their
storage, ownership, diagnostic and installed-journey acceptance requirements.
The old failed provider conditional-write proof prohibits the old full-media writer.
The owner-clarified video-only Sheets writer needs its own real-provider proof
before activation; unit tests alone do not satisfy this acceptance.
