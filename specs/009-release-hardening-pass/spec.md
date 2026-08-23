# Feature Specification: Release Hardening Pass

**Feature Branch**: `009-release-hardening-pass`

**Created**: 2026-08-23

**Status**: Draft

**Input**: User description: "потрібно написати задачу яка перевірить і покриє тестами кожен важливий момент, особливо мене цікавить чіткість роботи всіх станів типу щось почали конвертити стопнули, запустили інше, намагаємось продовжити ще щось, потужність щоб чітко розподілялась і працювала коректно завжди на всіх пристроях віндовс і мак, максимально автоматизувати флоу тестування прогонів і тд щоб менше витрачати агенських токенів при розробці, фул чек застосунка на безпеку і незламність, на витоки, пошук оптимізаційних рішень які можуть прискорити роботоздатність. Таска має бути фінальним поліруванням яке знайде всі неточності і по дизайну і по архітектурі і баги які не очевидні."

## Overview

Soty works. Every individual tool does its job, the power lever caps the machine, and the suite is green. What is missing is **proof that it behaves under use** — the messy, interleaved, interrupted use that real people produce and that no single-tool test reproduces: start a compression, stop it halfway, immediately start a transcription, come back and try to continue the first thing, close the laptop, reopen it, refresh the browser, do it all again on Windows.

This feature is the last pass before Soty is treated as finished. It is not new capability. It is the pass that turns "it works when you use it the way we tested it" into "it behaves predictably however you use it, on both platforms, and we can prove it in one command".

Six outcomes, in priority order:

1. **Every run state is truthful and every interleaving is safe.** What the screen says a job is doing is what the machine is doing — during a stop, after a stop, while another tool starts, after a restart, on both Windows and macOS.
2. **Verification is one command, and it reports machine-readably.** Today a release pass is roughly ten hand-typed commands producing prose that a person or an assistant must read line by line. That reading is the single largest recurring cost of working on this codebase.
3. **The application is hardened against attack and against leaking.** A full, evidence-backed pass over the local app's surface, the browser origin, the backend, the update chain, and the telemetry.
4. **The interface never lies about state.** A four-second network blip must not look like an uninstalled app; a stale response must not overwrite a newer truth; a progress bar must not keep animating over frozen data.
5. **The app is measurably faster and lighter** on the paths users actually sit in front of.
6. **Design and wording are consistent**, and the inconsistencies that accumulated across eight features are removed rather than documented.

An audit of the current codebase has already been performed and is recorded alongside this spec. Most requirements below trace to a concrete, located observation in it; the remainder are the cross-platform and process guarantees those observations imply. The spec states the required behaviour; the audit states where today's behaviour differs. Findings marked in the audit as inferred from reading rather than observed in use must be confirmed by observation before they are acted on.

Throughout this document, **the local app** means the part of Soty installed on the user's computer, and **the interface** means the part that runs in their browser.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Interleaved work behaves predictably (Priority: P1)

A user starts compressing a batch of videos, changes their mind halfway and stops it, immediately starts a transcription instead, then goes back to the compressor and re-runs one of the stopped files while the transcription is still going. Nothing is left running that they cannot see, nothing they stopped comes back, nothing they started is silently refused, and the machine's load matches what is actually on screen.

**Why this priority**: This is the user's stated primary concern and the failure mode most recently found in production — a stop that changed a status field while the work carried on holding the machine. It is also the class of bug least likely to be caught by any per-tool test, because it only appears when tools are used against each other.

**Independent Test**: Drive a real installation through a scripted interleaving sequence (start → stop → start a different tool → re-run the first → stop everything → restart the local app) while independently observing the machine's actual process and consumption state, and assert at every step that the observed machine state matches the reported state. Delivers the core guarantee on its own.

**Acceptance Scenarios**:

