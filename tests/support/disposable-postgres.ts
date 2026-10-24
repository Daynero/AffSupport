/** Only fresh test containers created by the canonical or acceptance runner. */
export function assertDisposablePostgresContainer(
  value: string | undefined
): asserts value is string {
  if (!/^(?:soty-test-db-|supabase_db_036_followup_)[a-f0-9]{16}$/u.test(value ?? '')) {
    throw new Error('DISPOSABLE_REQUIRED');
  }
}
