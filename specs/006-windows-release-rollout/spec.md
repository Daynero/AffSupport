# Feature Specification: Windows Release Rollout

**Feature Branch**: `beta` (no branch hook configured; feature directory `006-windows-release-rollout`)

**Created**: 2026-08-19

**Status**: Draft

**Input**: User description: "Потрібно створити спеку повної розкатки на віндовс юзерів, всі інструменти мають працювати аналогічно, при подальшій розробці я хочу просто добавляти або фіксити інструменти в одному місці і має працювати все на 2 платформах. головне щоб можна було після всіх змін релізити на віндовс юзерів. Уточнюю що поки без всяких підписів чи чогось такого, просто як є додаток збираємо безкоштовно, як по суті і на мак зараз"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A Windows user installs Soty and compresses their first video (Priority: P1)

A person on a Windows PC opens the hosted Soty site, is offered a Windows download instead of a
"coming soon" waitlist, downloads and runs the installer, gets past the operating system's
unknown-publisher warning with on-screen guidance, and lands back on the hosted page with the local
app already paired. They add a video, compress it, and find the result saved next to the original.

**Why this priority**: Without this, there is no Windows product at all. Everything else in this
feature is an extension of this single path, and this path alone already delivers the core value
Soty exists for (local, private video compression).

**Independent Test**: On a clean Windows machine with no developer tooling, complete the whole
journey — visit the site, download, install, launch, pair, compress a real video, open the output
folder — using only what the product shows on screen.

**Acceptance Scenarios**:

1. **Given** a visitor on Windows and a published Windows build, **When** they open the download
   surface, **Then** the Windows download is offered first and starts a real download (no waitlist
   dialog).
2. **Given** a visitor on Windows and no published Windows build, **When** they open the download
   surface, **Then** they still see the existing waitlist experience rather than a broken link.
3. **Given** a downloaded installer, **When** the user runs it and the operating system warns about
   an unidentified publisher, **Then** the product's own instructions (shown before/around the
   download) tell them exactly which button to click to continue.
4. **Given** a completed installation, **When** the machine finishes installing, **Then** the app
   starts automatically, shows a tray presence, and survives a reboot without the user re-launching
   it manually.
5. **Given** the local app is running, **When** the user returns to the hosted page, **Then** the
   page reports a paired local app and the video tools become usable within 10 seconds.
6. **Given** a paired Windows install, **When** the user compresses a video, **Then** progress is
   reported live, the finished file appears in the expected location, and "show in file manager"
   opens Explorer with the file selected.

---

### User Story 2 - Every tool behaves the same on Windows as on macOS (Priority: P2)