1. **Given** a compression is running, **When** the user stops it, **Then** within a defined grace period no process belonging to that job is still running, no partially written output file remains on disk, the job reads as stopped, and the measured consumption returns to idle.
2. **Given** a job was just stopped, **When** the user immediately starts a different tool, **Then** the new work starts without waiting on the stopped one and without inheriting any of its resources or state.
3. **Given** work from two different tools is running at once, **When** the user stops one of them, **Then** the other is unaffected — it does not pause, restart, or fail, and it does not run slower than it would with the same power limit and nothing else running.
4. **Given** a stopped job, **When** the user re-runs it, **Then** it runs from the beginning and produces output equivalent to a job that was never stopped, where equivalent means the same duration, the same dimensions, and decoded content indistinguishable within the tolerance the encoder itself guarantees.
5. **Given** any job in any state, **When** the user asks for a transition the system does not allow, **Then** the request is refused with a clear reason and the job's state is unchanged — it is never left in an in-between state.
6. **Given** work is in progress, **When** the application is quit, **Then** nothing belonging to it survives the exit, no partial output is left behind, and on the next start every interrupted job is presented as interrupted rather than as still running.
7. **Given** the same sequence is performed on Windows and on macOS, **Then** the observable outcomes are the same on both.
8. **Given** any tool that can start work, **Then** the user can stop that work from the interface — no tool can start something the user cannot stop.
9. **Given** the interface has been open long enough to be receiving live updates from several tools at once, **When** the user starts or stops anything, **Then** the action takes effect promptly — live updates never consume so much of the browser's connection budget that ordinary actions are left waiting.
10. **Given** the same user has the interface open in several tabs, **When** two of them request the same start at the same moment, **Then** exactly one run is created and both tabs converge on it.
11. **Given** work is in progress, **When** the machine sleeps and later wakes, **Then** the work either continues correctly or is presented as interrupted — it is never presented as running while nothing is.

---

### User Story 2 - Power is one shared budget that never lies (Priority: P1)

A user sets the power lever to a reduced level and leaves Soty working in the background. Whatever combination of tools is running, together they stay within that one limit. If the platform cannot actually enforce the limit, the interface says so instead of showing a lever that does nothing.

**Why this priority**: The power lever is the user's only control over how much of their computer Soty takes, and its credibility depends entirely on the readout and the lever agreeing with reality. A lever that silently stops working is worse than no lever.

**Independent Test**: Run every combination of concurrently-runnable tools at each of several limit settings on both platforms, sample actual system consumption independently of the app, and confirm the aggregate stays within tolerance of the limit — then force the enforcement mechanism to fail and confirm the interface reports the limit as unenforceable.

**Acceptance Scenarios**:

1. **Given** a reduced limit, **When** two or more tools run at the same time, **Then** their combined consumption stays near the limit — the limit is one shared budget, not one per tool.
2. **Given** a tool that decides how many units of work to run side by side, **When** the limit is reduced, **Then** that number falls with the limit rather than staying at whatever was decided when the application started.
3. **Given** work is running under a reduced limit, **When** the user raises or lowers the lever, **Then** the change takes effect on the work already running, not only on work started afterwards.
4. **Given** the underlying mechanism that enforces the limit stops working on this machine, **When** the user opens the power panel, **Then** it reports that the limit cannot be applied to running work, rather than continuing to present an active lever.
5. **Given** any work stopped or completed, **When** the user looks at the readout, **Then** it falls to a near-idle level within 10 seconds — a readout that stays elevated is a leak and must fail the check.
6. **Given** a reduced limit, **When** the user quits and reopens the app, **Then** the same limit is in force and is shown on the header without opening the panel.
7. **Given** a limit is in force, **When** work runs to completion under it, **Then** the produced output is equivalent to the same work at full power, as defined in User Story 1 — only the duration differs.

---

### User Story 3 - The whole application verifies itself in one command (Priority: P1)

A developer or an assistant working on Soty runs a single command and gets one machine-readable verdict covering formatting, types, lint, the full test suite, a real end-to-end run against a real agent, and the release-contract checks. Failures name the thing that broke; successes produce almost no output to read.

**Why this priority**: The user's explicit goal of spending fewer assistant tokens is achieved here and almost nowhere else. The test suite is fast; the cost is orchestration and prose. This story also makes every other story in this spec cheap to keep true, so it ships early.

**Independent Test**: On a clean checkout, run the single command and confirm it produces a structured pass/fail result covering every gate; then deliberately break one thing in each covered category and confirm each is caught and named.

**Acceptance Scenarios**:

1. **Given** a clean checkout, **When** the developer runs the single verification command, **Then** it runs every automatable gate and emits one structured result plus a short human summary — not the concatenated output of every underlying step.
2. **Given** a gate fails, **When** the command finishes, **Then** the result names which gate failed and what specifically broke, sufficient to act on without re-running anything.
3. **Given** a change is pushed or a pull request is opened, **When** the automation runs, **Then** the same gates run automatically on both a macOS and a Windows runner, and the result blocks the merge on failure.
4. **Given** a test depends on a tool that is not installed, **When** the suite runs, **Then** that test reports as skipped and the run reports how many were skipped — it never reports as passed.
5. **Given** the suite runs, **When** it succeeds, **Then** no diagnostic noise from passing tests reaches the output.
6. **Given** the suite runs, **Then** a coverage figure is produced and recorded, and the run fails if coverage falls below the recorded baseline.
7. **Given** every test and script in the repository, **Then** they are type-checked by the verification command — a test referencing something that no longer exists fails the gate.
8. **Given** the platform-specific behaviour this feature guarantees, **Then** the automation exercises it on a real Windows runner, not only through source-text assertions written on a Mac.

