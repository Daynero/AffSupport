const PEM = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu;
const TOKEN = /\b(?:ghp|github_pat|sk|sbp|eyJ)[A-Za-z0-9_.=-]{12,}\b/gu;
const LONG_SECRET = /\b[A-Za-z0-9+/_=-]{48,}\b/gu;

export function redactText(text) {
  return String(text).replace(PEM, '[REDACTED_PEM]').replace(TOKEN, '[REDACTED_TOKEN]').replace(LONG_SECRET, '[REDACTED_SECRET]');
}

/** Keeps a conservative overlap so a token split across child-process chunks is masked. */
export function createRedactor({ carryLength = 256 } = {}) {
  let carry = '';
  return {
    write(chunk) {
      const value = carry + String(chunk);
      if (value.length <= carryLength) {
        carry = value;
        return '';
      }
      const safe = value.slice(0, -carryLength);
      carry = value.slice(-carryLength);
      return redactText(safe);
    },
    end() {
      const output = redactText(carry);
      carry = '';
      return output;
    }
  };
}
