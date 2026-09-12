# Proposed constitution clarification — G0

**Status**: Amendment prepared in `.specify/memory/constitution.md` version 2.0.0 on 2026-09-09 under the maintainer's delegated authorization. Ordinary PR review/merge is not yet recorded. This document preserves the design rationale; the updated constitution contains the authoritative proposed wording.

## Reason

Current constitution requires matching release identity in stable.json before any package, and tag matching the deployed commit. The canonical production runbook instead creates immutable binaries first, then a signed manifest-only descendant commit for web deployment. Feature 020 must not implement altered gates while that contradiction remains active.

## Proposed normative replacements

Replace the release identity verification paragraph in Principle II with:

> Workspace release metadata MUST be generated from release.ts and match the candidate release identity. Before production packaging, candidate validation MUST verify candidate identity, protocol/tool contracts, production configuration, clean source and exact-SHA beta evidence, and independently validate the previous stable manifest as the currently trusted release. It MUST NOT manufacture future artifact digests or a future signed stable manifest. Before web deployment, final validation MUST require the new stable manifest to match release identity and verify its signature against the exact published artifact bytes. No deployment path may use candidate validation as a substitute for final validation.

Replace the tag/deployed-commit equality sentence in Development Workflow with:

> The immutable release tag MUST identify the commit packaged for both release platforms. A later web deployment commit MAY differ only by the signed stable manifest for those same published artifacts; it MUST descend from the release commit, have its own clean exact-SHA packaged-beta verification, and contain no other file changes for the automated full-release path. Both remote main and beta MUST match the expected manifest commit at final acceptance. Published binaries MUST NOT be rebuilt because of that manifest-only commit. Existing separately governed web-only releases retain their existing checks and are outside feature 020's full-release mode.

All other security, source-of-truth, private-key, shared-build and verification requirements remain mandatory. Changing contract maps still requires an agent release; final signed manifest must carry the new maps.

## Proposed Sync Impact Report

- Prepared version: 1.0.0 → 2.0.0. MAJOR because unconditional equality rules are redefined, rather than merely adding explanatory guidance.
- Changed sections: Principle II; Release & deploy gating in Development Workflow.
- Reason: make candidate and final verification phases explicit while retaining final integrity; reconcile canonical two-SHA procedure.
- Dependent documents: docs/PRODUCTION.md, docs/BETA.md, feature 020 spec/plan/tasks and gate tests.
- Ratification date: set only by the actual approved amendment, not by this proposal.

## Evidence required to close G0

A separate explicit constitution update following its current review/merge procedure. Record the ratified commit, final text and source version in validation/governance.md. T015–T016 and real affected gate integrations remain pending until then. T001 preparation is complete: the reviewable amendment now exists in the constitution. This does not mark review/merge complete or fabricate a ratified commit.
