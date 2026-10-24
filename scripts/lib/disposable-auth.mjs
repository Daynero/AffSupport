/** Resource names are derived only from the disposable database owned by this runner.
 * @param {unknown} database
 */
export function disposableAuthNames(database) {
  if (typeof database !== 'string' || !/^soty-test-db-[a-f0-9]{16}$/u.test(database))
    throw Error('DISPOSABLE_AUTH_DATABASE_REQUIRED');
  const suffix = database.slice(-16);
  return {
    database,
    container: `soty-test-auth-${suffix}`,
    network: `soty-test-auth-net-${suffix}`
  };
}

/** Last-resort cleanup after a test crash. Preflight all ownership before deleting anything.
 * @param {unknown} database
 * @param {(args: string[]) => string} docker
 */
export function cleanupDisposableAuth(database, docker) {
  const names = disposableAuthNames(database);
  const owned = names.database;
  const containerExists =
    docker(['container', 'ls', '-aq', '--filter', `name=^/${names.container}$`]).trim() !== '';
  const networkExists =
    docker(['network', 'ls', '-q', '--filter', `name=^${names.network}$`]).trim() !== '';
  if (containerExists) {
    const labels = JSON.parse(
      docker(['container', 'inspect', '--format', '{{json .Config.Labels}}', names.container])
    );
    if (labels?.['soty.acceptance.database'] !== owned)
      throw Error('DISPOSABLE_AUTH_OWNER_MISMATCH');
  }
  let members = [];
  if (networkExists) {
    const labels = JSON.parse(
      docker(['network', 'inspect', '--format', '{{json .Labels}}', names.network])
    );
    if (labels?.['soty.acceptance.database'] !== owned)
      throw Error('DISPOSABLE_AUTH_OWNER_MISMATCH');
    const connections = JSON.parse(
      docker(['network', 'inspect', '--format', '{{json .Containers}}', names.network])
    );
    if (!connections || typeof connections !== 'object' || Array.isArray(connections))
      throw Error('DISPOSABLE_AUTH_NETWORK_INVALID');
    members = Object.values(connections).map(value => value?.Name);
    if (members.some(name => name !== owned && name !== names.container))
      throw Error('DISPOSABLE_AUTH_FOREIGN_NETWORK_MEMBER');
  }
  if (containerExists) docker(['rm', '--force', '--volumes', names.container]);
  if (networkExists) {
    if (members.includes(owned)) docker(['network', 'disconnect', names.network, owned]);
    docker(['network', 'rm', names.network]);
  }
  return { containerRemoved: containerExists, networkRemoved: networkExists };
}

/** Reconcile a lost Docker create/run response without trusting a process-local success flag.
 * @param {unknown} database
 * @param {(args: string[]) => string} docker
 */
export function cleanupDisposableDatabase(database, docker) {
  const { database: owned } = disposableAuthNames(database);
  if (!docker(['container', 'ls', '-aq', '--filter', `name=^/${owned}$`]).trim())
    return { removed: false };
  const labels = JSON.parse(
    docker(['container', 'inspect', '--format', '{{json .Config.Labels}}', owned])
  );
  if (labels?.['soty.acceptance.database'] !== owned)
    throw Error('DISPOSABLE_DATABASE_OWNER_MISMATCH');
  docker(['rm', '--force', '--volumes', owned]);
  return { removed: true };
}