---

### User Story 4 - The interface tells the truth when things go wrong (Priority: P2)

A user's network hiccups for a few seconds, or their local app restarts, or they have three tabs open. The interface reflects reality: it does not claim the app is uninstalled, it does not trap them in a dialog they cannot close, it does not animate progress over data that stopped arriving, and it does not lose what they were typing.

**Why this priority**: These are the non-obvious bugs the user asked for — each one is invisible in a happy-path test and unmistakable to someone using the product. They are separated from Story 1 because they live in the interface rather than in the engine and can be fixed and shipped independently.

**Independent Test**: Interrupt the connection between the interface and the local app for a few seconds at each point in a run, on each tool page, with one and with three tabs open, and assert what the user sees at each moment.

**Acceptance Scenarios**:

1. **Given** work is in progress, **When** the connection drops briefly and recovers, **Then** the user stays on the page they were on, keeps their unsaved input, sees an unobtrusive reconnecting indication, and is never shown installation or download instructions for an application they already have.
2. **Given** the connection is lost, **When** the user looks at any in-progress item, **Then** progress indication stops presenting itself as live — no advancing bar, no ticking timer over data that is no longer arriving.
3. **Given** any interruption on any tool page, **When** the user is shown a dialog, **Then** they can always dismiss it.
4. **Given** the local app restarts and must be re-paired, **When** re-pairing happens, **Then** it happens without discarding the user's current page or unsaved work, and multiple open tabs coordinate rather than each attempting it separately.
5. **Given** a request and a live update describe the same thing, **When** they arrive out of order, **Then** the newer truth wins — the interface never moves backwards.
6. **Given** the same interruption occurs on any tool page, **Then** every tool page behaves the same way — there is one behaviour, not one per page.
7. **Given** any progress shown to a user or to another member, **Then** it reflects real measured progress; no placeholder or fabricated value is ever displayed as progress.

---

### User Story 5 - Hardened against attack and against leaking (Priority: P2)

Soty runs a server on the user's own machine and holds a key to their files. A hostile web page, a hostile local process, or a compromised dependency must not be able to use it. Nothing Soty sends out may contain the user's file names, paths, or content, and nothing it downloads may be trusted without proof of origin.

**Why this priority**: The consequences are the most severe in the product, and several of the surfaces are only reachable because the app is genuinely useful — a token that grants local file access is exactly the thing an attacker wants. It is P2 rather than P1 only because Stories 1–3 must exist for any fix here to stay fixed.

**Independent Test**: Run an adversarial suite against a real running agent — hostile origins, spoofed hosts, missing headers, oversized and malformed uploads, traversal-shaped paths, replayed and forged tokens — and assert each is refused; separately, inspect everything the application transmits and confirm no user-identifying file data is present.

**Acceptance Scenarios**:

1. **Given** a web page on any origin other than Soty's own, **When** it attempts any request to the local app — including with a spoofed host name, with no origin header, or through a rebound name — **Then** every request is refused.
2. **Given** the local app's access token, **When** it is used or transmitted anywhere, **Then** it never appears in a URL, a log line, browser history, or a referring page, and it is never compared in a way that reveals it a character at a time.
3. **Given** the browser origin that stores that token, **Then** it is served with a content policy and the accompanying protective headers, such that a script injected into the page cannot read the token or frame the application.
4. **Given** any request that names a file or folder, **When** it names a location the user did not choose in this session, **Then** it is refused — reading or writing an arbitrary location on the machine is not something a request can ask for.
5. **Given** repeated or oversized requests to any endpoint, **Then** they are limited — no endpoint accepts unbounded size, unbounded rate, or unbounded concurrent connections.
6. **Given** a downloaded application update or installer, **When** the user opens it, **Then** the operating system can verify who published it, and the application refuses any artifact whose origin or contents do not match what was signed.
7. **Given** everything the application transmits — telemetry, diagnostics, error reports, and error messages shown to the user — **Then** none of it contains a file name, a file path, or user content.
8. **Given** the dependencies the application ships, **When** verification runs, **Then** it fails on a known high-severity vulnerability rather than reporting it as an advisory.
9. **Given** any part of the backend reachable without an authenticated user, **Then** its access is time-limited, single-use, and bound to both the material requested and the requester.

---

### User Story 6 - Faster to load and smoother to use (Priority: P3)

A user opens Soty and it appears quickly. A queue of two hundred files scrolls and updates without stuttering. A long transcript opens without freezing. Reduced-motion and lower-powered machines are respected.

