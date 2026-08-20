# Feature Specification: Local Agent Power Throttle

**Feature Branch**: `008-agent-power-throttle`

**Created**: 2026-08-20

**Status**: Draft

**Input**: User description: "Додати глобальний ползунок продуктивності для Local Agent. Користувач має мати можливість вказати, скільки ресурсів комп'ютера може використовувати Soty, наприклад від 20% до 100%. Ліміт має діяти **на всі локальні інструменти Soty одночасно**, а не окремо на кожен: компресор, оптимізатор, транскрипцію, voice isolation та майбутні локальні tools. Мета — дозволити залишити Soty працювати у фоні, не забираючи всю потужність комп'ютера та не заважаючи паралельній роботі. Має однаково працювати на **Windows і macOS**. це має бути зроблено в хедері біля зміни теми значок потужності, натискаєш і випадає менюшка в якій вертикальний ползунок зроблений як ричаг літака зі шкалою потужності. також внизу текстом писало в ріалтаймі скільки соти зараз споживають спю у віцотках від системи. тобто фактично приблизно бачити чи працюють соти і скільки споживають, і керувати цим ричагом потужності і тут ж бачити зміни"

## Overview

Today, when Soty processes media locally it takes whatever share of the machine it can get. A compression run, a transcription, or a batch of image conversions can saturate the CPU, making the rest of the computer sluggish while the user is trying to work on something else. The only way to get the machine back is to stop the job.

This feature gives the user one **global power limit** for everything Soty does locally: a single control that says "Soty may use up to N% of this computer". The limit applies to **all local tools at once** — compressor, landing optimizer, transcription, image/media actions, voice isolation, and any local tool added later — as one shared budget, not as a per-tool setting. Turning the limit down lets the user leave Soty running in the background on a long job while continuing to work; turning it up gives Soty the machine when the user steps away.

The control lives in the app header, next to the theme toggle: a power icon that opens a small panel containing a **vertical throttle lever** styled like an aircraft thrust lever, with a marked power scale. Underneath it, a live readout shows roughly how much of the system's CPU Soty is consuming *right now*, so the user can see at a glance whether Soty is working, how hard, and what effect moving the lever had.

Behaviour must be equivalent on Windows and macOS.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cap Soty so the computer stays usable (Priority: P1)

A user starts a long local job (compressing a batch of videos) and needs to keep working in other applications. They open the power panel in the header, pull the lever down to a lower setting, and Soty immediately eases off — the job keeps running to completion, just slower, while the rest of the machine stays responsive.

**Why this priority**: This is the entire point of the feature. Without the ability to actually cap consumption across running work, nothing else has value.

**Independent Test**: Start a local job with the limit at 100%, observe system responsiveness and Soty's CPU share; move the lever to the minimum setting; confirm Soty's measured CPU share drops toward the new cap, the job still completes successfully with identical output, and no error or failure is raised. Delivers the core value on its own.

**Acceptance Scenarios**:

1. **Given** the limit is at 100% and a local job is running, **When** the user moves the lever to 20%, **Then** Soty's share of system CPU falls toward roughly 20% within a few seconds and the job continues without failing.
2. **Given** the limit is at 20% and a job is running, **When** the user moves the lever to 100%, **Then** Soty ramps back up and the remaining work finishes faster.
3. **Given** the limit is set to a reduced value, **When** the user starts a *new* local job of any tool type, **Then** that job also runs within the same limit without any per-tool configuration.
4. **Given** two different local tools are running at the same time, **When** the limit is 50%, **Then** the two jobs *together* stay near 50% — the limit is a shared budget, not 50% each.
5. **Given** a job is running at a reduced limit, **When** it completes, **Then** its output is byte-for-byte equivalent to the same job run at 100% (only duration differs).

---

### User Story 2 - See what Soty is consuming right now (Priority: P1)

A user wants to know whether Soty is currently doing anything and how much of the machine it is taking. They click the power icon in the header and see a live percentage under the lever that updates continuously — near zero when idle, rising as work runs, and visibly reacting when they move the lever.

