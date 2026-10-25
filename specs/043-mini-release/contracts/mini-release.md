> Historical full-scope design, deferred by the owner’s 3–4h MVP decision. Active requirements: [spec.md](../spec.md). This artifact does not expand the current implementation scope.

# Contract: mini-release CLI, identity and effects

## Public command boundary

Операторський вхід: `npm run release -- mini --source <commit-or-ref> --target <id> [--bindings <path>] [--prepare-only] [--json]`. Source ref один раз resolve до exact clean commit; target lookup із чинного configured bindings registry, production pinning незмінне. Read-only discovery генерує UUID, surface/agent/policy/plan digests і reviewable frozen intent. `--prepare-only` повертає intent та причини допуску без зовнішніх writes. Без нього явний mini invocation передає той самий intent у існуючий supervised `start`, застосовуючи всі activation/authorization gates. Повтор через `start --intent` використовує надрукований intent path; користувач не вводить hashes/plan IDs вручну. `--recover-web <archive-digest>` замінює `--source` для explicit recovery; mutually exclusive, target обов’язковий.

Чинні `npm run release -- preflight|start|status|report|cancel|resume` та JSON envelope/exit codes зберігаються. `preflight/start --intent <path> --bindings <path>` підтримують новий mini intent; full v1 поведінка незмінна. `resume` відновлює supervised worker або підтверджує живого власника; не лише змінює state. У `start` повтор того самого наміру приймає чинного worker; повний immutable digest іншого наміру → `RUN_IDENTITY_CONFLICT`.

Mini schema 2: поля з [data model](../data-model.md); mode=mini, operation=release|recover-web, no version/bump. Preflight тільки reads: source lineage, поверхні цілі, agent artifacts, pending plan, policy, activation prerequisites. Локальний draft intent/evidence може бути записаний без зовнішніх ефектів. Невідомі keys, arbitrary argv, caller-supplied approved/compatible flags та неповні hashes відхиляються. Recovery вимагає `recoveryArtifactDigest`.

У `start` actor авторизує саме frozen target/scope/candidate. Binding digest проходить CLI→controller→worker→adapter; production pinned, sandbox disjoint. Доступ до файлів intent не дає права підмінити policy, trusted verifier або credentials. Продуктовий commit не може змінювати власний mini admission verifier; така правка проходить окреме infrastructure deployment/acceptance.

## Registry / state contract

Mini steps у [data model](../data-model.md). У full registry немає mini ID і навпаки. State, status/report, recovery, resource classes, panel progress, metrics та completion count читають selected registry. Not-applicable — explicit receipt із причиною, а не fabricated packaging completion. Read-only `status/report` не беруть write-lock і не роблять network writes.

`mini_preflight`: поточні baseline/target observations і eligibility; `mini_checks`: common verify profile; `mini_rehearse`: DB/function transition, якщо потрібен; `mini_build`: changed exact artifacts; `mini_verify`: candidate runtime+packaged-agent equivalence; `mini_backend_apply`: declared transactional migrations/functions; `mini_activation_verify`: exact production-config critical control на вже застосованому backend до web activation; `mini_deploy`: exact prearchived web; `mini_live_verify`: actual version+visible control+unchanged channel; `mini_finalize`: CAS receipt/baseline update. Recovery для new-build/rehearse/apply зберігає not-applicable та перевіряє compatible archived candidate.

Operational scope: одна канонічна write authority/release host на ціль, із відповідними credential restrictions для CI/manual paths. Local fencing не захищає від іншого host/admin/provider UI; external drift — detection/unknown, не глобальна гарантія. Без цієї довіреної передумови mini admission blocked; distributed remote lease — окрема робота. In-flight provider command має бути завершений/звірений до takeover.

Full/mini/recovery/standalone backend apply використовують один target ownership namespace. Controller делегує fencing capability worker; ownership transfer не дозволяє двом writers. Загибель/boot/PID reuse перевіряються перед takeover; незрозуміла ownership блокує. На наступній write boundary старий generation відхиляється. Shared root не визначається довільним cwd або per-run store override.

## Eligibility contract

Результати: eligible, requires-full, requires-separate, insufficient. Відмова має stable code, evidence references, останню доведену стадію й наступний безпечний крок.

Protected facts: agent source/build/runtime/package/config/contract inputs, signed raw manifest bytes, signing identity, agent dependency closure. Release identity derives from shared contract, never new duplicated constants. Shared/lockfile exceptions вимагають compiler resolution, unchanged reachable runtime/module side effects, relevant declarations та generated wire/validator fingerprints. Unknown construct/generator → insufficient; no path-only proof. Signed `WEB_TOOL_REQUIREMENTS` незмінний; новий локальний tool → requires-full.

Web-only немає backend writes/rehearsal; backend-only немає web build/upload. Functions включають dependency closure і pinned remote imports. Source ancestry з agent release обов'язкова; surface diff рахується незалежно від її deployed source commit. Mixed unshipped agent changes → requires-full; брудне дерево кандидата → rejected. Host working tree може бути брудним: frozen worktree будується лише з named clean commit, чужі незакомічені правки не включаються.

## Backend write contract

