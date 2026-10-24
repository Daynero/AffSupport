/** A scope hint learned only from the paired native app; it never grants authority. */
const KEY = 'soty.native-recovery-installation.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
let current: string | null = null;
export function rememberRecoveryInstallation(value: unknown): void {
  if (typeof value !== 'string' || !UUID.test(value)) return;
  current = value;
  try {
    localStorage.setItem(KEY, value);
  } catch {
    /* in-page hint remains usable */
  }
}
export function recoveryInstallation(): string | null {
  if (current) return current;
  try {
    const stored = localStorage.getItem(KEY);
    return stored && UUID.test(stored) ? stored : null;
  } catch {
    return null;
  }
}