**Why this priority**: The lever is unusable as a control without feedback; the user's stated goal is to "see roughly whether Soty is working and how much it consumes, and control it and see the change right there". It also stands alone as a value: knowing Soty is idle vs. busy.

**Independent Test**: Open the panel with no work running and confirm the readout shows an idle (near-zero) value; start a job and confirm the readout rises within a few seconds and keeps updating; stop the job and confirm it falls back toward idle.

**Acceptance Scenarios**:

1. **Given** no local work is running, **When** the user opens the power panel, **Then** the readout shows a near-zero consumption value and an idle indication.
2. **Given** a local job is running, **When** the user opens the power panel, **Then** the readout shows a non-zero percentage of system CPU and refreshes at least once every 2 seconds.
3. **Given** the panel is open with work running, **When** the user moves the lever, **Then** the readout reflects the new consumption level within a few seconds without the user reopening the panel.
4. **Given** the local agent is not connected, **When** the user opens the power panel, **Then** the readout states that consumption is unavailable rather than showing a stale or fabricated number.

---

### User Story 3 - The setting persists and is discoverable (Priority: P2)

A user sets the throttle once and expects Soty to remember it. The power icon in the header also communicates the current setting at a glance, so the user is never surprised by Soty running slowly because of a limit they forgot about.

**Why this priority**: Without persistence the control is a per-session toy; without an at-a-glance indication, a low limit set weeks ago reads as "Soty is slow/broken". Valuable, but the feature demonstrably works without it.

**Independent Test**: Set the lever to a non-default value, close and reopen the app, and confirm the same value is in effect and reflected on the header icon.

**Acceptance Scenarios**:

1. **Given** the user set the limit to 40%, **When** they restart the app, **Then** the limit is still 40% and jobs run under it.
2. **Given** the limit is at anything below 100%, **When** the user looks at the header without opening the panel, **Then** the power icon visibly indicates that a reduced limit is active.
3. **Given** the user has never touched the control, **When** they open the panel, **Then** it shows the default setting (100%).
4. **Given** the limit was changed on this machine, **When** the user signs in on a different computer, **Then** that machine keeps its own limit — the setting is per-machine, not carried across devices.

---

### User Story 4 - Works the same on Windows and macOS (Priority: P2)

A user who moves between a Mac and a Windows PC gets the same control, the same scale, and comparable behaviour on both.

**Why this priority**: A cross-platform promise stated in the request. It is a qualifier on Stories 1–2 rather than a separate capability, so it ships alongside them but is validated separately.

**Independent Test**: Run the same job at the same limit on both platforms and confirm the lever, the scale, the readout, and the resulting throttling behave equivalently within tolerance.

**Acceptance Scenarios**:

1. **Given** the same limit value on Windows and macOS, **When** the same job runs on both, **Then** the measured consumption is capped comparably on both platforms.
2. **Given** either platform, **When** the user opens the panel, **Then** the lever, scale, and live readout are present and functional with no platform-specific gaps.

---

### Edge Cases

- **Limit lowered mid-job**: running work must adapt in place, not be cancelled, restarted, or corrupted.
- **Limit raised mid-job**: work must be allowed to speed back up without needing a restart.
- **Rapid lever movement**: dragging the lever quickly must not thrash the system, spawn conflicting changes, or leave the applied limit out of sync with the lever position; the last position wins.
- **Very small machines**: on a low-core machine, a 20% limit may floor at "one unit of work at a time" — the system must still make progress and never reach a state where jobs stall indefinitely at zero throughput.
- **Agent disconnected or not running**: the panel must open, explain that no local agent is connected, show no consumption figure, and either defer the change or apply it once the agent reconnects — never silently discard the user's setting.
- **Agent version too old to honour the limit**: the panel must say the installed local agent does not support the power limit and point the user at updating, rather than pretending a limit is in force.
- **Machine under external load**: the readout reports Soty's own share, not total system load, so a busy machine with idle Soty still reads near zero.
- **Multiple app windows/tabs open**: they must not fight over the setting; a change made in one is reflected in the others.
- **Work queued while limited**: queued jobs remain queued and run in order under the limit; nothing is dropped because the budget is small.
- **Sleep / wake and long-running jobs**: after the machine wakes, the readout resumes updating and the limit is still enforced.