A user who has used Soty on a Mac (or who reads the site's feature list) expects the same set of
tools on Windows: video compression, image conversion/embedding, transcription, translation, landing
optimization, landing preview rendering, and the team workspace. Each one either works, or — where
the platform genuinely cannot offer it — is clearly absent rather than failing mid-use.

**Why this priority**: The user's explicit requirement is that "all tools work equivalently".
A Windows build that only compresses video would be a different, lesser product and would generate
support load from every user who tries the other tabs.

**Independent Test**: Run the same scripted tool-by-tool acceptance pass on Windows and on macOS
and compare outcomes; every tool must reach the same end state, or appear as unavailable up front
with a stated reason.

**Acceptance Scenarios**:

1. **Given** a paired Windows install, **When** the user opens each advertised tool, **Then** every
   tool either performs its full job or is presented as unavailable-on-this-system *before* the user
   invests any work in it.
2. **Given** a Windows install, **When** the user picks files or a folder through the app's own
   file/folder chooser, **Then** a native chooser opens in the foreground, supports multi-select and
   non-Latin paths, and cancelling leaves the app unchanged.
3. **Given** a Windows install, **When** the user transcribes a media file, **Then** the result and
   the exported transcript formats are equivalent to the macOS output for the same input.
4. **Given** a Windows install, **When** the user enables local translation for the first time,
   **Then** the required runtime downloads, verifies against a pinned checksum, and translation
   completes — with no "not pinned for this platform" dead end.
5. **Given** a Windows install, **When** the user renders a landing preview (single page, folder, or
   multi-landing archive), **Then** previews render from the bundled browser without asking the user
   to install anything.
6. **Given** a long-running Windows job, **When** the user pauses/cancels it, **Then** the app
   honours the request or clearly states that pausing is unavailable, and cancel always works and
   leaves no leftover temporary files.
7. **Given** a Windows install, **When** the user opens a tool that only exists on macOS (operating
   system file-manager context-menu integration), **Then** it is not advertised on Windows at all.

---

### User Story 3 - The maintainer releases to Windows users without owning a Windows machine (Priority: P3)

After making a change (a fix, a new tool, a tweak), a maintainer working only on a Mac triggers one
release procedure and ends up with both a macOS and a Windows build published under the same
version, both reachable by users from the hosted site — without hand-editing version numbers or URLs
in several places, without a code-signing certificate, and without ever touching Windows hardware.

**Why this priority**: This is the stated headline goal — being able to ship to Windows users after
every change. It depends on P1/P2 existing, but it is what turns a one-off port into an ongoing
channel. The maintainer has no Windows machine, so any step that silently requires one breaks the
whole channel.

**Independent Test**: Starting from a clean checkout at a given commit, on a macOS workstation only,
run the release procedure end to end and verify that both artifacts exist under one immutable
version, that the site offers each platform its own artifact, and that release verification refuses
to pass if either artifact is missing, mismatched, or has an unrecorded checksum.

**Acceptance Scenarios**:

1. **Given** a maintainer with no access to Windows hardware, **When** they run the release
   procedure, **Then** the Windows artifact is produced end to end in an automated hosted Windows
   environment, triggered from the repository, with no manual step on a Windows desktop.
2. **Given** a version bump in the single release-identity source, **When** the release procedure
   runs, **Then** both platform artifacts carry that same version and build identity, with no
   per-platform version edited by hand.
3. **Given** a produced Windows artifact, **When** it is recorded for distribution, **Then** its
   exact checksum is captured and covered by the same tamper-evidence protection the macOS artifact
   already has.
4. **Given** a release attempt where the Windows artifact is missing, failed to build, or its
   recorded checksum does not match the published file, **When** release verification runs, **Then**
   the release fails with a message naming the specific problem and the site is not deployed —
   macOS alone cannot ship.
5. **Given** the automated Windows build environment starts from a clean state, **When** it needs
   the bundled third-party programs and models, **Then** it obtains them from pinned,
   checksum-verified sources on its own, with no file uploaded from a maintainer's machine.
6. **Given** the release is published, **When** a Windows visitor loads the site, **Then** the
   download offered is the artifact of that exact published version.

---

### User Story 4 - Adding or fixing a tool once makes it work on both platforms (Priority: P4)

A maintainer adding a new tool, or fixing an existing one, writes the behaviour once. Anything the
two operating systems do differently (data locations, executable names, archive handling, revealing
files, launching helper programs, process control, name sanitization) is taken from one shared
platform boundary rather than being re-decided inside the tool.

**Why this priority**: This is the sustainability requirement — it does not change what today's user
sees, but without it the two platforms drift apart with every subsequent change and P2 silently
regresses.

**Independent Test**: Introduce a representative new tool (or port an existing one) and verify it
runs on both platforms without adding any new operating-system conditional outside the shared
platform boundary; then verify the automated checks catch a deliberately added stray conditional.

**Acceptance Scenarios**:

1. **Given** a new tool implemented against the shared platform boundary, **When** it is run on both
   platforms, **Then** it produces equivalent results with no platform-specific code in the tool
   itself.
2. **Given** a tool whose capability genuinely does not exist on one platform, **When** it is
   registered, **Then** it declares that as a capability flag consumed by both the local app and the
   hosted page, instead of failing at call time on one platform.
3. **Given** a change that introduces an operating-system conditional outside the shared platform
   boundary, **When** the project's automated checks run, **Then** the change is flagged.
4. **Given** the shared tool-capability list, **When** a tool is added or removed, **Then** the
   hosted page's tool availability, the app's busy/shutdown handling, and the compatibility contract
   all follow from that one list.
5. **Given** the automated test suite, **When** it runs on a maintainer's machine, **Then** the
   Windows-specific behaviours (paths, chooser invocation, archive handling, name sanitization,
   runtime descriptors) are covered by simulated tests that do not require a Windows machine.

---

### User Story 5 - Windows users receive updates (Priority: P5)

An existing Windows user is told a newer version is available, downloads it, installs it over the
existing installation, and continues with their queue, settings, and pairing intact — and is never
interrupted mid-job.

**Why this priority**: A rollout with no update path strands the first cohort on the first build.
It is last only because the first release can ship before the update loop is proven, and the manual
download path is the fallback.

**Independent Test**: Install version N on a Windows machine, publish version N+1, and verify the
user is informed, can update, keeps their data, and ends up on N+1.

**Acceptance Scenarios**:

1. **Given** an installed Windows version older than the published one, **When** the user opens the
   hosted page, **Then** they are told an update exists and are given the Windows artifact for the
   new version.
2. **Given** an update is being installed, **When** a job is currently running, **Then** the user is
   warned and the running job is either finished or explicitly cancelled before files are replaced.
3. **Given** an update completes, **When** the app restarts, **Then** the user's queue, saved
   settings, and pairing survive, and the version reported to the hosted page is the new one.
4. **Given** the user uninstalls, **When** uninstall completes, **Then** the app is stopped, it no
   longer starts at login, and the user's own produced media files are untouched.

---

### Edge Cases

- **Unsigned-binary warnings**: the operating system's reputation warning appears for a brand-new
  unsigned installer *and* possibly for the bundled helper programs. The product must tell users what
  to expect and what to click; it must not silently look broken.
- **Missing bundled prerequisite**: an installation where a bundled helper program is missing or
  blocked (antivirus quarantine) must surface a specific, actionable message rather than an endless
  "starting…" state.
- **Antivirus / firewall interference**: a security product quarantining a bundled program, or a
  prompt appearing for local-only networking, must be documented with a stated expected behaviour
  (local-only listening should not prompt) and a recovery path.
- **Non-Latin and long paths**: user names, file names, and folders containing Cyrillic characters,
  emoji, spaces, or exceeding conventional path length limits must not corrupt output names or fail
  silently.
- **Reserved and illegal names**: media whose name matches an operating-system reserved device name
  or contains characters illegal on one platform must produce a predictable, identical safe name on
  both platforms.
- **Capability gaps**: pausing a running job has no equivalent mechanism on Windows — the interface
  must not offer an action that cannot work.
- **Two installations at once**: launching the app twice, or leaving an old version running during
  an update, must resolve to exactly one running instance without corrupting the queue.
- **Locked files during update**: replacing files while the app is running must be handled by
  stopping it first; a failed update must leave a working previous version, never a half-replaced one.
- **Manifest without a Windows artifact**: if a release ships macOS-only, Windows visitors must fall
  back to the waitlist experience, not to a dead download link.
- **Version skew**: a Windows install older than the minimum compatible version must be told to
  update rather than half-working against the hosted page.
- **Non-x64 Windows**: a user on an unsupported Windows architecture or version must be told so
  before downloading.
- **Build-source disappears**: a pinned third-party download becoming unreachable or changing its
  checksum must fail the build loudly with a named cause, never silently substitute another build.
- **Windows build fails while macOS succeeds**: the release must stop entirely, and the previous
  release must remain the one users get — no partial publish, no orphaned tag.
- **Automated verification cannot cover a behaviour**: it must appear on the written unverified-risk
  list rather than being quietly assumed to work.

## Requirements *(mandatory)*

### Functional Requirements

**Distribution and installation**

- **FR-001**: The hosted download surface MUST offer a Windows download to Windows visitors whenever
  a Windows artifact is published for the current release, and MUST fall back to the existing
  waitlist experience when it is not.
- **FR-002**: The Windows installer MUST install the complete application — all bundled helper
  programs and models required for the tools declared available — without the user installing any
  prerequisite separately.
- **FR-003**: The Windows build MUST be distributed free of charge and unsigned (no publisher
  certificate, no notarization), matching the current macOS distribution posture.
- **FR-004**: Because the build is unsigned, the product MUST present first-run guidance that names
  the exact operating-system warning the user will see and the exact action to take, in every
  language the product supports.
- **FR-005**: The installer MUST configure the app to start with the user's session and MUST remove
  that configuration on uninstall.
- **FR-006**: The application MUST enforce a single running instance and MUST recover the local
  service automatically after a transient crash.
- **FR-007**: Uninstall MUST stop the running application, remove installed program files and the
  autostart entry, and leave user-produced media untouched.
- **FR-008**: The product MUST state its supported Windows versions and architecture, and MUST tell
  unsupported visitors before they download.

**Tool parity**

- **FR-009**: All tools currently advertised on macOS — video compression, image conversion and
  embedding, transcription, local translation, landing optimization, landing preview rendering, and
  the team workspace — MUST be fully functional on Windows.
- **FR-010**: The native file and folder chooser MUST be available on Windows, supporting
  multi-select, non-Latin paths, and cancellation, and MUST be gated on a declared capability rather
  than on a hard-coded platform check.
- **FR-011**: Local translation MUST work on Windows on first use, which requires the Windows
  translation runtime to be pinned by exact checksum and size before release; an unpinned runtime
  MUST block the release rather than degrade at runtime.
- **FR-012**: Landing preview rendering MUST use the bundled preview browser on Windows with no
  additional user download.
- **FR-013**: Revealing a produced file MUST open the platform file manager with that file selected.
- **FR-014**: Where a capability does not exist on a platform (operating-system file-manager
  context-menu integration; suspending a running job), the product MUST NOT advertise it on that
  platform, and any request for it MUST be refused with a stable, machine-readable reason.
- **FR-015**: File and folder names produced from user input MUST be sanitized identically on both
  platforms so the same input yields the same safe output name everywhere.
- **FR-016**: Per-user application data (queue state, imported media, caches, downloaded models)
  MUST be stored in the platform's conventional per-user location and MUST survive updates.

**Single-source development**

- **FR-017**: Every operating-system-specific mechanism (data locations, executable naming, archive
  creation/extraction, file-manager actions, opening files, process suspension, name sanitization)
  MUST be reachable only through one shared platform boundary; tool code MUST NOT branch on the
  operating system directly.
- **FR-018**: Tool availability MUST be derived from a single declared list consumed by the local
  app, the hosted page, and the compatibility contract, so adding or removing a tool is a one-place
  change.
- **FR-019**: Adding or fixing a tool MUST require changes in only one implementation, with no
  parallel platform-specific copy of the tool's behaviour.
- **FR-020**: The project's automated checks MUST flag a new operating-system conditional introduced
  outside the shared platform boundary.
- **FR-021**: Windows-specific behaviours MUST be covered by automated tests that run without a
  Windows machine, so parity regressions are caught during ordinary development.

**Release pipeline**

- **FR-022**: Version, build identity, artifact names, and download locations for both platforms
  MUST derive from the one existing release-identity source; no platform artifact may be versioned
  or addressed by a hand-written value.
- **FR-023**: Both platform artifacts of a release MUST be published under one immutable release
  identity, and a published release MUST never be rebuilt or replaced.
- **FR-024**: The published release manifest MUST record an exact checksum for each platform
  artifact and MUST remain covered by the existing tamper-evidence protection.
- **FR-025**: Both platform artifacts are mandatory for a stable release: release verification MUST
  fail — blocking the site deploy — when either platform artifact is missing, failed to build, has an
  absent or mismatched checksum, or carries a version other than the release's. macOS MUST NOT be
  able to ship alone.
- **FR-026**: The Windows artifact MUST be produced entirely by an automated hosted Windows build
  environment triggered from the repository. No release step may require the maintainer to operate a
  Windows machine, and the whole release MUST be initiable from a macOS workstation.
- **FR-027**: The automated Windows build MUST acquire every bundled third-party program and model
  it needs from pinned sources verified by exact checksum, without any artifact uploaded from a
  maintainer's machine, and MUST fail the build when a source is unreachable or its checksum does
  not match.
- **FR-028**: The release procedure for both platforms MUST be documented as one runnable sequence,
  listing every required input, every trigger, and its expected output, with no undocumented manual
  step.
- **FR-029**: The Windows build MUST be reproducible from a clean checkout of the released commit,
  producing the same version and build identity.
- **FR-030**: The automated Windows build MUST reject a payload that is incomplete or internally
  inconsistent (missing bundled program, wrong architecture, version mismatch against the release
  identity) rather than producing an installer that fails on a user's machine.
- **FR-031**: Third-party attribution and source-availability obligations for the Windows-specific
  bundled programs MUST be recorded before the first Windows release, naming the exact builds
  shipped, and MUST be refreshed automatically whenever a pinned source changes.

**Updates**

- **FR-032**: A Windows user running an older version MUST be told an update exists and be offered
  the new version's Windows artifact.
- **FR-033**: An update MUST NOT replace files while a job is running; the user MUST be warned and
  the job finished or explicitly cancelled first.
- **FR-034**: An update MUST preserve queue state, settings, and pairing, and MUST leave a working
  installation if it fails partway.
- **FR-035**: A Windows install below the minimum supported compatibility version MUST be told to
  update rather than allowed to half-work against the hosted page.

**Verification without owned hardware**

- **FR-036**: Every Windows behaviour that cannot be exercised on macOS — native chooser dialogs,
  archive handling, the supervising host process, single-instance locking, crash restart, and
  shutdown — MUST be exercised automatically in the hosted Windows environment on every release
  build, and MUST block the release when it fails.
- **FR-037**: The automated Windows verification MUST cover, unattended, the full user path on a
  clean Windows environment: install, autostart, pairing with the hosted page, one job per available
  tool, update from the previous release, and uninstall.
- **FR-038**: Any behaviour that genuinely cannot be verified unattended (visual appearance of
  system warnings, dialog foreground behaviour, security-product interference) MUST be listed
  explicitly as a known unverified risk and MUST be checked by a human tester with Windows access —
  a recruited waitlist tester or a rented cloud Windows desktop — before the first public Windows
  release, with results recorded.
- **FR-039**: The set of behaviours in FR-038 MUST be a closed, written list, so it is visible when
  it grows rather than accumulating silently.

**Rollout**

- **FR-040**: Downloads and tool usage MUST be attributable to a platform in the existing analytics
  so Windows adoption and failure rates are observable after launch.
- **FR-041**: People already on the Windows waitlist MUST be identifiable so they can be told when
  the build ships.
- **FR-042**: The first public Windows release MUST be preceded by a limited pre-release pass with
  real Windows users, and the results MUST be recorded before the download is offered to all Windows
  visitors.

### Key Entities

- **Release identity**: the single record of what a given release is — version, build number, build
  identity, channel, and compatibility range — shared by every artifact and by the hosted page.
- **Platform artifact**: one downloadable installer for one operating system and architecture,
  addressed by location and identified by an exact checksum, belonging to exactly one release.
- **Release manifest**: the published, tamper-evident description of the current release listing all
  its platform artifacts and the tool compatibility requirements.
- **Tool**: a user-facing capability of the local application (compression, image conversion,
  transcription, translation, landing optimization, landing preview, team workspace), declared once
  with its compatibility level and its platform capability requirements.
- **Platform capability**: a named ability the host operating system may or may not provide (native
  chooser, reveal-in-file-manager, content search, job suspension, shell context-menu integration),
  declared per platform and consumed by tools and by the interface.
- **Local application install**: an installation on a user's machine with a version, a data location,
  an autostart registration, and a pairing relationship to the hosted page.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A Windows user with no technical background completes the path from the site to a
  finished compressed video in under 10 minutes, including download and install, on the first
  attempt.
- **SC-002**: 100% of tools advertised on macOS are either fully functional on Windows or explicitly
  marked unavailable before use; zero tools fail after the user has started work in them.
- **SC-003**: For an identical input file and settings, the outcome on Windows matches macOS on
  every tool (same produced files, same names, comparable quality/content), verified across a fixed
  acceptance set.
- **SC-004**: A maintainer publishes a release for both platforms from a macOS workstation alone, by
  following one documented procedure, with zero values typed by hand into more than one place and
  zero steps performed on Windows hardware.
- **SC-005**: A release attempt with a missing, failed, or mismatched Windows artifact is blocked by
  verification 100% of the time and never reaches users — including when macOS is fine.
- **SC-006**: A representative new tool is added and works on both platforms with changes made in a
  single implementation and zero new operating-system conditionals outside the shared platform
  boundary.
- **SC-007**: An existing Windows user moves from one version to the next with their queue,
  settings, and pairing intact, and with no job interrupted mid-run.
- **SC-008**: Within 30 days of launch, Windows sessions show a tool-failure rate no more than 1.5×
  the macOS rate, and the share of downloads that never reach a paired install is measurable and
  reported.
- **SC-009**: 100% of Windows users who hit the unsigned-publisher warning have on-screen guidance
  available at that moment naming the exact action to take.
- **SC-010**: Every Windows behaviour that cannot run on macOS is exercised automatically on each
  release build; the list of behaviours left to human checking is written down and contains no more
  than the items in the agreed unverifiable set.
- **SC-011**: The time from "change merged" to "both platform artifacts published and the site
  deployed" is short enough that shipping after every change is practical — under one hour of
  unattended pipeline time, with no maintainer step between the two platforms.

## Assumptions

- **Unsigned distribution is intentional and accepted.** No publisher certificate is purchased for
  this release; the operating system will show an unknown-publisher warning, and the mitigation is
  user guidance, not signing. This mirrors the current macOS posture (ad-hoc signature, no
  notarization). Signing may be revisited later and is out of scope here.
- **Target platform is Windows x64** on currently-supported Windows 10 and Windows 11 releases; ARM
  Windows and 32-bit are out of scope for this rollout.
- **Operating-system shell integration (file-manager context menus / right-click services) stays
  macOS-only.** It is an operating-system extension, not one of the product's tools; Windows users
  reach the same functionality through the app itself. This is documented as a deliberate,
  advertised difference rather than a gap to close.
- **Suspending a running job is unavailable on Windows** because the platform offers no equivalent
  mechanism; cancellation covers the user need and the interface reflects the difference.
- **Windows is a mandatory, release-gating artifact** (confirmed by the maintainer): from the first
  Windows release onward, a stable release that cannot produce a valid Windows artifact does not
  ship at all, including macOS. The consequence is accepted: a broken Windows build blocks macOS
  releases too, which is the intended pressure to keep both platforms working.
- **The maintainer owns no Windows machine** (confirmed). Every build and verification step
  therefore runs in an automated hosted Windows environment; a manual "do this on your Windows PC"
  step is not an acceptable part of any procedure. Human-eye checks that cannot be automated are
  handled by a recruited tester or a rented cloud Windows desktop, once, before the first public
  release.
- **Third-party Windows programs are fetched by the build, not held by a person.** Because no
  maintainer machine holds them, the pinned sources must be publicly reachable and checksum-stable;
  a source going away is a release-blocking event with a documented recovery path (re-pin a new
  build, record the new attribution).
- **The existing hosted page, pairing model, entitlement checks, and team workspace work unchanged
  on Windows** — they are platform-neutral and require no Windows-specific behaviour.
- **All required third-party programs for Windows exist as portable/static builds** that can be
  bundled and redistributed under their licenses; obtaining and recording them is part of this work.
- **The first Windows release ships the same tool set as the current macOS release**; no
  Windows-exclusive feature is introduced.
- **Localization coverage** for new Windows-specific guidance follows the product's existing
  languages (English and Ukrainian).
- **Existing macOS behaviour must not regress**: every change made for parity is additive from the
  macOS user's point of view.
