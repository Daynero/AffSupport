#!/bin/zsh
# Source from a heavy standalone command. Outside the runner there is no
# admission socket and existing developer behaviour is unchanged. Inside a
# runner, partial configuration is an error rather than an implicit bypass.
release_require_admission() {
  [[ -z "${SOTY_RELEASE_ADMIT_SOCKET:-}" ]] && return 0
  [[ -n "${SOTY_RELEASE_ADMIT_MESSAGE:-}" ]] || {
    print -u2 'Release admission is configured without a request message.'
    return 1
  }
  [[ -n "${SOTY_RELEASE_CAPABILITY_FD:-}" ]] || {
    print -u2 'Release admission is configured without an inherited capability descriptor.'
    return 1
  }
  local reply
  reply=$(node scripts/release-admit.mjs "$SOTY_RELEASE_ADMIT_SOCKET" "$SOTY_RELEASE_ADMIT_MESSAGE") || return 1
  [[ "$reply" == *'"kind":"granted"'* ]] || {
    print -u2 "Release admission did not grant this heavy boundary: $reply"
    return 1
  }
}
