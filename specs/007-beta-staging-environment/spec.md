# Feature Specification: Beta Staging Environment

**Feature Branch**: `007-beta-staging-environment`

**Created**: 2026-08-19

**Status**: Draft

**Input**: User description: "треба придумати щоб була окрема гілка бета і з неї якось збиралась типу копія прода(чисто технічно без аналітики і юзерів) просто щоб все працювало як на проді але запускалось можно навіть локально чи ще якось тобі видніше як. Головна мета щоб я міг тестувати нові фічі не на проді. А вже потім відтестовані зливати і релізити"

## Overview

Today there is exactly one place where the product behaves like the real thing: production. Every new feature is therefore either tested against real users and real analytics, or not tested end-to-end at all. This feature introduces a **beta environment**: a dedicated `beta` line of work that produces a full, working copy of the product — same screens, same flows, same desktop app behaviour, same release/pairing/entitlement mechanics — but pointed at **no real users and no real analytics**. The maintainer runs it, exercises a candidate feature exactly as a customer would, and only then merges the work forward for a real release.

The beta environment is a *testing surface*, not a second product. It must never appear to end users as a release, never write into production data, and never be mistakable for the production build by the update/manifest machinery.

## Clarifications

### Session 2026-08-20

- Q: What backs the beta environment's own database and identity store? → A: A fully local stack on the maintainer's machine — the project's existing local Supabase stack (already configured in-repo with its migrations and edge functions) provides the beta database, authentication, and serverless functions. Production URLs and keys are absent from the beta environment entirely.
- Q: How does the local tooling / desktop side run in beta — from source, or as a packaged beta build? → A: Both. A fast run-from-source mode for day-to-day work, plus a packaged beta build; a verification run on the packaged beta build is a required step before promoting anything to production.
- Q: Should the beta environment be reachable from outside the maintainer's machine? → A: No. Beta is reachable only on the local loopback interface, on ports and data directories distinct from both a production installation and an ordinary development run.
- Q: Which external integrations must genuinely work in beta? → A: The beta environment must be fully usable with no third-party registration at all — authentication, outbound messages via a local capture sink, agent token and entitlement issuance on a beta-only test key, media tooling, pairing, and team/workspace flows all run against local counterparts. External-storage (Drive) connection is an opt-in extension enabled by a documented one-time setup of a maintainer-owned test credential; until it is configured, Drive-dependent flows are visibly marked unavailable in beta.
- Q: How is beta configuration kept out of production, and how does the beta line relate to the production line? → A: Beta configuration lives only in git-ignored local files generated from a committed placeholder template; no tracked file carries a beta endpoint, key, or switch value. The beta line is long-lived: feature work lands there first, and the production line receives it only by merge from beta, never by a direct commit that bypasses beta verification.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run a production-equivalent copy from the beta line (Priority: P1)

The maintainer has work-in-progress on the beta line. With one documented command they bring up a complete, working copy of the product — desktop-side tool behaviour plus the web experience — configured against beta (non-production) identity and data. Everything that works in production works here: sign-in, pairing the local tool to the site, the media tools, team/workspace flows, landings, transcription. Nothing that happens is recorded as production analytics, and no production account is touched.

**Why this priority**: This is the entire point of the feature. Without a runnable production-equivalent copy, there is nothing to test on, and the remaining stories have nothing to attach to. It is independently valuable even if the promotion workflow (Story 3) stays manual.

**Independent Test**: Check out the beta line on a clean machine, follow the documented start command, complete a full end-to-end journey (sign in with a beta account → pair the local tool → run one media job to completion → view the result), and confirm the production analytics store and production user store received nothing.

**Acceptance Scenarios**:

1. **Given** a clean checkout of the beta line and the documented prerequisites, **When** the maintainer runs the single documented start command, **Then** the full product is reachable and usable within the documented startup budget, with no manual editing of configuration files required.
2. **Given** the beta environment is running, **When** the maintainer completes a full end-to-end journey (authenticate → pair → run a job → see the result), **Then** every step succeeds with the same behaviour and the same visible states as production.
3. **Given** the beta environment is running, **When** the maintainer performs any action that would normally emit product telemetry, **Then** no event of any kind is written to the production analytics store.
4. **Given** the beta environment is running, **When** the maintainer authenticates, **Then** the account used exists only in the beta identity store and no production account can be signed into.
5. **Given** the beta environment is running, **When** any part of the product attempts to reach a production endpoint or production data store, **Then** the attempt is prevented and surfaced as a clear, named failure rather than silently succeeding.

