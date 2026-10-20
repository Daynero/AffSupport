/** PostgreSQL bytea hex input contains exactly one leading backslash. */
export function recoveryDigest(hex: string): string {
  if (!/^[a-f0-9]{64}$/u.test(hex)) throw new Error('INVALID_INPUT');
  return '\\x' + hex;
}
export async function recoveryTokenHash(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  );
  return recoveryDigest(Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''));
}
