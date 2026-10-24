import { spawnSync } from 'node:child_process';

const BINDING = 'com.docker.network.bridge.host_binding_ipv4';
const LABEL = 'com.soty.beta.loopback';
const PROJECT = 'com.soty.beta.project';
/** @typedef {(args: string[]) => {status: number | null, stdout: unknown, error?: unknown}} DockerRunner */
/** @type {DockerRunner} */
const dockerDefault = args =>
  spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
    maxBuffer: 1024 * 1024
  });
const reject = () => {
  throw Error('BETA_LOOPBACK_NETWORK_REFUSED');
};
function projectName(project) {
  if (typeof project !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(project)) reject();
  return `soty-beta-${project}-loopback`;
}
function invoke(docker, args) {
  const result = docker(args);
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') reject();
  return result.stdout.trim();
}
function json(docker, args) {
  try {
    return JSON.parse(invoke(docker, args));
  } catch {
    return reject();
  }
}
export function localDockerEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.includes('\0')) return false;
  if (/^unix:\/\/\/.+/u.test(endpoint)) return true;
  if (/^npipe:\/{2,4}\.\/pipe\/[a-zA-Z0-9._-]+$/u.test(endpoint)) return true;
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === 'tcp:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
function assertLocalDaemon(docker, env) {
  if (env.DOCKER_HOST && !localDockerEndpoint(env.DOCKER_HOST)) reject();
  const context = invoke(docker, ['context', 'show']);
  if (!/^[a-zA-Z0-9._-]{1,128}$/u.test(context)) reject();
  const endpoint = json(docker, [
    'context',
    'inspect',
    context,
    '--format',
    '{{json .Endpoints.docker.Host}}'
  ]);
  if (!localDockerEndpoint(endpoint)) reject();
}
function containerIds(project, docker) {
  const output = invoke(docker, [
    'ps',
    '--all',
    '--filter',
    `label=com.supabase.cli.project=${project}`,
    '--format',
    '{{.ID}}'
  ]);
  const ids = output ? output.split(/\r?\n/u) : [];
  if (
    ids.length > 64 ||
    new Set(ids).size !== ids.length ||
    ids.some(id => !/^[a-f0-9]{12,64}$/u.test(id))
  )
    reject();
  return ids;
}
function validNetwork(value, project, name) {
  return (
    value?.Name === name &&
    value.Driver === 'bridge' &&
    value.Scope === 'local' &&
    value.Internal === false &&
    value.Ingress !== true &&
    value.EnableIPv6 === false &&
    value.Options?.[BINDING] === '127.0.0.1' &&
    value.Labels?.[LABEL] === 'v1' &&
    value.Labels?.[PROJECT] === project &&
    value.Containers &&
    typeof value.Containers === 'object' &&
    Object.keys(value.Containers).length === 0
  );
}
/**
 * Existing stacks are borrowed; the caller must reconcile its ownership record first.
 * @param {string} project
 * @param {DockerRunner} docker
 */
export function prepareBetaLoopbackNetwork(project, docker = dockerDefault, env = process.env) {
  const name = projectName(project);
  assertLocalDaemon(docker, env);
  if (containerIds(project, docker).length) reject();
  const found = invoke(docker, [
    'network',
    'ls',
    '--filter',
    `name=^${name}$`,
    '--format',
    '{{.Name}}'
  ]);
  if (found && found !== name) reject();
  const created = !found;
  if (created)
    invoke(docker, [
      'network',
      'create',
      '--driver',
      'bridge',
      '--opt',
      `${BINDING}=127.0.0.1`,
      '--label',
      `${LABEL}=v1`,
      '--label',
      `${PROJECT}=${project}`,
      name
    ]);
  const rows = json(docker, ['network', 'inspect', name]);
  if (!Array.isArray(rows) || rows.length !== 1 || !validNetwork(rows[0], project, name)) reject();
  return { name, created };
}
/**
 * Inspect effective bindings, not merely requested CLI flags or configuration.
 * @param {string} project
 * @param {string} name
 * @param {DockerRunner} docker
 */
export function verifyBetaLoopbackBindings(project, name, docker = dockerDefault) {
  if (name !== projectName(project)) reject();
  const ids = containerIds(project, docker);
  if (!ids.length) reject();
  let published = 0;
  for (const id of ids) {
    const settings = json(docker, ['inspect', '--format', '{{json .NetworkSettings}}', id]);
    if (
      !settings?.Networks ||
      Object.keys(settings.Networks).length !== 1 ||
      !Object.hasOwn(settings.Networks, name) ||
      !settings.Ports ||
      typeof settings.Ports !== 'object'
    )
      reject();
    for (const bindings of Object.values(settings.Ports)) {
      if (bindings === null) continue;
      if (!Array.isArray(bindings) || !bindings.length) reject();
      for (const binding of bindings) {
        if (
          !['127.0.0.1', '::1'].includes(binding.HostIp) ||
          !/^[0-9]{1,5}$/u.test(binding.HostPort) ||
          Number(binding.HostPort) < 1 ||
          Number(binding.HostPort) > 65535
        )
          reject();
        published++;
      }
    }
  }
  if (!published) reject();
  return { containers: ids.length, publishedBindings: published, loopbackOnly: true };
}
