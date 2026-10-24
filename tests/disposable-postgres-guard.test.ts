import { expect, it } from 'vitest';
import { assertDisposablePostgresContainer } from './support/disposable-postgres';
it.each(['soty-test-db-0123456789abcdef', 'supabase_db_036_followup_0123456789abcdef'])(
  'accepts a controlled temporary container %s',
  value => {
    expect(() => assertDisposablePostgresContainer(value)).not.toThrow();
  }
);
it.each([
  undefined,
  '',
  'supabase_db_acceptance036',
  'supabase_db_affsupport037',
  'supabase_db_wishly13',
  'soty-test-db-x',
  'soty-test-db-0123456789abcdef-extra',
  'soty-test-db-0123456789abcdef\n',
  'postgresql://localhost/postgres'
])('refuses a non-disposable or ambiguous target %s', value => {
  expect(() => assertDisposablePostgresContainer(value)).toThrow('DISPOSABLE_REQUIRED');
});
