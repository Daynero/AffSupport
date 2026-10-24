# T014 scope and integration checkpoint — 2026-10-23

Status: T014 integrated and validated in ROOT.157related/staticPASS;925pgTAP/38files plus14existing nativePASS, followed by5affected mail nativePASS after fixing runner URL forwarding. Live ROOT CLI verified; proof:`t014-root-integration-proof.json`. This maps the original adapter requirements without turning every neighboring acceptance task into another adapter requirement.

| Requirement | Evidence | Current result |
| --- | --- | --- |
| Loopback-only trusted recording adapter; no delivery credential bypass | Real local target/profile/stack/fixture checks; CLI refusal tests and retained-beta invocation | Proven in NEXT/live baseline359 |
| Existing claim/renderer/dedup path, redacted HTML/text for synthetic recipient | Actual SQL/file cases for7kinds×2locales; scheduled grace producer with real updater start/stop | Proven;113related testsPASS |
| Captured distinct from skipped and delivered | Live granted capture1/skipped1/sent0, receipt attempts1/sent_atnull; immutable artifact and idle replay | Proven; own row removed, original queue digest unchanged |
| Failures, retry and concurrency | Late-file replay, immutable conflict, lost commit distinction;5native tests including server idle timeout during17s JS freeze | Proven within documented test scope |
| Normal deployed beta/production behavior preserved | Trusted dependency absent from deployed index; existing worker/send regressions pass | ROOT integration and deployed-worker regressions verified |
| Source/artifact exclusion | Source guard and actual CLI guard tests | ROOT source/artifact hooks verified; remaining fault/teardown/packaged exclusion stays T016 |

Evidence: `t014-mail-updater-proof.json`, `t014-mail-live-variants-proof.json`, `t014-mail-process-stall-proof.json`, `t014-mail-deadline-proof.json` under the campaign drive-followup directory. Earlier failures remain retained privately.

ROOT integration included handler, optional tariffToday parser, production tariffNow=Date.now, mail-only CLI dispatch, private capture/clock-state precondition dependencies and source/artifact hooks. No clock command or migration was merged.21files were preserved with preimages/fresh destination checks; analytics inventory note was added without replacing concurrent owner changes. The exact local .env→.env.local alias is accepted only for a regular sibling whose bytes remain scanned; other links remain refused. Native runner now passes the generated disposable URL, and incomplete native configuration fails instead of silently skipping. The full database run initially skipped the5new mail cases; they were then run successfully against a fresh full360 clone. This is explicit affected-only validation, not a fabricated all-at-once pass.

Adjacent acceptance remains separate: T011/T012 own the live clock overlay, JWT/operational-time consistency and teardown; T044 owns complete owner-only UI/notice acceptance; T016 owns production isolation and fault lifecycle; T048/T170 own current full canonical/release evidence. Baseline359 live capture does not prove overlay behavior or a packaged release. Final campaign/report evidence remains unfulfilled until bound to its current manifest/source.

Known limit retained explicitly: uncancellable OS filesystem IO may keep the CLI process alive after its transaction is released. The5second asynchronous deadline and15second server idle timeout prove bounded transaction protection, not guaranteed OS process termination under every filesystem fault. This must not be advertised as fully verified process-exit behavior.
