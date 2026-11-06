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

Provider mutation використовує compare-and-swap саме для media/content write.
Для scheduled/held replacement regular writer використовує active delivered target,
а не pending set. До першої публікації active null означає порожні video fields.
Лише verified settlement atomically swaps active target/assignment у SQL після
provider readback; pending readiness не перемикає чинний каталог. Original source
target перевіряється за доступом/version, video_set — за всіма N ready receipts.
Спочатку contract proof конкретного endpoint, потім implementation. Unconditional
fallback заборонений. Якщо provider не підтримує потрібну гарантію — blocked
CATALOG_WRITE_UNSUPPORTED і невиконаний acceptance gate; не заявляти успіх.
Pre-read, PostgreSQL fence, marker appProperties самі по собі не є provider CAS.
External edit conflict ⇒ refresh/readback, explicit conflict, без silent overwrite.

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