## Requirements *(mandatory)*

### Functional Requirements

**The control**

- **FR-001**: The app header MUST contain a power control adjacent to the theme toggle, present on every screen where the header appears.
- **FR-002**: Activating the power control MUST open a panel containing a **vertical lever** presented as an aircraft-style thrust lever with a visible power scale, and MUST close on a second activation, on selection elsewhere, or on dismiss.
- **FR-003**: The lever MUST let the user choose a power limit across a continuous-feeling range from a defined minimum to a defined maximum, where the maximum means "no restriction".
- **FR-004**: The lever MUST be operable by pointer (drag and click-to-position) and by keyboard, and MUST expose its current value, range, and purpose to assistive technology.
- **FR-005**: The panel MUST show the currently selected limit as a number, and the header icon MUST indicate at a glance when a reduced limit is active.
- **FR-006**: The lever's position MUST always reflect the limit actually in force; if applying a change fails, the control MUST return to the effective value and tell the user it did not apply.

**The limit**

- **FR-007**: The selected limit MUST act as a **single shared budget across all local tools simultaneously** — compressor, landing optimizer, landing preview, transcription, media/image actions, team-workspace local processing, voice isolation, and any local tool added later. Concurrent work MUST stay within the one budget in aggregate.
- **FR-008**: Any local tool added in the future MUST fall under the limit by default, without needing its own setting or opt-in.
- **FR-009**: A change to the limit MUST take effect on **already-running** work, not only on newly started work, within 5 seconds.
- **FR-010**: Changing the limit MUST NOT cancel, restart, fail, or alter the output of in-flight work; only its duration may change.
- **FR-011**: The limit MUST persist across app restarts and agent restarts on the same machine, and MUST default to unrestricted (maximum) for a user who has never set it.
- **FR-012**: The limit MUST be scoped per machine, not per user account, and MUST NOT be synchronised across devices.
- **FR-013**: When the limit is at its minimum, the system MUST still complete work — throughput may be low but MUST NOT be zero.
- **FR-014**: The enforced behaviour MUST be equivalent on Windows and macOS, with the same range, the same defaults, and the same user-visible wording.

**The live readout**

- **FR-015**: The panel MUST display, in text, an approximate real-time figure for how much of the system's processing capacity Soty is currently consuming, expressed as a percentage of the whole system.
- **FR-016**: The readout MUST refresh at least once every 2 seconds while the panel is open, and MUST convey idle vs. active clearly.
- **FR-017**: The readout MUST cover Soty's local processing as a whole, including work performed by the external tools Soty runs on the user's behalf — not just the agent process itself.
- **FR-018**: When a consumption figure cannot be obtained (no agent connected, agent too old, measurement unavailable on the platform), the readout MUST say so explicitly and MUST NOT show a stale or invented value.
- **FR-019**: Measuring and reporting consumption MUST NOT itself be a meaningful contributor to load, and MUST stop when the panel is closed.

**Boundaries and behaviour**

- **FR-020**: The limit MUST apply only to local processing on the user's machine; it MUST NOT throttle interface responsiveness, uploads/downloads, or any remote/server-side work.
- **FR-021**: When no local agent is connected, the panel MUST open, state that fact, hide the consumption figure, and preserve the user's chosen setting for the next connection.
- **FR-022**: When the connected local agent is too old to honour the limit, the user MUST be told the limit is not in force and directed to update.
- **FR-023**: Changes made in one app window MUST be reflected in any other open window of the same app on that machine.
- **FR-024**: Opening the panel, moving the lever, and the resulting effective limit MUST be recorded as product telemetry consistent with existing analytics practice, without capturing machine-identifying detail beyond what is already collected.

### Key Entities

