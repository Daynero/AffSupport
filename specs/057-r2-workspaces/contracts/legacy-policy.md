# Старий Drive-простір після переходу

## Рішення власника 2026-11-27 (переважає все нижче)

**До D = T0 + 60 діб** старий простір працює як сьогодні. Вибіркових блокувань немає, бо часткове блокування не працює: файли можна кинути напряму в Google Drive. Є лише банер із датою D і нагадування за 30, 14, 7 і 1 день.

**Від D** простір стає архівом. Одна серверна перевірка на всіх шляхах запису (веб, агент, прямі API, фонові роботи):

| Дія                                                      | Після D       |
| -------------------------------------------------------- | ------------- |
| читати, шукати, переглядати, відтворювати відео          | так           |
| скачувати, експортувати фінанси                          | так           |
| завантаження, правки, перейменування, видалення          | ні            |
| завдання, запуски, акаунти, фінансові записи             | ні            |
| нові каталоги, зміни каталогів, автооновлення каталогів  | ні            |
| синхронізація з Drive, фонові роботи простору            | зупинено      |
| люди й ролі: вийти, прибрати учасника, відкликати доступ | так (безпека) |

Таблиці каталогів лишаються на Google в останньому стані й далі працюють як стрічки в кабінеті, але Soty їх уже не оновлює. Архів автоматично не видаляється.

Таблиця нижче — дизайн від 2026-11-14, і вона більше не діє.

---

## (2026-11-14) Drive retirement and maintenance allowlist

T0 = first policy activation in production promote; T1 = T0+30×24h. Durable policy not reset by release retries/rollback. Day−14/−7/−1 and deadline notices supplement launch notice. Never send actual messages during planning. New Drive provisioning disabled from T0. Existing eligible writes continue until T1 unless that space already cut over.

| Action after T1, unmigrated Drive                                                                            | Decision                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| list/search/read/preview/download/export                                                                     | allow existing eligible items/versions, current role required                                                                                                                                                                      |
| reauth same root/account for maintenance/migration                                                           | allow; new roots/accounts or new Drive spaces denied                                                                                                                                                                               |
| change business metadata, new task/comment/finance/account/launch/catalog/folder, upload/copy/replace source | deny, including old client/agent/direct API and offline deferred finalization                                                                                                                                                      |
| rename/move/trash/restore original or business entity                                                        | deny in ordinary UI; security removal/deletion request and migration cleanup handled separately; no hidden content growth                                                                                                          |
| revoke member/invite/share, leave, cancel work, report issue, request deletion/export                        | allow; don't freeze safety controls                                                                                                                                                                                                |
| invite new person, raise role, transfer ordinary ownership                                                   | deny ordinary change; audited recovery owner transfer by admin when needed to regain lawful access, no new content entitlement                                                                                                     |
| schedule/manual refresh existing catalog                                                                     | allow under active existing commercial entitlement; start/stop/change cadence, prices/text/settings allowed only for same catalog and eligible sources/recipe family; cannot create new rows from fresh originals or broaden scope |
| regenerate technical publication/re-stitch of pre-cutoff sources                                             | allow bounded versions/temporary bytes under original rules, ref-count/cleanup/budget; no new reusable library material or creative automatic content                                                                              |
| automatic catalog content creating new creatives, replacement video, clone catalog, new publication          | deny; offer migrate/new space                                                                                                                                                                                                      |
| external Drive new file/version or deleted original                                                          | never admit new bytes into maintenance inventory; mark changed/unavailable, do not silently render new version; migration can explicitly inventory latest accessible version with owner consent                                    |
| migration after T1                                                                                           | allow to separate reserved slot/in-place logical identity; independent of client freshness                                                                                                                                         |
| billing renewal/credit, view tariff                                                                          | allow; no implicit new R2 space or content                                                                                                                                                                                         |

T1 capture cannot be an unbounded synchronous global job. Precompute inventory before T1, store per-team cursor/known revision snapshot, then atomic server deadline guard switches policy at T1. If a space's inventory is incomplete, its legacy catalog updater blocks with `LEGACY_SNAPSHOT_INCOMPLETE`; read/download of proven eligible entries remains available. A later bounded read-only reconciliation may complete only revisions proven at/before cutoff; unavailable historical versions stay unknown. Do not backfill a new revision as though it existed at cutoff. Existing pending uploads not committed before T1 are denied finalization, local outputs kept/exportable.

Every eligible byte read (download, preview, catalog input, migration range) uses a provider-supported pinned revision or a previously verified immutable copy. The current `files/{id}?alt=media` helper is mutable; a metadata check before GET is insufficient. If pinned reads are unavailable, download into bounded private quarantine, verify complete bytes/hash against cutoff manifest before exposing any byte, then serve that immutable version. Large files use resumable quarantine with revision/hash validation; never stream unverified mutable data directly. If no expected digest/revision can prove eligibility, return source unavailable. Add a same-size source mutation during the read test.

Google does not guarantee historical binary download for every deleted/replaced file. Pre-T1 optional protected copies of catalog-critical sources may preserve continuity with permission and budget; otherwise external change yields an explicit unavailable source. This is a limit of external ownership, not an excuse to import new content silently. Acceptance exercises changed bytes with identical filename/size.

Maintenance does not consume R2 workspace slots, but its existing paid updater entitlement is not silently made perpetual/free. Reading/downloading remains available during the transition independent of new R2 purchase; security suspension still applies. Existing signed grant periods respected. Post-T1 engineering supports security fixes and maintenance stability, no new Drive features. Final shutdown and token revocation need a separate decision after catalog bridges/migrations are resolved.