**Why this priority**: Real and worth doing, but nothing here is wrong — it is slower and heavier than it needs to be. It ships after correctness.

**Independent Test**: Measure first-load transfer size and time-to-interactive on a throttled connection, and measure interaction responsiveness with a large queue and a long transcript, before and after; assert against recorded budgets.

**Acceptance Scenarios**:

1. **Given** a user opening Soty for the first time, **Then** the initial download is materially smaller than today's and does not include code for tools, screens, or roles the user has not opened.
2. **Given** a queue of two hundred items receiving live updates, **When** the user scrolls or interacts, **Then** the interface stays responsive and does not re-render items whose data did not change.
3. **Given** a transcript of several thousand segments, **When** the user opens and scrolls it, **Then** it opens promptly and scrolls smoothly.
4. **Given** any list of images, **Then** images load as they are needed and reserve their space in advance, so content does not jump as they arrive.
5. **Given** a user who has asked their system for reduced motion, or a machine under load, **Then** decorative animation is reduced or disabled accordingly.
6. **Given** performance budgets recorded for load size, load time, and interaction responsiveness, **When** verification runs, **Then** a regression beyond budget fails the gate.

---

### User Story 7 - One consistent surface (Priority: P3)

Every dialog behaves the same way, every colour comes from the theme, every count reads correctly in both languages, and nothing on screen is a leftover from a flow that was reworked.

**Why this priority**: Accumulated drift across eight features. Individually cosmetic; together they are what makes an application feel unfinished. Lowest risk, lowest urgency, and safe to do last.

**Independent Test**: Automated checks over the stylesheet, the interface source, and the translations for undefined theme values, duplicate or off-scale values, hand-rolled dialogs, unreachable translations, and untranslated text — plus an automated accessibility pass on every route in both themes and both languages.

**Acceptance Scenarios**:

1. **Given** the stylesheet, **Then** every theme value it references is defined; a reference to an undefined value fails verification.
2. **Given** any dialog in the application, **Then** it traps focus, closes on Escape, restores focus on close, and can be dismissed — including dialogs currently built by hand and those currently delegated to the operating system.
3. **Given** either theme, **Then** every surface responds to it; no element keeps a fixed colour that only suits one theme.
4. **Given** every route, in both themes and both languages, **When** an automated accessibility pass runs, **Then** it reports no serious or critical issue, and every interactive control is reachable and operable by keyboard alone.
5. **Given** any text shown to the user, **Then** it comes from the translations and is correct in both languages — including counts, which must follow each language's own plural rules.
6. **Given** the translations, **Then** every entry is used and every used entry exists; unused entries are removed.
7. **Given** a message originating from the local app, **When** it is shown to the user, **Then** it is translated by identity rather than by matching its English wording.
8. **Given** the page before the application has loaded, **Then** its language and appearance match the user's, not a fixed default.

---

### Edge Cases

- A stop arrives in the gap between two stages of a multi-stage job — between analysis and encoding, between transcription and translation, between two passes of the same encoder.
- A stop arrives while the job is already finishing on its own; and two stops arrive for the same job.
- A job is stopped while the power limit has its process suspended.
- The user quits the application while work is running, and while work is queued but not started.
- The application is force-quit or crashes; on next start, what was running must be presented as interrupted, and nothing from the previous run may still be holding the machine.
- The machine sleeps and wakes with work in progress.
- The user changes the power limit repeatedly and rapidly while work is running.
- The platform mechanism that enforces the power limit fails at runtime after having worked.
- A job's input file is deleted, renamed, or moved while it is queued or running.
- The disk fills while an output is being written.
- The same file is added twice, or a file is added while an identical job is already running.
- Three tabs are open and the same action is taken in two of them at the same instant.
- The local app is older or newer than the interface expects.
- A request arrives with no origin header, with a spoofed host, or with a token in the URL.
- An upload is truncated, is far larger than declared, or contains an entry that would write outside its destination.
- The signed release manifest is valid but points at an artifact hosted somewhere unexpected.
- A user opens Soty on a machine with very few cores, and on one under heavy external load.
- Every tool the user can open is on screen at once, each receiving live updates, and the user then starts or stops something.
- A file whose name contains quotation marks, backslashes, or characters the operating system treats specially is added.
- The same limit is set from two tabs at once, or set while the local app is unreachable.

## Requirements *(mandatory)*

### Functional Requirements

**Run state and lifecycle**

