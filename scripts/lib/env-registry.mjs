import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The registry, and the arithmetic that keeps it honest.
 *
 * Everything here is a pure function over strings. The gates that own the file
 * system and the network call in; the comparisons themselves can be tested
 * without either, which is the only reason this logic is trustworthy — a parity
 * check nobody can test is a parity check nobody believes.
 */

const REGISTRY_PATH = 'config/environments.json';

/**
 * @typedef {{
 *   name: string,
 *   surface: string,
 *   required: string[],
 *   secret?: boolean,
 *   provided?: string,
 *   format?: string,
 *   note?: string
 * }} RegistryVariable
 *
 * @typedef {{
 *   surfaces: Record<string, {scan: {roots: string[], exclude?: string[], pattern: string}}>,
 *   variables: RegistryVariable[]
 * }} Registry
 */

/** Deliberately not `VITE_[A-Z0-9_]+`: that also matches the tail of `INVITE_TTL_DAYS`. */
const VITE_USAGE = /(?<![A-Z0-9_])VITE_[A-Z0-9_]+/gu;
const DENO_USAGE = /Deno\.env\.get\(\s*['"]([A-Z][A-Z0-9_]*)['"]/gu;
const ENV_FILE_KEY = /^([A-Z][A-Z0-9_]*)=/u;

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs']);

/** @returns {Registry} */
export function loadRegistry(root = process.cwd()) {
  const registry = JSON.parse(readFileSync(path.join(root, REGISTRY_PATH), 'utf8'));
  assertRegistryShape(registry);
  return registry;
}

/**
 * A malformed registry must fail loudly here rather than quietly narrow a gate.
 * A surface with no variables, or a variable claiming an unknown surface, would
 * otherwise read as "nothing to check" and pass.
 */
/**
 * @param {any} registry
 * @returns {Registry}
 */
export function assertRegistryShape(registry) {
  const surfaces = Object.keys(registry?.surfaces ?? {});
  if (!surfaces.length) throw new Error('ENV_REGISTRY_INVALID: no surfaces declared');
  if (!Array.isArray(registry.variables) || !registry.variables.length)
    throw new Error('ENV_REGISTRY_INVALID: no variables declared');
  const seen = new Set();
  for (const variable of registry.variables) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(variable?.name ?? ''))
      throw new Error(`ENV_REGISTRY_INVALID: bad variable name ${String(variable?.name)}`);
    if (!surfaces.includes(variable.surface))
      throw new Error(
        `ENV_REGISTRY_INVALID: ${variable.name} names unknown surface ${variable.surface}`
      );
    if (!Array.isArray(variable.required))
      throw new Error(`ENV_REGISTRY_INVALID: ${variable.name} has no required list`);
    // The same name legitimately exists on two surfaces — DRIVE_OAUTH_MODE is
    // both a function secret and packaged agent configuration — so identity is
    // the pair, and only a true duplicate is an error.
    const key = `${variable.surface}:${variable.name}`;
    if (seen.has(key)) throw new Error(`ENV_REGISTRY_INVALID: ${key} declared twice`);
    seen.add(key);
  }
  return registry;
}

/**
 * @param {Registry} registry
 * @param {string} surface
 * @returns {RegistryVariable[]}
 */
export function variablesFor(registry, surface) {
  return registry.variables.filter(variable => variable.surface === surface);
}

/**
 * The names a surface must have a value for in the given environment.
 * Platform-provided names are excluded: Supabase injects those, and demanding
 * them would fail a perfectly configured project.
 */
/**
 * @param {Registry} registry
 * @param {string} surface
 * @param {string} environment
 * @returns {string[]}
 */
export function requiredNames(registry, surface, environment) {
  return variablesFor(registry, surface)
    .filter(variable => variable.provided !== 'platform')
    .filter(variable => variable.required.includes(environment))
    .map(variable => variable.name);
}

export function scanUsage(pattern, text) {
  const names = new Set();
  if (pattern === 'vite') for (const match of text.matchAll(VITE_USAGE)) names.add(match[0]);
  else if (pattern === 'deno') for (const match of text.matchAll(DENO_USAGE)) names.add(match[1]);
  else if (pattern === 'envfile')
    for (const line of text.split(/\r?\n/)) {
      const match = ENV_FILE_KEY.exec(line.trim());
      if (match) names.add(match[1]);
    }
  else throw new Error(`ENV_REGISTRY_INVALID: unknown scan pattern ${pattern}`);
  return names;
}

