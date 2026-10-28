import {
  captureBetaDockerEnvironment,
  verifyOwnedBetaLoopbackStack
} from './beta-loopback-network.mjs';

/** @returns {never} */
const refuse = () => {
  throw new Error('BETA_RESET_STACK_UNSAFE');
};

/** Parse only the local CLI target, never infer project ownership from a default name. */
export function betaResetStackTarget(config, ownership, target) {
  const projects = [...config.matchAll(/^project_id\s*=\s*"([a-zA-Z0-9_-]{1,64})"\s*$/gm)];
  if (projects.length !== 1) refuse();
  const project = projects[0][1];
  const name = `soty-beta-${project}-loopback`;
  const sections = config.split(/^\[db\]\s*$/m);
  if (sections.length !== 2) refuse();
  const db = sections[1].split(/^\[/m)[0];
  const ports = [...db.matchAll(/^port\s*=\s*(\d+)\s*$/gm)];
  if (ports.length > 1) refuse();
  const databasePort = ports.length ? Number(ports[0][1]) : 54322;
  if (
    !Number.isInteger(databasePort) ||
    databasePort < 1 ||
    databasePort > 65535 ||
    ownership?.schemaVersion !== 1 ||
    ownership.stackStarted !== true ||
    ownership.phase !== 'running' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      ownership.ownerId ?? ''
    ) ||
    ownership.stackNetwork?.name !== name
  )
    refuse();
  let url;
  try {
    url = new URL(target);
  } catch {
    refuse();
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    // The owned bridge publishes IPv4 loopback. A different loopback address or
    // localhost resolution could reach another listener on the same port.
    url.hostname !== '127.0.0.1' ||
    Number(url.port || 5432) !== databasePort ||
    url.username !== 'postgres' ||
    url.pathname !== '/postgres' ||
    url.search ||
    url.hash
  )
    refuse();
  return { project, name, databasePort };
}

/**
 * The caller must not seed fixtures until this returns successfully. No volumes are removed.
 * @param {{
 *   config: string,
 *   ownership: any,
 *   target: string,
 *   run: (args: string[], options: {env: NodeJS.ProcessEnv}) => {status: number | null, error?: unknown},
 *   docker?: import('./beta-loopback-network.mjs').DockerRunner,
 *   env?: NodeJS.ProcessEnv,
 *   readConfig: () => string
 * }} options
 */
export function resetOwnedBetaStack({
  config,
  ownership,
  target,
  run,
  docker = undefined,
  env = process.env,
  readConfig
}) {
  const { project, name, databasePort } = betaResetStackTarget(config, ownership, target);
  if (typeof readConfig !== 'function') refuse();
  const bound = captureBetaDockerEnvironment(docker, env);
  const verify = () =>
    verifyOwnedBetaLoopbackStack(project, name, databasePort, bound.docker, bound.env);
  verify();
  // Config is a single-writer beta resource. Recheck its exact bytes at the
  // destructive boundary; concurrent external rewrites during CLI reads are unsupported.
  if (readConfig() !== config) refuse();
  const result = run(['supabase', 'db', 'reset', '--local', '--network-id', name], {
    env: bound.env
  });
  // Even an unsuccessful reset can have recreated the database container.
  try {
    if (readConfig() !== config) refuse();
    verify();
  } catch {
    // Preflight proved this is our stack. Default stop preserves its data and journal.
    const stopped = run(['supabase', 'stop', '--project-id', project], { env: bound.env });
    throw new Error(
      'BETA_LOOPBACK_BINDING_INVALID: ' +
        (stopped.status === 0 && !stopped.error
          ? 'owned reset stack stopped'
          : 'owned reset stack stop failed; run canonical beta:down') +
        '; fixtures were not seeded.'
    );
  }
  if (result.error || result.status !== 0) throw new Error('`supabase db reset` did not complete.');
}
