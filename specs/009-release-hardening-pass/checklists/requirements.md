# Specification Quality Checklist: Release Hardening Pass

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-23
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Validation Notes

**Iteration 1 → 2 corrections applied (self-review):**

1. *Implementation detail leak* — the first draft named concrete technologies in requirements
   (SSE, Fastify, CSP header names, `vitest`, `SIGTERM`/`SIGKILL`, ffmpeg). Rewritten in outcome
   terms: "live update", "the local app", "protective headers", "verification", "end the underlying
   processing, escalating if the first attempt is not honoured". The one remaining named artifact
   is a content security policy in FR-025, kept because it is the name of the user-facing
   guarantee, not of an implementation choice.
2. *Unmeasurable success criteria* — "faster", "smaller", "more secure" replaced with
   figures against a recorded baseline (SC-014: ≥40% / ≥30%), counts (SC-008: ≥30 attack
   attempts, 100% refused), windows (SC-002: 5 s; SC-004: 10 pp over 60 s), and ceilings
   (SC-005: <10 min, <100 lines).
3. *Unbounded scope* — the Assumptions section now states explicitly that this feature adds no
   capability, and that where a guarantee cannot be met without behaviour change the honest-
   downgrade is preferred (stated concretely for run resumption in FR-008).
4. *Evidence separated from specification* — the audit that motivated each requirement was moved
   to `findings.md` so `spec.md` stays readable by a non-technical stakeholder while nothing
   discovered is lost. SC-019 binds the two: every finding must be resolved or explicitly
   accepted with a reason. (The clause requiring each fix to carry a failing-first test was
   dropped in iteration 3 — after a merge it is not verifiable, so it belongs to how the work is
   done, not to whether the outcome was achieved.)

**Iteration 2 → 3 corrections applied (independent adversarial review):**

An independent reviewer was asked to attack the draft. Twenty-one defects were reported; the
substantive ones were fixed:

5. *The user's own headline symptom had no requirement.* The audit's D10 (seven separate live
   connections against a six-connection browser budget, so ordinary actions queue behind streams
   that never end) and D11 (two tabs racing a start) were recorded as findings with no FR, no
   scenario and no criterion — while being the closest thing in the audit to "started something,
   stopped it, tried to continue something else, nothing responded". Added FR-009b, FR-009c,
   US1 scenarios 9–10, SC-020, SC-021, and an edge case.
6. *Unachievable criteria.* "Output identical to a job that was never stopped" is not guaranteed
   by any multi-threaded encoder, and the power feature deliberately suspends processes; replaced
   with a defined equivalence. "Nothing the application **displays** may contain a file name"
   fails permanently in a file-queue product; narrowed to what leaves the machine and what is
   logged. SC-010 (publisher verification) was mandatory while its input was declared out of
   scope; made conditional on credentials with the chain provable using test ones.
7. *Criteria that could never fail.* SC-005's ten-minute ceiling sat above a measured 53 seconds,
   and its output cap covered only successful runs — the case that costs nothing. Now caps the
   failing run too and splits the fast and full forms. SC-014 could be met by deleting one
   constant; now requires each of the three largest pieces to fall. SC-004 had no denominator;
   SC-002 and FR-012 rested on an undefined "idle" — all three now carry units, a window and a
   threshold. FR-034's grace period is now a number, so SC-012 cannot be satisfied by never
   reacting.
8. *Contradictions.* FR-026's "current session" forbade the queue restoration FR-006 requires;
   FR-003 demanded cleanup on a crash that by definition cannot run cleanup (split into FR-003
   and FR-003a); SC-013's "never moves backwards" outlawed the re-run FR-008 mandates (scoped to
   one run); FR-023 as written would have broken Soty's own local companion (carve-out added).
9. *Findings with no requirement.* Six security observations — command construction from
   user text, handing an unverified location to the operating system, imported media never
   removed, credential file permissions, an override that defeats its own integrity check, and
   development-only trust settings shipped to production — were recorded and then orphaned.
   Added as FR-032a–FR-032f plus SC-023.
10. *An architectural finding silently declined.* The audit calls the five separate run
   lifecycles "the strongest structural argument for a single explicit lifecycle"; the draft's
   Key Entities quietly froze all five. Now states plainly that unification is a real open
   question, that it is deferred to planning, and why.
11. *A factually wrong finding.* The audit cited a stacking value of 10001 as sitting above every
   modal; it is a view-transition pseudo-element in its own overlay context, with a comment
   explaining it. Corrected in place rather than deleted, so the correction is visible.
12. *Confidence was not carried forward.* The audit's most quoted conclusion — that a brief
   connection drop traps the user in an un-closable dialog — was never observed, only read.
   The audit now opens with a confidence section, and every inferred or hypothetical finding is
   labelled at its own entry. The specification's Overview requires such findings to be confirmed
   by observation before being acted on.