- **FR-001**: Every tool that performs work MUST model its run lifecycle as one explicit set of states with one explicit set of allowed transitions, and MUST reject any transition outside that set without changing state.
- **FR-002**: Stopping work MUST end the underlying processing within a defined grace period, escalating if the first attempt is not honoured, and MUST leave no process running that the user cannot see.
- **FR-003**: Stopping or failing work MUST remove any partially written output it produced, and quitting the application normally MUST do the same for work still in progress.
- **FR-003a**: Because a crash or a forced quit leaves no opportunity to clean up, the next start MUST find and remove any output left partially written by a previous run.
- **FR-004**: Stopping work MUST release its place in the queue immediately, so that other work starts without waiting for the stopped work to finish unwinding.
- **FR-005**: Every tool that can start work MUST offer the user a way to stop that specific work, and a way to stop all of its work.
- **FR-006**: Work that was interrupted by the application exiting MUST be presented on the next start as interrupted, distinctly from work that failed and from work that is running.
- **FR-007**: Stopping work in one tool MUST NOT affect work in any other tool.
- **FR-008**: Re-running stopped work MUST run it from the beginning and produce output equivalent to work that was never stopped, as defined in User Story 1. If resuming from a partial result is not supported, the interface MUST NOT offer resumption.
- **FR-009** *(roll-up, not an additional behaviour)*: All of FR-001 through FR-008 MUST hold identically on Windows and on macOS. Stated separately because it is the guarantee a reader needs to see, and because it changes how each of those requirements is validated.
- **FR-009a**: Work in progress MUST survive the machine sleeping and waking, or else be presented as interrupted on wake.
- **FR-009b**: The interface MUST NOT hold so many simultaneous live connections that ordinary actions are left waiting behind them.
- **FR-009c**: Starting work MUST be serialised by the local app, so that two interfaces requesting the same start simultaneously produce exactly one run.

**Power**

- **FR-010**: The power limit MUST apply as a single shared budget across all concurrently running local work, including work started before the limit changed.
- **FR-011**: When the mechanism that enforces the limit becomes unavailable on the running machine, the system MUST report the limit as unenforceable and MUST stop presenting it as active.
- **FR-012**: Consumption reported to the user MUST fall to no more than 2% of the machine's total capacity within 10 seconds of the last work finishing or being stopped.
- **FR-012a**: Where a tool decides how many units of work to run side by side, that number MUST be derived from the current limit rather than fixed at application start.
- **FR-013**: Every path that starts a heavy process MUST pass through the mechanism that applies the limit, and this MUST be enforced structurally so that a tool added later inherits it.

**Verification and automation**

- **FR-014**: There MUST be a single command that runs every automatable gate: formatting, lint, type-checking of all source including tests and scripts, the full test suite, the database checks, an end-to-end run against a real local app, and the release-contract checks.
- **FR-014a**: That command MUST offer two forms — a fast one for ordinary development and a full one for release — differing only in which gates run, never in how a result is reported.
- **FR-015**: That command MUST emit one structured, machine-readable result and a short human summary, and MUST NOT emit the raw output of passing steps.
- **FR-016**: A test that cannot run because a dependency is absent MUST report as skipped and be counted as skipped; it MUST NOT report as passed.
- **FR-017**: Automated verification MUST run on every pull request and every push to the default branch, on both a macOS and a Windows runner, and MUST block a merge on failure.
- **FR-018**: Test coverage MUST be measured, recorded as a baseline, and enforced against regression.
- **FR-018a**: Every module that participates in producing, transporting, or displaying a run's state MUST be covered by tests, regardless of what the overall baseline happens to be. A ratchet against today's figure MUST NOT be used to leave these uncovered.
- **FR-019**: Every state and every allowed transition of every run lifecycle MUST be covered by tests derived from the lifecycle's own definition, such that adding a state without covering it fails the gate.
- **FR-020**: The interleaved-use sequences described in User Story 1 MUST be covered by automated end-to-end tests that observe the machine's actual process and consumption state, not only the application's reported state.
- **FR-021**: Shared test utilities — temporary directories, waiting for a condition, environment isolation, stub tools, and a fake local app for interface tests — MUST exist once and be reused, rather than reimplemented per test.
- **FR-022**: Tests MUST NOT depend on wall-clock timing, on a fixed shared path outside a temporary directory, or on a network connection.

**Security and privacy**

