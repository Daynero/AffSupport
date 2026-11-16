#!/bin/zsh
# next:quick:app with the release machine's environment: the runner's local inputs
# (release/automation/release-runner.env, untracked), the Developer ID references
# (no secrets; keys stay in the Keychain) and the committed production origins.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
[[ -f release/automation/release-runner.env ]] && . release/automation/release-runner.env
. "$HOME/Library/Application Support/Soty/signing/release-signing.env"
. config/production.env
set +a
# The runner's TMPDIR points at the external release volume; a worktree there cannot
# clone dependencies copy-on-write. Keep this one on the internal disk.
export TMPDIR="${NEXT_QUICK_TMPDIR:-/private/tmp/soty-next-quick}"
mkdir -p "$TMPDIR"
exec node scripts/next-quick-app.mjs "$@"