---

### User Story 2 - Tell beta apart from production at a glance (Priority: P1)

Anyone looking at a running copy — the maintainer, a tester, a screenshot in a bug report — can tell within seconds that it is beta and not production. The distinction is visible in the product itself, and it is also structural: beta artifacts carry a beta identity so that update, manifest, and packaging machinery cannot confuse the two.

**Why this priority**: A production-equivalent copy that *looks* identical is a footgun. Without unmistakable labelling, a maintainer will eventually debug beta while believing it is production (or worse, the reverse), and beta artifacts could leak into the real update channel. This must ship with Story 1, not after it.

**Independent Test**: Start the beta environment, screenshot the main screen and the about/version surface, and confirm a non-technical observer identifies it as beta. Separately, ask the release verification gate to treat a beta artifact as a production release and confirm it refuses.

**Acceptance Scenarios**:

1. **Given** the beta environment is running, **When** the maintainer opens any main screen, **Then** a persistent, unmistakable beta indicator is visible without scrolling or opening a menu.
2. **Given** the beta environment is running, **When** the maintainer opens the version/about surface, **Then** it states the beta environment name and the exact source revision the copy was built from.
3. **Given** a beta-built artifact, **When** the release verification gate evaluates it as a production release candidate, **Then** the gate fails with an explicit reason naming the beta identity.
4. **Given** a beta-built artifact, **When** the production update channel is queried, **Then** the beta artifact is absent from it and is never offered to a production installation as an update.
5. **Given** the production environment, **When** the maintainer opens any screen, **Then** no beta indicator appears anywhere.

---

### User Story 3 - Promote tested work from beta to a real release (Priority: P2)

Once a feature has been exercised in beta and judged good, the maintainer merges the beta line forward and releases through the existing production release path. The promotion is a documented, repeatable sequence, and the release path refuses to proceed if the code being released is not the code that was tested, or if any beta-only setting would travel with it.

**Why this priority**: Testing without a trustworthy path to production leaves the maintainer hand-carrying changes, which reintroduces exactly the risk the beta environment was built to remove. It is P2 rather than P1 because the existing manual release path already works — this story hardens and documents the hand-off.

**Independent Test**: Take a change through the full loop — land it on beta, verify it in the beta environment, promote it, and release — and confirm the released build contains the change, contains no beta-only configuration, and that a deliberate attempt to release un-promoted or beta-configured code is rejected.

**Acceptance Scenarios**:

1. **Given** a feature verified in the beta environment, **When** the maintainer follows the documented promotion sequence, **Then** the change reaches the production line with no manual re-application of edits.
2. **Given** a promotion attempt that would carry beta-only configuration into production, **When** the production release gate runs, **Then** it fails and names the offending setting.
3. **Given** a production release, **When** the maintainer inspects it, **Then** it is traceable to the exact revision that was exercised in the beta environment.
4. **Given** the beta line has diverged from the production line, **When** the maintainer starts a promotion, **Then** any divergence requiring a decision is reported before anything is published.

---

### User Story 4 - Reset beta to a known-clean state (Priority: P3)

Testing leaves debris: half-finished jobs, junk accounts, stale workspaces, orphaned files. The maintainer can return the beta environment to a documented clean baseline on demand, and can seed it with a small set of representative fixtures (an account, a workspace, a sample media item) so that a test run starts from a predictable place.

**Why this priority**: Valuable for repeatability and for reproducing reported bugs, but the environment is usable without it — a maintainer can tolerate accumulated debris for a while. Deferring this does not block Stories 1–3.

**Independent Test**: Dirty the beta environment with several jobs and accounts, run the documented reset, and confirm the environment returns to the documented baseline and that a fresh end-to-end journey succeeds immediately afterwards.

**Acceptance Scenarios**:

1. **Given** a beta environment with accumulated test data, **When** the maintainer runs the documented reset, **Then** the environment returns to the documented clean baseline within the documented time budget.
2. **Given** a freshly reset beta environment, **When** the maintainer opts to seed fixtures, **Then** the documented representative fixtures are present and immediately usable.
3. **Given** a reset is requested, **When** the command runs, **Then** it can only ever affect beta data and refuses to run against production regardless of how it is invoked.

---

### Edge Cases

- **Beta config reaches production**: A beta-only setting is committed on the production line, or a promotion merge silently carries one across. The production release gate must fail and name the setting; a green production release with beta configuration is a total failure of this feature.
- **Production config reaches beta**: A production endpoint, key, or account is configured in the beta environment. Beta must refuse to start rather than start and quietly talk to production.
- **Beta artifact offered as a production update**: A beta build is signed, listed, or otherwise published where a production installation can find it. The update channel must never surface it.
- **Two copies at once**: The maintainer runs beta and production side by side on the same machine. Both must run without colliding over ports, local application data, caches, or paired-tool sessions, and each must remain clearly identified.
- **Beta backend unreachable**: The beta data or identity backend is down or was never started. The environment must fail with a clear, actionable message naming what is missing, not fall back to production and not fail with an opaque error.
- **Stale beta after a contract change**: The beta line changes a data or protocol contract, and the beta backend is still on the old shape. The mismatch must be reported explicitly on startup, with the documented remedy being a reset or migration.
- **Beta line falls far behind production**: Production is released several times while beta sits idle. Starting beta must report how far behind it is so the maintainer does not test against a stale baseline and draw false conclusions.
- **Secrets in the beta line**: Beta credentials must never be committed to the repository, and a beta credential must never be usable against production.
- **External third-party integrations**: Flows that depend on external providers (sign-in providers, external storage/drive connections, payment or entitlement issuance) may not have a beta counterpart. Each such flow must either work against a beta counterpart or be explicitly and visibly marked as not exercisable in beta — never silently fall through to the production integration.

## Requirements *(mandatory)*

### Functional Requirements

**Environment definition and isolation**

- **FR-001**: The project MUST define a named `beta` line of work that is the sole source of beta builds, kept separate from the production line and from short-lived feature work.
- **FR-002**: The beta environment MUST provide functional parity with production for every user-facing flow: authentication, pairing the local tool to the site, all media tooling, workspace/team flows, landings, and transcription. Flows that depend on an external third-party service reach parity once that service's documented beta opt-in is complete, and until then MUST behave as FR-027d requires.
- **FR-002a**: The beta environment MUST support two run modes: a fast run-from-source mode for day-to-day work, and a packaged beta build that exercises the same packaging behaviour as a production install (bundled tool resolution, packaged-mode paths, entitlement gating, update checks).
- **FR-002b**: Verifying a candidate change on the packaged beta build MUST be a required step of the promotion sequence; run-from-source verification alone MUST NOT be sufficient to promote.
- **FR-003**: The beta environment MUST use a data store that runs entirely on the maintainer's own machine and contains no production user data and no production analytics data.
- **FR-004**: The beta environment MUST use an identity store that runs entirely on the maintainer's own machine, such that no production account can authenticate into beta and no beta account can authenticate into production.
- **FR-005**: The beta environment MUST NOT write any product telemetry to the production analytics store; telemetry emitted in beta is either discarded or routed to a beta-only sink.
- **FR-006**: The beta environment MUST refuse to start when it is configured with any production endpoint, key, or data store, and MUST report which setting caused the refusal.
- **FR-007**: The beta environment MUST run alongside both a production installation and an ordinary development run on the same machine, using network ports, local application data directories, and caches distinct from each, so none of the three contends with the others over ports, stored data, or paired-tool sessions.
- **FR-008**: Beta credentials and beta-only configuration MUST exist only in git-ignored local files, generated by the maintainer from a committed example template. No tracked file may contain a beta endpoint, a beta key, or a beta-only behaviour switch value.
- **FR-008a**: The committed example template MUST contain placeholders only, and MUST be sufficient, once filled in as documented, to start the beta environment.

**Startup and operation**