/** Every source file under a declared root, minus the declared exclusions. */
export function sourceFiles(root, surface) {
  const excluded = new Set((surface.scan.exclude ?? []).map(entry => path.join(root, entry)));
  const found = [];
  const visit = target => {
    if (excluded.has(target)) return;
    const stats = statSync(target, { throwIfNoEntry: false });
    if (!stats) return;
    if (stats.isDirectory())
      for (const entry of readdirSync(target)) visit(path.join(target, entry));
    else if (surface.scan.pattern === 'envfile' || SOURCE_EXTENSIONS.has(path.extname(target)))
      found.push(target);
  };
  for (const entry of surface.scan.roots) visit(path.join(root, entry));
  return found;
}

export function scanSurface(root, surface) {
  const names = new Set();
  for (const file of sourceFiles(root, surface))
    for (const name of scanUsage(surface.scan.pattern, readFileSync(file, 'utf8'))) names.add(name);
  return names;
}

/**
 * The two directions, and why both are errors.
 *
 * `unregistered` is the failure that took production down: a variable the code
 * reads that no gate knows to check, so the first thing to notice it is a user.
 * `unused` is the slower one — a name kept alive in documents and check-lists
 * long after the code stopped reading it, which is how a registry becomes
 * folklore. Neither is a warning.
 */
export function compareSurface({ registered, used }) {
  const declared = new Set(registered);
  return {
    unregistered: [...used].filter(name => !declared.has(name)).sort(),
    unused: [...declared].filter(name => !used.has(name)).sort()
  };
}

const FORMATS = {
  any: () => null,
  'non-empty': value => (value.trim() ? null : 'is empty'),
  url: value => {
    try {
      new URL(value);
      return null;
    } catch {
      return 'is not a URL';
    }
  },
  'https-origin': value => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') return 'is not an https origin';
      return url.pathname === '/' && !url.search && !url.hash
        ? null
        : 'is an https URL, not an origin';
    } catch {
      return 'is not a URL';
    }
  },
  boolean: value => (['true', 'false'].includes(value.trim()) ? null : 'is not true or false'),
  integer: value => (/^\d+$/u.test(value.trim()) ? null : 'is not an integer'),
  digits: value => (/^\d+$/u.test(value.trim()) ? null : 'is not a number'),
  base64: value => (/^[A-Za-z0-9+/=]+$/u.test(value.trim()) ? null : 'is not base64'),
  'google-browser-key': value =>
    /^AIza[0-9A-Za-z_-]{20,}$/u.test(value.trim())
      ? null
      : 'does not look like a Google browser key'
};

/**
 * @returns {string|null} why the value is wrong, or null when it is acceptable.
 */
export function checkFormat(format, value) {
  if (format?.startsWith('enum:')) {
    const allowed = format.slice('enum:'.length).split('|');
    return allowed.includes(value.trim()) ? null : `must be one of ${allowed.join(', ')}`;
  }
  const check = FORMATS[format ?? 'any'];
  if (!check) throw new Error(`ENV_REGISTRY_INVALID: unknown format ${format}`);
  return check(value);
}

/**
 * Which declared variables a set of resolved values fails, for one environment.
 * Absent optional values are not checked: an unset switch has no shape to be
 * wrong about.
 */
/**
 * @param {Registry} registry
 * @param {string} surface
 * @param {string} environment
 * @param {Record<string, string|undefined>} values
 * @returns {{name: string, problem: string, note?: string}[]}
 */
export function validateValues(registry, surface, environment, values) {
  /** @type {{name: string, problem: string, note?: string}[]} */
  const problems = [];
  for (const variable of variablesFor(registry, surface)) {
    if (variable.provided === 'platform') continue;
    const raw = values[variable.name];
    const present = typeof raw === 'string' && raw.trim() !== '';
    if (!present) {
      if (variable.required.includes(environment))
        problems.push({ name: variable.name, problem: 'is missing', note: variable.note });
      continue;
    }
    const wrong = checkFormat(variable.format, raw);
    if (wrong) problems.push({ name: variable.name, problem: wrong, note: variable.note });
  }
  return problems;
}
