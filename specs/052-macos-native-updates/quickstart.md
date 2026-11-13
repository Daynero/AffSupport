# Validation guide

Native updater is not implemented yet. This guide validates trust foundation and defines later acceptance; it does not authorize production.

## Foundation now

Worktree `.claude/worktrees/macos-trusted-updates`, branch `feature/macos-trusted-updates`. Local signing config `~/Library/Application Support/Soty/signing/release-signing.env` is mode 0600, with public identity/profile references only. Profile name is not proof that notary credentials exist.

One heavy command at a time, nice 15, one test worker, measured headroom. Do not stop the owner's installed app or verification.

```sh
npm run verify
```

Fix and repeat affected gates only; partial shard report is not green. For signed-chain validation using configured identity:

```sh
source "$HOME/Library/Application Support/Soty/signing/release-signing.env"
SOTY_TEST_SIGNING_IDENTITY="$SOTY_SIGNING_IDENTITY" \
SOTY_TEST_NODE_BINARY=/Applications/Soty.app/Contents/Resources/runtime/node \
nice -n 15 node node_modules/vitest/vitest.mjs run tests/mac-signing-chain.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

Expected: real Node JS/WebAssembly under hardened runtime, negative control without JIT, per-binary identity/runtime/timestamp. Notary test remains skipped until valid profile and explicit `SOTY_TEST_EXPECT_NOTARIZED=1`. App/DMG/Gatekeeper acceptance follows [048 quickstart](../048-macos-apple-trust/quickstart.md); signed fixture is not clean Mac proof.

## Packaged native acceptance after implementation

1. Prepare isolated A/B with approved test signing/updater keys, real beta auth/entitlement and exact source/config/package proofs. Owned namespaces/feed only; installed stable/production version/assets/channel unchanged.
2. Prepare B without consent, then ordinary quit/crash/reboot: no installation. This blocks release if default Sparkle install-on-quit behavior leaks through.
3. Hosted/local UI: one consent, reversible drain, committed install, exact B-ready and separate result-visible. Menu/two tabs share attempt; closed web does not cancel.
4. Exercise active media/final writes/transfers/background claims/waiting attach/async preflight. No new work crosses barrier; accepted work settles, local queue survives, team ownership revalidated, unknown remote effects reconcile. Flush failure prevents replacement.
5. Defer before commitment, including after idle: admission resumes only for matching epoch. After commitment UI stops promising cancel. Stale release cannot affect another attempt.
6. Corrupt/wrong-signer/target/revoked/raced candidate, disk/rights/OS refusal fail safely. Verify second-download binding to signed descriptor, not just predownload SHA.
7. Inject crash/reboot before/after each durable receipt, replacement start/commit and target first launch. Reconcile before retry, no loop, no downgrade after target start/data mutation.
8. Repeat B→C. Record 20 successful samples with download/OS-consent/work separated, ARM runtime, honest Intel static/native qualification and Windows/legacy controls.
9. Use existing analytics CLI `--json`/pinned `--as-of` for control IDs: updates/inspect/investigate/journal/diagnose/audit/cohorts. Prove last stage, native/UI split, duplicate/reorder/missing/late signals and privacy. Missing stays unknown/insufficient.

Capability stays disabled until native acceptance, 031 coverage and 048 trust gates pass. Follow normal separately authorized production release process; none of these acceptance steps publishes production.
