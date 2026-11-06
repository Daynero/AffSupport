# Source-beta command walkthrough — 2026-11-06

Status: recovery/Undo observations passed; two real runtime defects found and
queued for repair. This is not complete feature or packaged-beta acceptance.
Code revision: `cf0835dd1251801e7efb4e3ecaadc30ed9c6784b`.

The owner requested a manual browser walkthrough after implementation and tests.
Before this walkthrough, all 13 static gates passed and the separately repeated
canonical seed/suite phase passed 8895 tests / 61 explicit skips. Its report is
`verification-suite-command-receipts.json`. The earlier full invocation's timeout
is retained separately, not relabeled as a single full green command.

## Environment

Real local beta auth and entitlements, agent 43140, web 5175, owned Colima 047.
Health identifies the code revision above, beta channel/environment, ready=true,
busy=false. The local project history contains the reviewed 421 migrations.
The temporary project-ID override remains outside commits. No production mutation,
profile reset, new permission, upload, trash action or unknown-operation replay.

The first cold restart failed Storage health; canonical down reconciled it and
a second canonical up passed all service checks. The original data volume was
preserved. In the later runtime interval only, per-column digests changed solely
connection updated/synced/reconciled timestamps and credential updated/last-used
timestamps. This does not reconstruct the older migration-window digest delta.

## Actual Chrome observations

A fresh incognito window authenticated with the real beta-owner fixture. DevTools
was used only for this tab's network emulation. Incognito survival across closing
the whole browser is not claimed; the tested reopen was the manager view itself.

1. Manager loaded 38 catalogs, two scheduled and two needing attention.
2. Double-clicked Run for QA v36. The UI showed Updating and Stop. Local readback
   proved exactly one command `af3249c0-74b1-4b0f-ad5f-6543d8fd747d` and one attempt
   `c0c185bc-c0f0-4ee4-9984-50b590030cfe`, with no verified provider delivery yet.
3. While that same attempt remained active, changed random-link On to Off and
   pressed Undo. The UI showed Saved, then On again. Profile version advanced
   9 → 11; the attempt kept its exact ID, active round and frozen profile version 9. Other effective settings and the absent schedule were preserved.
4. On QA v35, kept DevTools open with Network Offline and clicked Run. Its RPC
   failed; the UI retained an unknown request, named the catalog and disabled
   another Run/settings write. Closing DevTools detaches emulation, so the actual
   offline action was performed with it open, not after that detachment.
5. Closed/reopened the manager while still offline. The unknown request returned
   through read-only recovery. No server command or attempt for v35 existed.
   Its name was unavailable until registry data could reload; no name is stored
   in the UUID-only journal. The notice still showed the retained request count.
6. Restored No throttling and pressed Cancel unaccepted request. Server receipt
   `bfce4646-633e-4482-a23e-182b67f070d4` is cancelled_before_acceptance, with zero
   v35 attempts. The unknown notice disappeared and the list recovered to 38.
   A Retry click was not executed: automatic recovery removed that button first.
7. Opened v36 history. It still showed Updating and planned changes, without
   stages or provider success. The accepted operation was preserved for recovery.

## Defects requiring repair

- **Transport cause lost:** an actual PostgREST fetch failure becomes
  INVALID_RESPONSE in throwRpc, so the unknown notice says the server sent
  something unexpected. It must preserve a closed transport cause through the
  UI producer and SELECT-only diagnosis. The retained request must remain intact.
- **One stale row aborts a whole claim batch:** the old catalog
  `56f2a871-15e3-47e0-8b8a-28d4bd689c28` has an open round whose matching attempt
  is already failed. Its v2 image-attempt lookup correctly returns null. The
  index.ts Promise.all enrichment throws INVALID_RESPONSE for that row, aborting
  all claimed rows before updateOne, including the valid v36 attempt. Actual
  scheduled responses are HTTP 502/INVALID_RESPONSE; v36 remains leased/running
  with no stages. Cron, its endpoint/secret and workspace eligibility are valid.
  Preserve the old terminal and provider holds, isolate the bad claim and expose
  its reason. Do not fabricate an attempt or clear the unknown old operation.

The source-beta tab with DevTools also reported 2.1 GiB memory during the long
walkthrough. This is an observation for T053; no product leak is inferred without
a DevTools-off / packaged baseline.

Download/link and calendar walkthroughs from earlier checkpoints remain documented
in manual-beta.md. They were not repeated in this command walkthrough. N variants,
delayed publication, same-click image replacement, Windows and the full fault /
accessibility matrix remain open. After repair, repeat the failed manual scenarios
and confirm that the original v36 attempt resumes without another Run command.

The subsequent repair and actual successful repeat are recorded in
[manual-beta-claim-recovery.md](manual-beta-claim-recovery.md). The observations
above remain the original failing baseline, not the current verdict.