- **FR-023**: The local app MUST refuse every request that does not come either from Soty's own interface or from a named local companion of Soty holding its own credential. This MUST hold for requests that identify no sender, requests that claim a false identity, and requests that reach the local app under a name other than the machine's own.
- **FR-024**: The local app's access token MUST NOT be transmitted in a web address, MUST NOT appear in any log, and MUST be checked in a way that takes the same time whether the first character is wrong or the last.
- **FR-025**: The public origin that stores the access token MUST be served with a content security policy and the accompanying protective headers.
- **FR-026**: A request MUST NOT be able to cause the local app to read from or write to a location the user never chose. Only locations the user selected through Soty's own file selection — in this session, or in an earlier one and still recorded in their queue — are permitted.
- **FR-027**: Every endpoint MUST enforce a size limit appropriate to it, a request rate limit, and a limit on concurrent live connections.
- **FR-028**: Distributed applications and installers MUST be signed such that the operating system can verify the publisher, and the release manifest MUST constrain both where an artifact may be hosted and what its contents must be.
- **FR-029**: Nothing the application sends off the user's machine — telemetry, diagnostics, error reports — and nothing it writes to a log may contain a file name, a file path, or user content. Showing the user the names of files they themselves added is the product working correctly and is not covered by this requirement.
- **FR-029a**: A failure shown to the user MUST be identified by a stable code chosen by the system, never by relaying the underlying message, which routinely carries a full path. This requirement governs what the local app **emits**; FR-055 governs how the interface **renders** it.
- **FR-030**: Verification MUST fail on a known high-severity vulnerability in a shipped dependency.
- **FR-031**: Any backend path reachable without an authenticated user MUST be authorised by a credential that is time-limited, single-use, and bound to both the material requested and the requester.
- **FR-032**: Adopting a pairing credential MUST require evidence that it originated from this machine's local app.
- **FR-032a**: Text the user or a request supplied MUST NOT be assembled into a command, script, or query expression that another program then interprets.
- **FR-032b**: A location handed to the operating system to open or reveal MUST first be confirmed to exist, to be an ordinary file or folder, and to be of a kind the action expects.
- **FR-032c**: Media brought in for processing MUST be removed once it is no longer needed and MUST NOT accumulate indefinitely on the user's machine.
- **FR-032d**: Any file holding a credential MUST be readable only by the account that owns it.
- **FR-032e**: A downloaded component MUST be verified against a value that cannot be changed by whoever changed where it is downloaded from.
- **FR-032f**: Trust settings that exist only for local development MUST NOT be present in what is published to users.

**Interface truthfulness**

- **FR-033**: A brief loss of the live connection MUST NOT unmount the user's current page, MUST NOT discard unsaved input, and MUST NOT present installation or download instructions to a user who already has the application installed.
- **FR-034**: Connection loss MUST NOT be reported to the user until it has persisted for at least 3 seconds, and reconnection attempts MUST space themselves out progressively rather than repeat at a fixed interval.
- **FR-035**: Connection state MUST reflect the health of the whole connection, not only of the live update stream.
- **FR-036**: While the connection is lost, progress indication MUST stop presenting itself as live.
- **FR-037**: When a request response and a live update describe the same state, the newer MUST win regardless of arrival order.
- **FR-038**: Re-pairing with a restarted local app MUST occur without discarding the user's page or unsaved work, and MUST be coordinated across open tabs.
- **FR-039** *(roll-up, not an additional behaviour)*: Every tool page MUST behave identically under connection loss — one behaviour across all of FR-033 through FR-038, not one per page. Stated separately because the defect it names is precisely that two pages behave oppositely today.
- **FR-040**: Any progress value shown to a user or to another member MUST be a real measurement. Placeholder progress values MUST NOT be displayed.
- **FR-041**: An action already in flight MUST NOT be re-triggerable, and counts reported after an action MUST reflect what actually happened.

**Performance**

- **FR-042**: A live update MUST cost the interface only the work of showing what actually changed; elements whose data is unchanged MUST NOT be rebuilt.
- **FR-043**: Progress updates MUST be delivered at a bounded rate and MUST carry only what changed, not a full copy of everything the tool knows.
- **FR-044**: Lists that can grow without bound MUST remain responsive at scale.
- **FR-045**: Code for tools, screens, and roles the user has not opened MUST NOT be part of the initial download.
- **FR-046**: Images MUST load as needed and MUST reserve their layout space in advance.
- **FR-047**: Decorative animation MUST respect a reduced-motion preference and MUST be reducible on constrained machines.
- **FR-048**: Budgets for initial download size, time to interactive, and interaction responsiveness MUST be recorded and enforced against regression.

**Consistency**

