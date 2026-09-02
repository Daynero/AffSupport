/**
 * Reading a dotenv-style file, with no opinions and no side effects.
 *
 * Lives on its own because the beta doctor, which used to be the only place that could parse
 * one, *runs its whole check on import* — so anything that merely wanted the parser inherited
 * a port check and an `exit(1)`.
 */

/** Parses a dotenv-style file into a plain object. Values are not expanded. */
export function parseEnvFile(contents) {
  const result = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    result[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return result;
}