- **FR-009**: A maintainer MUST be able to bring up the complete beta environment with a single documented command, having satisfied a documented prerequisite list, and without hand-editing configuration.
- **FR-009a**: The beta environment MUST be reachable only on the maintainer's machine via the local loopback interface, and MUST NOT bind to an externally reachable network address.
- **FR-010**: The startup process MUST verify its own prerequisites and report each missing prerequisite by name and with a remedy, rather than failing partway through with an opaque error.
- **FR-011**: The startup process MUST report the source revision the copy was built from and how far the beta line is behind the production line.
- **FR-012**: A maintainer MUST be able to shut the beta environment down cleanly with a single documented command, leaving no orphaned background work.
- **FR-013**: The documentation MUST cover prerequisites, start, stop, reset, promotion, and troubleshooting for the most common startup failures.

**Identification and containment**

- **FR-014**: Every main screen of a running beta copy MUST display a persistent, unmistakable beta indicator that requires no scrolling or menu interaction to see.
- **FR-015**: The version/about surface of a beta copy MUST state the beta environment name and the exact source revision.
- **FR-016**: Beta artifacts MUST carry a beta identity distinct from any production release identity.
- **FR-016a**: Beta artifacts MUST NOT be signed with, and MUST NOT be verifiable by, the production signing key.
- **FR-017**: The production release verification gate MUST reject any artifact carrying a beta identity, naming the beta identity as the reason.
- **FR-018**: Beta artifacts MUST NOT appear in the production update channel and MUST NOT be offered as an update to any production installation.
- **FR-019**: The production build MUST NOT display a beta indicator anywhere.

**Promotion to production**

- **FR-020**: The project MUST document a repeatable promotion sequence that carries verified beta work onto the production line without manual re-application of changes.
- **FR-020a**: The beta line MUST be a long-lived integration line: feature work lands there first, and the production line MUST receive that work only by merge from the beta line, never by a direct commit that bypasses beta verification.
- **FR-021**: The production release gate MUST reject a release that carries any beta-only configuration, naming the offending setting.
- **FR-022**: A production release MUST be traceable to the source revision that was exercised in the beta environment.
- **FR-023**: The promotion sequence MUST report any divergence between the beta and production lines that requires a human decision, before anything is published.

**Reset and fixtures**

- **FR-024**: A maintainer MUST be able to return the beta environment to a documented clean baseline with a single documented command.
- **FR-025**: The reset operation MUST be incapable of affecting production data, regardless of how it is invoked or how the environment is configured.
- **FR-026**: The maintainer MUST be able to seed the reset environment with a documented set of representative fixtures sufficient to begin an end-to-end journey immediately.

**External integrations**

- **FR-027**: The beta environment MUST be fully usable without registering for or configuring any external third-party service. Authentication, message/email delivery, agent token and entitlement issuance, media tooling, tool pairing, and team/workspace flows MUST all operate against local beta counterparts.
- **FR-027a**: Outbound messages (sign-in links, invitations, notifications) MUST be captured by a local inspectable sink and MUST NOT be delivered to any real recipient. This applies to **every** delivery path, including messages sent server-side through a third-party delivery provider rather than through the platform's own mail transport: in beta, no third-party delivery provider may be configured, and any flow that would otherwise send through one MUST surface the message locally instead of sending it.
- **FR-027e**: The beta environment MUST refuse to start when a third-party delivery provider credential is configured, naming the offending setting.
- **FR-027b**: Agent tokens and entitlements MUST be issued in beta using a beta-only test key; a beta-issued token MUST NOT be accepted by production, and a production-issued token MUST NOT be accepted by beta.
- **FR-027c**: External-storage (Drive) connection MUST be an opt-in extension of the beta environment, enabled by a documented one-time setup of a maintainer-owned test credential. The beta environment MUST start and be considered ready without it.
- **FR-027d**: While external-storage connection is not configured, every flow that depends on it MUST be visibly marked as unavailable in beta and MUST NOT fall through to the production integration.
- **FR-028**: The documentation MUST list which flows are exercisable in beta out of the box, which require the opt-in external-storage setup, and which cannot be exercised in beta at all, so a maintainer knows what beta verification does and does not cover.

### Key Entities

