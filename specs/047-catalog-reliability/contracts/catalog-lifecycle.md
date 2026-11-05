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

List results: validated rows + bounded invalid-row count/reasons + freshness/completeness.
Entire invalid response — INVALID_RESPONSE; mixed valid rows — partial. Run/retry
count=0 і cancel=false валідні no-op; malformed value не перетворюється в no-op.

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