1. Exact changes/digests/dependencies/check IDs/recovery bind admission. Applied migration edits, missing/extra pending, linked project drift і stale surface epoch блокуються. Ознака compatible=true не proof.
2. Mini policy розпізнає тільки підтримувані transactional statements із коректним lexer для comments, quoting і dollar strings. Known destructive/rewriting/dynamic/unsupported SQL та nontransactional statements → requires-separate або insufficient. Existing RPC signature має зберігатися; name-only drop/create недостатньо. Function body дозволений лише в розпізнаному bounded subset зі scoped effects і конкретними old/new/role/postcondition fixtures; arbitrary procedural body не стає safe через одну smoke-перевірку.
3. Rehearsal доводить upgrade з exact deployed schema/function source snapshot, old/new rows, legitimate/denied roles, old RPC calls, new rows under old client, queued/background jobs та проміжний порядок. New isolated objects і nullable columns без rewrite — лише candidates, не auto-approval. У першій policy nontransactional/concurrent indexes і великий DML backfill виключені.
4. `mini/db-executor.mjs` використовує наявний `pg`, dedicated release credential `SOTY_MINI_DATABASE_URL`, explicit bound TLS endpoint і перевірений project/database identity. Secret registry/production config checks включають тільки ім'я/наявність; raw URL не потрапляє до журналу. SELECT-only analytics URL/роль відхиляються. Немає fallback на analytics writer, arbitrary SQL console чи `db push --linked`.
5. На кожній транзакції перевіряються exact remaining plan і migration history; `SET LOCAL lock_timeout='2s'`, `statement_timeout='30s'`; atomic reviewed statements + Supabase-compatible migration history. Відсутня можливість встановити/перевірити budgets → blocked. Absolute apply deadline 120 s і transaction deadline 30 s не скидаються між statements. Перед кожним SQL/history/COMMIT remaining budget зменшує server-side timeout до min(30 s, transactionRemaining, applyRemaining), із 5 s резервом history/COMMIT/observation. Немає залишку — rollback до нового statement, не нова транзакція. На deadline без відповіді COMMIT результат unknown; postdeadline дозволено лише bounded read-only reconciliation, жодного success/retry guess. [Ledger/deadline contract](migration-history.md) є обов’язковим. Dedicated connection closes/cancels bounded work; результат втраченого COMMIT unknown до fresh history+postconditions observation.
6. Prepared batch/per-transaction receipt fsync до write; functions також мають prepared receipt. Будь-який exception/timeout запускає independent observation. Matching → adopt; proven absent → bounded retry; conflicting/unknown → stop. Історія міграції без schema/data postconditions не matching. Function slug ACTIVE без exact normalized body/provider version не matching.
7. Незворотні зовнішні side effects, jobs/invitations, provider consent і production data backfill не виконуються під guise rehearsal/smoke. Synthetic control writes із cleanup лише у явно дозволеному ізольованому scope; production smoke не змінює реальні користувацькі об'єкти.

## Upload / current state contract

Canonical sorted file manifest має per-file hash, bytes/paths і outputDigest; artifact зберігається target-shared до upload. Public web identity embedded before hashing; outputDigest receipt outside bundle. Unchanged raw `stable.json` digest перевіряється у source, candidate, deployed bytes та recovery.

Cloudflare adapter зберігає exact target project/account, deployment ID і bounded run correlation; readback canonical deployment + origin required files/hashes не підміняється upload exit code. Supabase adapter звіряє explicit project/function provider version та downloaded body manifest з frozen source. Source archive/transform normalization має fixture proof; незрозумілий transform → unknown.

Finalize виконує compare-and-swap surface epoch; зберігає independent surface state при partial deployment. Completed local stage не замінює current remote observation. Later full release звіряє current receipts перед backend plan/web activation.

## Recovery and result contract

`rollback:web` підключається до цього admission/lock/receipt шляху. Flat `bindingId` та повна binding identity перевіряються. Архів current-channel-compatible, schema/function compatibility check, unchanged exact bytes і live verify обов'язкові; після rollback нова history/baseline receipt. Archive з іншим manifest не патчиться.

Smoke failure не запускає автоматичного rollback. Cancel зупиняє нові effects; in-flight immutable observation зберігається навіть після cancel. Unknown migration не переїжджає у success або автоматичний down. Recovery серверної функції потребує own checked plan; дані forward-only, нові записи не втрачаються.

## Migration bookkeeping and executor

Обов’язкові [migration-history](migration-history.md) та [executor](executor.md) contracts: жодного самописного history split, невідомої vendor schema або same-user secret isolation.

## Closed error families

`MINI_INTENT_INVALID`, `RUN_IDENTITY_CONFLICT`, `TARGET_BINDING_CHANGED`, `TARGET_OWNERSHIP_CONFLICT`, `STALE_FENCE`, `BASELINE_UNPROVEN`, `BASELINE_DRIFT`, `AGENT_IMPACT`, `AGENT_PROVENANCE_UNPROVEN`, `SHARED_IMPACT_UNKNOWN`, `POLICY_UNSUPPORTED`, `BACKEND_PENDING_SET_MISMATCH`, `BACKEND_CONTENT_MISMATCH`, `BACKEND_INCOMPATIBLE`, `DB_BUDGET_UNENFORCED`, `EFFECT_AMBIGUOUS`, `ARTIFACT_CHANGED`, `EVIDENCE_EXPIRED`, `MINI_ACTIVATION_NOT_PROVEN`, `CONTROL_RESULT_UNPROVEN`, `RECOVERY_INCOMPATIBLE`. Існуючі коди перевикористовуються, нові додаються до typed closed boundary та code map. Human subject sanitized/bounded; ніяких raw provider payloads.