- **Power Limit**: The user's chosen ceiling on local resource use, expressed as a percentage of the machine, ranging from a defined minimum to unrestricted. One value per machine, persisted, shared by every local tool.
- **Consumption Sample**: A point-in-time estimate of the share of the machine's processing capacity currently used by Soty's local work, plus whether the figure is available and whether Soty is idle or active.
- **Local Tool**: Any capability Soty performs on the user's own machine (compression, optimization, preview rendering, transcription, media/image conversion, voice isolation, future additions). Every local tool is a consumer of the single Power Limit.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the limit at its minimum, Soty's measured share of system processing capacity during a sustained local job stays at or below the selected limit plus a 10-percentage-point tolerance, averaged over any 30-second window.
- **SC-002**: Moving the lever changes the observed consumption of already-running work within 5 seconds, with no job failures.
- **SC-003**: A job run at a reduced limit produces output identical to the same job run unrestricted; only elapsed time differs.
- **SC-004**: A user can find the control, reduce Soty's power, and confirm the change in the live readout in under 15 seconds, without documentation.
- **SC-005**: With the limit reduced, a user can carry out ordinary work (browsing, editing, video calls) alongside a running Soty job without perceiving system-wide slowdown, in 90% of trial sessions.
- **SC-006**: The chosen limit survives an app restart and an agent restart in 100% of trials.
- **SC-007**: The live readout is available and updating within 2 seconds of the panel opening, in 95% of openings with an agent connected.
- **SC-008**: Windows and macOS produce consumption within 15 percentage points of each other for the same job at the same limit on comparable hardware.
- **SC-009**: Every local tool, including one added after this feature ships, is covered by the limit with no tool-specific configuration — verified by exercising each tool under a reduced limit.
- **SC-010**: The panel's own measurement adds no more than 1% of system processing capacity while open.

## Assumptions

- **Resource meaning**: "Resources" is interpreted as **processor capacity** (the share of the machine's total CPU throughput). Memory, disk, GPU, and network are out of scope for this feature; a future extension could widen it.
- **Range and default**: The range is 20%–100% as stated by the user, with 100% (unrestricted) as the default for anyone who has not set it. Values below 20% are not offered because they risk stalling work.
- **Approximate, not guaranteed**: The limit is a best-effort ceiling with short overshoot around job start-up and transitions, not a hard real-time guarantee. The success criteria encode a tolerance accordingly.
- **Percentage of the whole machine**: Both the limit and the readout are expressed as a share of the entire system's capacity, not of a single core — this matches the user's phrasing "у відсотках від системи".
- **Per-machine scope**: The setting belongs to the machine because it describes that machine's capacity; it is deliberately not synced to the account (FR-012).
- **Voice isolation**: Named by the user as in scope; it does not exist in the product yet. It is covered by the "all local tools, including future ones" requirement (FR-007, FR-008) rather than by dedicated work here.
- **Header placement**: The control sits in the same header actions cluster as the theme toggle, on every screen that renders the app header. Public/marketing pages that show a header without a local agent connection show the control in its "no agent connected" state (FR-021).
- **Existing seams reused**: The feature builds on the existing local-agent connection, its existing live-update channel, existing persisted-settings behaviour, and existing analytics conventions rather than introducing new user-facing infrastructure.
- **Unrestricted means unchanged**: At the maximum setting the system behaves exactly as it did before this feature existed — same speed, same resource use, no scheduling change. The default is the maximum, so a user who never opens the control experiences no difference at all. This is a constraint on the implementation, not merely an expectation.
- **Scheduling priority is set once per job**: Work started while a limit is in force keeps the lower scheduling priority it was given, even if the limit is raised afterwards. Raising the limit still speeds that work up, because the ceiling itself lifts immediately; only its politeness toward other applications persists for the remainder of that job. New work started after the change gets normal priority. This is a platform constraint — an ordinary application may lower its own priority but not raise it back.
- **Older agents**: Users on an agent build that predates this feature keep working exactly as today, and are told the limit is not in force (FR-022).
- **Idle definition**: "Idle" means no local job is running; a small non-zero baseline from the agent simply waiting is reported as idle.