- **FR-049**: Every theme value referenced by the interface MUST be defined; an undefined reference MUST fail verification.
- **FR-050**: Defined scales MUST exist for spacing, corner rounding, elevation, text size, and stacking order — the last two do not exist today and must be created — and every value used MUST come from them. A value outside a scale MUST fail verification.
- **FR-051**: Every dialog MUST trap focus, close on Escape, restore focus on close, and be dismissable — with one implementation, not several.
- **FR-052**: Both themes MUST be complete; no element may keep a fixed colour that suits only one.
- **FR-053**: Every route, in both themes and both languages, MUST pass an automated accessibility check with no issue rated by that check as blocking or severely impairing for a user of assistive technology, and every interactive control MUST be operable by keyboard alone.
- **FR-054**: Every user-facing string MUST come from the translations, MUST exist in both languages, and MUST follow each language's plural rules where it reports a count.
- **FR-055**: The interface MUST render a message originating in the local app by translating the stable code FR-029a requires, never by matching its English wording. Together the two requirements remove the wording as a dependency in both directions.
- **FR-056**: Unused translations MUST be removed, and the check MUST fail if unused entries reappear.
- **FR-057**: The document's language, title, description, and pre-load appearance MUST match the user's language and theme.

### Key Entities

- **Run**: One unit of work a user started — a compression, a transcription, a landing optimisation, an image conversion, a preview render. Has an identity, a current state drawn from a fixed set, a source, an intended output, a progress measure, and a terminal reason when finished.
- **Run lifecycle**: The fixed set of states a run may occupy and the fixed set of transitions between them. There are five of these today, one per tool, each defined implicitly by where states happen to be assigned. This feature requires each to become an explicit definition that tests are derived from. Whether the five should become one is a genuine architectural question raised by the audit; it is deliberately left to planning rather than decided here, because unifying them is a larger change than this feature's stated scope and the explicit definitions are a prerequisite either way.
- **Power budget**: One machine-wide limit on how much of the computer all local work may consume together, plus whether the running machine can actually enforce it.
- **Managed process**: An external program started on the user's behalf. Belongs to exactly one run, is subject to the power budget, and must not outlive the run that owns it or the application that started it.
- **Verification gate**: One automatable check with a pass/fail outcome and a named subject. Composed into a single run producing one structured result.
- **Trust boundary**: A point where untrusted input enters — a request to the local app, a file path, an upload, a downloaded artifact, a pairing credential. Each has a stated rule for what it accepts and an adversarial test asserting what it refuses.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In an interleaved sequence of at least twenty start/stop/switch/re-run/restart actions across at least three tools, the reported state matches the machine's observed state at 100% of checkpoints, on both Windows and macOS.
- **SC-002**: Within 5 seconds of a stop, no process belonging to the stopped work is running and no partial output remains; within 10 seconds, the machine's share attributable to Soty is at or below 2% of total capacity. Verified independently of the application, on both platforms.
- **SC-003**: A developer who introduces a new run state cannot merge it uncovered — demonstrated by adding one and observing two independent failures, one from the declaration and one from the test enumeration.
- **SC-004**: With any combination of tools running under a reduced power limit, combined consumption — measured as a share of the machine's total capacity across all cores, sampled once a second — averages within 10 percentage points of the limit over a 60-second window, and no single 10-second stretch exceeds it by more than 20 points. Verified on both platforms.
- **SC-005**: A full verification pass runs from one command and produces at most 20 lines of output on success and at most 100 lines on failure, with the failing subject named in the first 10. Its fast development-loop form completes in under 2 minutes; its full release form completes in under 10 minutes, both measured on the maintainer's machine and recorded.
- **SC-006**: Pull-request automation runs the full gate set on both macOS and Windows and blocks merges on failure; zero gates remain manual-only except those that require signing credentials or physical hardware.
- **SC-007**: A reader of a single verification result can tell exactly how much of the system was exercised: it carries a coverage figure, a skip count, and a reason for every skip. Zero tests report success after exiting early because a dependency was missing, and on the release runner the skip count is zero.
- **SC-008**: An adversarial suite of at least thirty attack attempts against a real running local app — hostile origins, spoofed hosts, missing headers, forged and replayed tokens, traversal-shaped paths, oversized and malformed uploads, unauthorised backend paths — is refused in 100% of cases.
- **SC-009**: A review of everything the application transmits or displays finds zero occurrences of a file name, file path, or user content.
- **SC-010**: Once publisher credentials are available, distributed applications and installers pass operating-system publisher verification on a clean machine on both platforms, with no user instruction to bypass a security warning. Until then, the signing and verification chain is complete and proven with test credentials, and the only outstanding step is substituting the real ones.
- **SC-011**: At completion, zero known high-severity vulnerabilities are present in shipped dependencies, and introducing one is caught before a change can merge rather than discovered later.
- **SC-012**: A connection interruption of up to 10 seconds, at any point in a run and on every tool page, leaves the user on their page with their input intact and never shows installation instructions; the user is never presented with a dialog they cannot dismiss.
- **SC-013**: Within a single run, displayed progress never moves backwards, and no progress advances while the connection is lost. Re-running stopped work legitimately starts again from zero and is not a violation.
- **SC-014**: Against a baseline recorded before any change, initial download size falls by at least 40%, and each of the three largest individual pieces falls by at least 30% — no target is met by shrinking one piece alone. Time to interactive on a connection throttled to a typical mobile profile improves by at least 30%.
- **SC-015**: A user working with two hundred queued items receiving live updates experiences the same responsiveness as one working with five — measured against the recorded interaction budget.
- **SC-016**: Every route, in both themes and both languages, reports zero serious or critical accessibility issues, and every interactive control is operable by keyboard alone.
- **SC-017**: A change that introduces an undefined theme value, an off-scale value, or a second dialog implementation is rejected before merge, and none remain at completion.
- **SC-018**: Zero user-facing strings outside the translations, zero unused translations, zero count strings that ignore a language's plural rules, and zero messages translated by matching English wording.
- **SC-020**: With every tool open and receiving live updates at once, a start or a stop takes effect within 1 second, and no action is observed waiting on a live update stream.
- **SC-021**: In 100 attempts at starting the same work simultaneously from two tabs, exactly one run is created every time.
- **SC-022**: Across 20 sleep/wake cycles with work in progress, zero runs are reported as running while nothing is running.
- **SC-023**: Every user-supplied name containing a quotation mark, a backslash, or a shell-significant character is handled without any part of it being interpreted as an instruction — verified over a fixed adversarial name set.
- **SC-019**: Every defect recorded in the audit as of this spec's approval is either resolved or explicitly accepted with a stated reason. Anything found later is recorded the same way and prioritised, but does not block this feature. Observations recorded as strengths to preserve are not defects and require no disposition beyond not regressing.

