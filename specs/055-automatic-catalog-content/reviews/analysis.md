# Analysis and remediation

2026-11-13, before implementation. Spec Kit analyze is read-only; the owner explicitly requested repeated analysis/fix passes, so fixes were applied as a separate authorized planning step.

Pass1: clarified frozen legacy inputs versus new server admission, unsupported factual attributes, exact source ownership and bounded updater history. Requirements checklist8/8complete.

Pass2: reviewed all19FR/SCrequirements against25tasks with three independent research reviewers. A1HIGH: updater recipe restore ordering/base binding/uncertainty. A2HIGH: per-attempt count semantics and admission versus freeze proof. A3MEDIUM: mutable image metadata in source hashes. A4MEDIUM: legacy image fallback after settings removal. A5MEDIUM: broad catalog evidence search misused for exact inspection. All corrections are now explicit in contracts/content.md and referenced by plan.md.

Recheck:19/19requirements mapped,25unique task IDs, no unmapped tasks, no unresolved clarification markers, no remaining critical/high findings, no constitution deviation. Implementation may proceed. This planning result does not certify runtime implementation or release readiness.

Implementation pass3: reviewed INSERT-only policy ownership, legacy source hash preservation, parent-before-child locks, immutable updater base/lease/round binding, bounded recipe retention and receipt privacy. Added an explicit missing-catalog guard and nullable lease checks. Verified that native growth planning restores its existing durable recipe before creating new assignments. Blank additional unsupported style, gender and shipping attributes. Focused tests exposed and corrected the shared static diagnostic wording and test-role setup described in validation.md. Release-level checks remain separate.

Integration pass 4: the first complete-suite shard caught checkpoint fixture replacement, SELECT-only diagnostic helper ACLs and seven rejected Launch error codes. Fixed the fixtures without weakening production guards, added the forward-only closed-vocabulary migration, and corrected a stale code-map path. All 148 affected checks pass; remaining full-suite and migration-chain evidence is tracked separately.
