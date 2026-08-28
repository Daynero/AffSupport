# Findings — feature 011 (US5)

**Status**: not yet run. Phases 1–6 are implemented and green under the unit suite
(`--maxWorkers=1`, 271 files); the beta and production runs below need what only the
owner can supply, and the beta stack is too heavy to start on the development machine
without headroom (`uptime` first, nothing else running).

## Prerequisites (owner)

| Item                                                                 | Task  | Done |
| -------------------------------------------------------------------- | ----- | ---- |
| Beta OAuth test client with `drive.file`, `DRIVE_OAUTH_MODE=testing` | T076  | [ ]  |
| `VITE_GOOGLE_PICKER_API_KEY`, `VITE_GOOGLE_PROJECT_NUMBER` in beta   | T076  | [ ]  |
| Reference root built per `quickstart.md` §0 (counts below)           | T076  | [ ]  |
| Production Google Cloud project configured                           | T076a | [ ]  |
| R1 spike run (`quickstart.md` §1) and outcome A/B recorded           | T002  | [ ]  |

Reference root counts: folders ____ · files ____ · deepest level ____ · landings ____.

## Beta runs

| Section (quickstart) | Rows | Result | Deviation → fix commit |
| -------------------- | ---- | ------ | ---------------------- |
| §2 storage and tree  | –    | –      | –                      |
| §3 previews          | –    | –      | –                      |
| §4 explorer          | –    | –      | –                      |
| §5 live sync         | –    | –      | –                      |

## Production (after the next agent release, research R8)

Date: ____ · owner account: ____ · §6 result: ____