- **Beta line**: The named line of work that beta builds come from; sits between everyday feature work and the production line, and is the only accepted origin of a beta build.
- **Beta environment**: A running, production-equivalent copy of the product — its user-facing surface plus its local tooling — bound to beta configuration.
- **Beta configuration**: The set of endpoints, identity settings, and behaviour switches that make a copy beta; mutually exclusive with production configuration, and never committed in a form that reaches production.
- **Beta data store**: The store holding beta accounts, workspaces, and test artifacts. Contains no production data; resettable to a clean baseline.
- **Beta identity**: The marker carried by beta artifacts that distinguishes them from production releases and causes the production release gate and update channel to reject them.
- **Beta fixtures**: The documented representative seed data (account, workspace, sample media) that a reset environment can be populated with.
- **Promotion**: The documented act of moving verified beta work onto the production line, after which the existing production release path takes over.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A maintainer starting from a clean checkout can have a fully usable beta copy running in under 15 minutes on first attempt, and under 5 minutes on subsequent attempts.
- **SC-002**: 100% of user-facing flows behave identically in beta and in production, with external-storage flows counted only once the documented opt-in setup is complete.
- **SC-002a**: A maintainer with no external service accounts and no third-party registrations can complete a full end-to-end journey in beta on first attempt.
- **SC-003**: Zero production analytics events and zero production user records are created by beta activity, measured over a full end-to-end journey.
- **SC-004**: 100% of attempts to configure the beta environment against a production endpoint or data store are refused at startup with a message naming the offending setting.
- **SC-005**: 100% of attempts to release a beta-identified artifact through the production release path are rejected.
- **SC-006**: An observer shown a screenshot of a running copy identifies it as beta or production correctly 100% of the time.
- **SC-007**: A maintainer can return the beta environment to a documented clean, fixture-seeded baseline in under 5 minutes.
- **SC-008**: Promoting a verified beta change to a production release requires no manual re-application of that change, measured across at least three consecutive promotions.
- **SC-009**: Within the first quarter of use, zero new features reach production without having first been exercised in the beta environment.
- **SC-010**: Beta, production, and an ordinary development run can be active concurrently on one machine for a full working session with zero collisions over ports, local data, or paired-tool sessions.
- **SC-011**: 100% of promotions to production are preceded by a recorded verification run on a packaged beta build.
- **SC-012**: Zero beta endpoints, beta keys, or beta-only switch values are present in any tracked file, verified on every production release.
- **SC-013**: Zero messages of any kind are delivered to a real recipient as a result of beta activity, measured over a full end-to-end journey including an invitation flow.

## Assumptions

- The maintainer is the sole user of the beta environment; it is a private development surface, not something exposed to customers, and it needs no multi-tenant access control of its own.
- "Copy of production" means functional and behavioural equivalence, not data equivalence: production content is never cloned into beta, and beta starts empty or fixture-seeded.
- The existing production release, verification, and update mechanisms remain the single production path; this feature adds a gate in front of them rather than a second release path.
- Beta builds are for hands-on verification by the maintainer and are not distributed, signed for distribution, notarized, or published to any public channel.
- Beta credentials are generated locally or held by the maintainer outside the repository; the feature defines where the environment expects to find them and provides a placeholder template, not how they are issued.
- The beta environment runs entirely on the maintainer's machine and depends on a locally installed container/database runtime in addition to the tooling ordinary development already requires; this prerequisite is documented and checked at startup.
- The maintainer's machine has enough headroom to run beta and production side by side; the beta environment is sized for one person, not for concurrent use.
- The existing automated test suite remains the first line of defence; the beta environment covers what tests cannot — real end-to-end behaviour of the assembled product.
- Beta indicator wording and placement follow the product's existing visual conventions; no new design system work is implied.

## Out of Scope

- Distributing beta builds to external testers, or any signing/notarization/public update channel for beta artifacts.
- Cloning, anonymizing, or importing production data into beta.
- Exposing the beta environment on any externally reachable address, including a shared preview URL.
- Automating the production release itself (this feature ends at promotion; the existing release path is unchanged apart from the added beta-identity and beta-configuration rejections).
- Continuous integration changes such as gating pull requests, other than what is required to reject beta identity and beta configuration on the production path.
- Performance, load, or scale testing; the beta environment targets functional verification by a single maintainer.
- A permanently hosted, always-on beta site with its own uptime expectations.
