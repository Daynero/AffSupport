import { expect, it, vi } from 'vitest';
import {
  cleanupDisposableAuth,
  cleanupDisposableDatabase,
  disposableAuthNames
} from '../scripts/lib/disposable-auth.mjs';
const db = 'soty-test-db-0123456789abcdef';
const names = disposableAuthNames(db);
function fixture(
  options: { absent?: boolean; foreignOwner?: boolean; foreignMember?: boolean } = {}
) {
  const docker = vi.fn((args: string[]) => {
    if (args.includes('ls')) return options.absent ? '' : 'owned-resource-id';
    if (args.includes('inspect')) {
      if (args.includes('{{json .Containers}}'))
        return JSON.stringify({
          a: { Name: db },
          b: { Name: options.foreignMember ? 'foreign-workload' : names.container }
        });
      return JSON.stringify({
        'soty.acceptance.database': options.foreignOwner ? 'other-database' : db
      });
    }
    return '';
  });
  return docker;
}
it.each(['supabase_db_acceptance036', 'soty-test-db-invalid', '', null])(
  'refuses borrowed or malformed database %s before Docker',
  value => {
    const docker = fixture();
    expect(() => cleanupDisposableAuth(value, docker)).toThrow('DISPOSABLE_AUTH_DATABASE_REQUIRED');
    expect(docker).not.toHaveBeenCalled();
  }
);
it('removes only label-bound Auth and disconnects only its owned database', () => {
  const docker = fixture();
  expect(cleanupDisposableAuth(db, docker)).toEqual({
    containerRemoved: true,
    networkRemoved: true
  });
  expect(docker.mock.calls.slice(-3).map(([args]) => args)).toEqual([
    ['rm', '--force', '--volumes', names.container],
    ['network', 'disconnect', names.network, db],
    ['network', 'rm', names.network]
  ]);
});
it('is a no-op after normal test teardown', () => {
  const docker = fixture({ absent: true });
  expect(cleanupDisposableAuth(db, docker)).toEqual({
    containerRemoved: false,
    networkRemoved: false
  });
  expect(docker).toHaveBeenCalledTimes(2);
});
it.each([{ foreignOwner: true }, { foreignMember: true }])(
  'refuses foreign ownership before the first mutation: %s',
  options => {
    const docker = fixture(options);
    expect(() => cleanupDisposableAuth(db, docker)).toThrow(
      /DISPOSABLE_AUTH_(OWNER_MISMATCH|FOREIGN_NETWORK_MEMBER)/
    );
    expect(
      docker.mock.calls.some(([args]) => args.includes('rm') || args.includes('disconnect'))
    ).toBe(false);
  }
);
it('reports Docker inspection failure instead of claiming that resources are absent', () => {
  const docker = vi.fn(() => {
    throw Error('DOCKER_UNAVAILABLE');
  });
  expect(() => cleanupDisposableAuth(db, docker)).toThrow('DOCKER_UNAVAILABLE');
  expect(docker).toHaveBeenCalledTimes(1);
});

it('reconciles an owned database created before a lost Docker reply', () => {
  const docker = fixture();
  expect(cleanupDisposableDatabase(db, docker)).toEqual({ removed: true });
  expect(docker.mock.calls.at(-1)?.[0]).toEqual(['rm', '--force', '--volumes', db]);
});
it('does not delete an existing database with another owner label', () => {
  const docker = fixture({ foreignOwner: true });
  expect(() => cleanupDisposableDatabase(db, docker)).toThrow('DISPOSABLE_DATABASE_OWNER_MISMATCH');
  expect(docker.mock.calls.some(([args]) => args.includes('rm'))).toBe(false);
});
it('allows a failed creation with no database and refuses the actual source database', () => {
  const docker = fixture({ absent: true });
  expect(cleanupDisposableDatabase(db, docker)).toEqual({ removed: false });
  expect(() => cleanupDisposableDatabase('supabase_db_acceptance036', docker)).toThrow(
    'DISPOSABLE_AUTH_DATABASE_REQUIRED'
  );
  expect(docker).toHaveBeenCalledTimes(1);
});