Reported and deliberately **not** changed: the reviewer asked for 24 compound requirements to be
split into roughly 120 atomic ones, and for repository vocabulary (pull request, coverage,
runner, dependency) to be removed as implementation detail. Both were declined — the first trades
a readable document for a checklist, and the second would make a specification about automating
verification unable to name what it automates. FR-009 and FR-039 were also kept as deliberate
roll-ups, because "this holds on both platforms" and "every tool page behaves the same" are the
guarantees a reader actually needs to see stated.

**Iteration 3 → 4 corrections applied (cross-artifact analysis):**

`/speckit-analyze` compared spec, plan and tasks and returned 18 findings, 0 critical. All were
acted on:

13. *Two requirements had zero tasks.* **FR-004** (a stop releases the queue slot immediately, so
    the next thing starts without waiting) — the requirement closest to the user's own words —
    and **FR-013** (every heavy spawn passes through the limiter, enforced structurally). Added
    T045a and T020a.
14. *A success criterion that could not be demonstrated.* **SC-009** requires a sweep of
    everything transmitted finding zero file names or paths; the tasks covered logs and error
    payloads but never telemetry or the diagnostics response, which is where the audit's findings
    actually live. Added T147a.
15. *Ordering that buried the confirmed-live holes.* The plan put four security fixes in wave
    zero; the tasks put them in Phase 7, behind six phases of other work — including the host-header
    bypass and the token-in-URL fix, both confirmed by probing a running instance. Moved to
    **T014a–T014d in Phase 1**.
16. *Countable claims left as prose.* SC-008's "at least thirty attack attempts" and SC-023's
    adversarial name set existed only in a phase header. Added T152a (a counting assertion, the
    way T042 already does for SC-001) and T144a.
17. *An unbounded task on the critical path.* "Fix the Windows failures the first run surfaces"
    is unknowable scope sitting on the merge gate. Split into T119 (discovery, produces a list),
    T119a and T119b (consume it).
18. *A judgement call left undefined under delivery pressure.* "Flip the path ledger to enforce
    after one beta cycle" had no exit criterion. T178 now fixes the threshold — 200 observed uses
    across 10 sessions with zero unexplained refusals — and requires it to be set *before* T176
    ships.
19. *A repository setting with no owner.* SC-006 needs the four checks to be **required** to
    merge; the workflows are files, the requirement is a settings change. Added T118a.
20. *A type-safety hole in the new contract.* The lifecycle registry was typed
    `readonly Lifecycle<string>[]`, which widens away every status union — the one place in the
    contract where a typo would not be a compile error, against Principle I. Now a `as const`
    tuple with an `AnyLifecycle` union.
21. *Success criteria that restated their requirement.* Five (SC-003, SC-007, SC-011, SC-015,
    SC-017) were near-verbatim copies of an FR. Rewritten as observable outcomes. FR-029a and
    FR-055 now state their boundary — one governs what the local app emits, the other how the
    interface renders it. FR-009 and FR-039 are labelled explicitly as roll-ups, which is what
    they are.
22. *Two internal contradictions found while fixing the above.* The data model required every
    lifecycle to have a terminal state while also stating that the compression lifecycle has none
    (re-running is a declared transition); and a table row read "as above plus `interrupted`"
    where the row above already listed it. Both corrected.
23. *Story-independence claims that were not true.* User Story 2's T093 needs User Story 1's
    stream, and User Story 6's first six tasks need User Story 4's state writer. Both were
    disclosed in the dependency section but contradicted each story's own Independent Test.
    The Independent Tests now say so.

Task count after remediation: **257** (was 247). Coverage: **100%** of requirements have at
least one mapped task.

**Deliberate deviations from the template, with reasons:**

- *Seven user stories instead of the usual three.* The request spans six independent outcomes
  (state correctness, power, verification automation, interface truthfulness, security,
  performance, consistency). Each is independently developable, testable, and shippable, which
  is the template's own criterion for a separate story. Collapsing them would hide the priority
  ordering that makes this feature deliverable in slices.
- *71 functional requirements and 23 success criteria.* This is a hardening pass over an entire application rather than
  one capability; the count reflects surface area, not scope creep. They are grouped by theme so
  a reader can navigate them.
- *A `Dependencies` section was added.* Four requirements (FR-017, FR-028, and the platform half
  of Stories 1–3) cannot be met without external prerequisites — Windows CI minutes, an Apple
  Developer ID, a Windows code-signing certificate. Naming them up front prevents planning
  around work that is blocked on procurement.

**Zero clarifications requested.** The user explicitly delegated all decisions
("вирішуйте самі, мене можеш нічого не питати"). Every ambiguity was resolved as a documented
assumption instead, and each one is stated in the Assumptions section so it can be overridden
without re-reading the spec.

## Notes

- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`.
- All items pass. The spec is ready for `/speckit-plan`.
- Recommended next step is `/speckit-plan` rather than `/speckit-clarify`: the open questions are
  design questions (how to structure the transition tables, which verification aggregator shape,
  whether to split the context or move to a store), not requirement questions.