## Assumptions

- **Scope is the existing product.** No new user-facing capability is introduced. Where a requirement cannot be met without behaviour change, the smallest change that makes the existing behaviour honest is preferred over adding capability — for example, if resuming stopped work is not supported, the requirement is to stop offering it, not to build it.
- **The audit in `findings.md` is the starting inventory, not the boundary.** It was produced by reading the codebase and probing a running instance. Implementation is expected to find more; anything found is added to it under the same rules.
- **Both platforms are equal.** Every guarantee that mentions a platform must be proven on a real machine or runner of that platform. Assertions made about Windows behaviour from a macOS machine by reading source text do not satisfy a platform requirement.
- **Windows and macOS are the supported platforms.** Linux is out of scope.
- **Ukrainian and English are the supported languages.** No new language is added.
- **Signing credentials are a prerequisite, not a deliverable.** Publisher verification requires an Apple Developer ID and a Windows code-signing certificate. Obtaining them is outside this feature; every other part of the signing chain is inside it.
- **Existing conventions hold.** The project's governing document already sanctions this work and names several of these gaps; this feature closes them rather than proposing a different way of working.
- **The single verification command is layered.** A fast inner loop for ordinary development and a full pass for release are both served by it; only the full pass is required to meet SC-005's ceiling.
- **Coverage is a ratchet, not a target.** The baseline is whatever is measured first; the requirement is that it does not fall.
- **Performance budgets are measured before they are enforced.** Today's figures become the baseline; the improvement targets in SC-014 are stated against that baseline.
- **Automated accessibility checking finds a subset of issues.** Passing it is required, not sufficient; it is the enforceable floor.

## Dependencies

These are prerequisites to acquire or configure, not work to be done. Each names the requirement it unblocks so a delay is visible against a specific guarantee rather than against the feature as a whole.

| Prerequisite | Unblocks | Nature |
|---|---|---|
| A real Windows machine or runner | The platform half of Stories 1, 2 and 3 | Hardware or CI access. Without it, no platform guarantee can be validated — assertions written on a Mac about Windows behaviour do not count. |
| Continuous-integration minutes on macOS and Windows runners | FR-017, SC-006 | Budget. The plan reduces steady-state cost by running static checks on the cheapest runner and keeping the end-to-end suite off routine changes. |
| An Apple Developer ID and a Windows code-signing certificate | FR-028, SC-010 | Procurement. The signing chain is built and proven against test identities first, so the outstanding step is a substitution rather than a build — which is why SC-010 is worded conditionally. |
| Container support on the machine running full verification | The database checks named in FR-014 | Local tooling. Absent, that one check reports as skipped with a named reason rather than silently passing. |
| Repository branch-protection settings | SC-006 | Configuration. The automation is defined in files; making its checks required to merge is a repository setting and cannot be done from the codebase. |
